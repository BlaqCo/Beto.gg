/**
 * state.js
 * Dry run starts with a fresh balance on boot ONLY if RESET_ON_BOOT=true.
 * Live mode tracks real P&L against actual deposited balance.
 *
 * PERSISTENCE: Upstash Redis (REST API), NOT a local file.
 * ────────────────────────────────────────────────────────────────
 * Railway's container filesystem is wiped on every full redeploy (and
 * sometimes on plain restarts depending on plan/config). A local JSON
 * file looked like it persisted but kept getting silently wiped, which
 * caused two separate real-money bugs:
 *   1. Duplicate entries into markets the bot already held (state forgot
 *      it had already bought in, so it bought again — sometimes 3-4x).
 *   2. Dashboard showing 0 bets / 0 W-L / flat P&L graph after every
 *      restart, even though real history existed.
 *
 * Fix: state now lives in Upstash Redis, reached over plain HTTPS via
 * its REST API — completely outside Railway's container filesystem, so
 * it survives every redeploy, restart, or crash, no volume needed.
 *
 * Env required:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 * (both from the Upstash dashboard → your database → REST API section)
 *
 * If those env vars are missing, this module falls back to in-memory
 * only (same as before persistence existed) and logs a warning — the
 * bot still runs, it just won't survive a restart until Redis is wired.
 *
 * SYNC API PRESERVED: bot-sports.js and index.js call hasActiveBet(),
 * getAllActiveBets(), etc. synchronously inline in loops. To avoid
 * rewriting every call site to async/await, all reads/writes operate on
 * an in-memory mirror (the `state` object) which is the source of truth
 * for every synchronous call. Redis is written to (fire-and-forget) after
 * every mutation, and read from once at boot to restore that mirror.
 *
 * FIXES (existing):
 * 1. entryBtcPrice stored on bet for cumulative BTC delta tracking
 * 2. marketEndDateIso stored for expiry-based exits
 * 3. Expiry bets excluded from W/L and P&L — stake returned, neutral
 * 4. Separate expiryCount tracked for dashboard display
 * 5. getStats() exposes realPnl (excludes expiry noise)
 * 6. timeout exits count as scalps when profitable (SharpShooter)
 * 7. countBetsForMarket() — hard cap on repeat entries into one market
 */

const STARTING_BALANCE = parseFloat(process.env.BANKROLL || "40");
const IS_DRY = process.env.DRY_RUN !== "false";
const RESET_ON_BOOT = process.env.RESET_ON_BOOT === "true";

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY   = "polybettor:state";
const REDIS_ENABLED = !!(REDIS_URL && REDIS_TOKEN);

const state = {
  bets: [],
  pnl: 0,
  totalWagered: 0,
  wins: 0,
  losses: 0,
  expiryCount: 0,
  scalps: 0,
  scansCompleted: 0,
  startedAt: new Date().toISOString(),
  lastScan: null,
  activeBets: new Map(),
  dryBalance: STARTING_BALANCE,
};

// ── Redis REST helpers ───────────────────────────────────────────
async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Redis GET ${res.status}`);
  const data = await res.json();
  return data?.result ?? null; // null if key doesn't exist
}

async function redisSet(key, value) {
  const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body: JSON.stringify(value), // Upstash expects the raw value as the body
  });
  if (!res.ok) throw new Error(`Redis SET ${res.status}`);
  return true;
}

// ── Persistence ───────────────────────────────────────────────
function snapshot() {
  return {
    bets:           state.bets,
    pnl:            state.pnl,
    totalWagered:   state.totalWagered,
    wins:           state.wins,
    losses:         state.losses,
    expiryCount:    state.expiryCount,
    scalps:         state.scalps,
    scansCompleted: state.scansCompleted,
    dryBalance:     state.dryBalance,
  };
}

let _saveInFlight = false;
let _savePending = false;
async function saveState() {
  if (!REDIS_ENABLED) return;
  // Coalesce rapid back-to-back saves (e.g. multiple bets closing in one
  // scan cycle) into a single in-flight request rather than racing writes.
  if (_saveInFlight) { _savePending = true; return; }
  _saveInFlight = true;
  try {
    await redisSet(REDIS_KEY, JSON.stringify(snapshot()));
  } catch (err) {
    console.error("⚠️ Failed to persist state to Redis:", err.message);
  } finally {
    _saveInFlight = false;
    if (_savePending) { _savePending = false; saveState(); }
  }
}

async function loadState() {
  if (!REDIS_ENABLED) return false;
  try {
    const raw = await redisGet(REDIS_KEY);
    if (!raw) return false;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;

    state.bets           = Array.isArray(data.bets) ? data.bets : [];
    state.pnl            = data.pnl || 0;
    state.totalWagered    = data.totalWagered || 0;
    state.wins           = data.wins || 0;
    state.losses         = data.losses || 0;
    state.expiryCount    = data.expiryCount || 0;
    state.scalps         = data.scalps || 0;
    state.scansCompleted = data.scansCompleted || 0;
    state.dryBalance     = data.dryBalance != null ? data.dryBalance : STARTING_BALANCE;

    // Rebuild activeBets map from any bets still marked "open"
    state.activeBets = new Map();
    for (const bet of state.bets) {
      if (bet.status === "open") {
        state.activeBets.set(bet.marketConditionId, bet);
      }
    }
    return true;
  } catch (err) {
    console.error("⚠️ Failed to load persisted state from Redis:", err.message);
    return false;
  }
}

function getDryBalanceUnsafe() { return Math.max(0, state.dryBalance); }

// ── Boot sequence ─────────────────────────────────────────────
// Exported so index.js can await this before the scan loops start,
// guaranteeing state is restored before any entry/exit decision runs.
export const ready = (async () => {
  if (!REDIS_ENABLED) {
    console.error("⚠️ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — state will NOT survive restarts. Set both in Railway Variables.");
    console.log(`💰 State initialized (in-memory only) | Starting balance: $${STARTING_BALANCE} | Mode: ${IS_DRY ? "DRY RUN" : "LIVE"}`);
    return;
  }

  let restored = false;
  if (!RESET_ON_BOOT) {
    restored = await loadState();
  }

  if (restored) {
    console.log(`💰 State restored from Redis | Balance: $${getDryBalanceUnsafe().toFixed(2)} | Active: ${state.activeBets.size} | Total bets: ${state.bets.length} | Mode: ${IS_DRY ? "DRY RUN" : "LIVE"}`);
  } else {
    console.log(`💰 State initialized | Starting balance: $${STARTING_BALANCE} | Mode: ${IS_DRY ? "DRY RUN" : "LIVE"}${RESET_ON_BOOT ? " | RESET_ON_BOOT" : ""}`);
    await saveState(); // write a fresh snapshot immediately
  }
})();

// ── Public API ───────────────────────────────────────────────────
export function recordBet({
  market, side, betSize, edge, trueProbability, impliedProbability,
  orderId, entryPrice, entryBtcPrice, strategy, reasoning, sharpShooter,
  entryCoin
}) {
  const bet = {
    id: `bet_${Date.now()}`,
    orderId,
    marketConditionId: market.conditionId || market.condition_id,
    marketQuestion:    market.question,
    marketEndDateIso:  market.endDateIso || market.endDate || null,
    side,
    betSize,
    edge,
    trueProbability,
    impliedProbability,
    entryPrice:    entryPrice || impliedProbability,
    entryBtcPrice: entryBtcPrice || null,
    entryCoin:     entryCoin  || null,
    strategy:      strategy    || "UNKNOWN",
    reasoning:     reasoning   || "",
    sharpShooter:  sharpShooter || false,
    placedAt: new Date().toISOString(),
    status: "open",
    pnl: null,
    exitReason: null,
    exitPrice: null,
  };

  state.bets.push(bet);
  state.totalWagered += betSize;
  state.dryBalance   -= betSize;
  state.activeBets.set(bet.marketConditionId, bet);
  saveState(); // fire-and-forget — sync callers don't wait on this
  return bet;
}

export function closeBet(conditionId, { exitPrice, reason, pnl }) {
  const bet = state.activeBets.get(conditionId);
  if (!bet) return null;

  bet.exitPrice  = exitPrice;
  bet.exitReason = reason;
  bet.closedAt   = new Date().toISOString();

  // EXPIRY: neutral — stake returned, excluded from W/L and P&L
  if (reason === "expiry") {
    bet.status = "expired";
    bet.pnl    = 0;
    state.expiryCount++;
    state.dryBalance += bet.betSize; // return stake only
    state.activeBets.delete(conditionId);
    saveState();
    return bet;
  }

  // Real exit: take_profit, stop_loss, trail_stop, near_expiry, timeout
  bet.pnl = pnl;

  if (pnl > 0)      { state.wins++;   bet.status = "won"; }
  else if (pnl < 0) { state.losses++; bet.status = "lost"; }
  else              { bet.status = "breakeven"; }

  if (reason === "take_profit" || reason === "take_profit_max" || reason === "trail_stop" || reason === "timeout") {
    state.scalps++;
  }

  state.pnl        += pnl;
  state.dryBalance += bet.betSize + pnl;
  state.activeBets.delete(conditionId);
  saveState();
  return bet;
}

export function hasActiveBet(conditionId)  { return state.activeBets.has(conditionId); }
export function getActiveBet(conditionId)  { return state.activeBets.get(conditionId); }
export function getAllActiveBets()          { return Array.from(state.activeBets.values()); }
export function countBetsForMarket(conditionId) {
  return state.bets.filter(b => b.marketConditionId === conditionId).length;
}
export function recordScan()               { state.scansCompleted++; state.lastScan = new Date().toISOString(); }
export function getDryBalance()            { return Math.max(0, state.dryBalance); }
export function getAllBets()               { return state.bets; }
export function isPersistenceEnabled()     { return REDIS_ENABLED; }

export function getStats() {
  const total = state.wins + state.losses;
  return {
    uptime:          state.startedAt,
    lastScan:        state.lastScan,
    scansCompleted:  state.scansCompleted,
    betsPlaced:      state.bets.length,
    activeBets:      state.activeBets.size,
    totalWagered:    state.totalWagered.toFixed(2),
    pnl:             state.pnl.toFixed(2),
    wins:            state.wins,
    losses:          state.losses,
    expiryCount:     state.expiryCount,
    scalps:          state.scalps,
    winRate:         total > 0 ? ((state.wins / total) * 100).toFixed(1) + "%" : "N/A",
    startingBalance: STARTING_BALANCE,
    currentBalance:  Math.max(0, STARTING_BALANCE + state.pnl).toFixed(2),
    dryBalance:      getDryBalance().toFixed(2),
    persistenceEnabled: REDIS_ENABLED,
  };
}

export default {
  ready,
  recordBet,
  closeBet,
  hasActiveBet,
  getActiveBet,
  getAllActiveBets,
  countBetsForMarket,
  recordScan,
  getDryBalance,
  getAllBets,
  getStats,
  isPersistenceEnabled,
};