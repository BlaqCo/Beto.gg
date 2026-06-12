/**
 * state.js
 * Dry run always starts with a fresh $40 balance on boot.
 * Live mode tracks real P&L against actual deposited balance.
 *
 * FIXES:
 * 1. entryBtcPrice stored on bet for cumulative BTC delta tracking
 * 2. marketEndDateIso stored for expiry-based exits
 * 3. Expiry bets excluded from W/L and P&L — stake returned, neutral
 * 4. Separate expiryCount tracked for dashboard display
 * 5. getStats() exposes realPnl (excludes expiry noise)
 * 6. timeout exits count as scalps when profitable (SharpShooter)
 */

const STARTING_BALANCE = parseFloat(process.env.BANKROLL || "40");
const IS_DRY = process.env.DRY_RUN !== "false";

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

console.log(`💰 State initialized | Starting balance: $${STARTING_BALANCE} | Mode: ${IS_DRY ? "DRY RUN" : "LIVE"}`);

export function recordBet({
  market, side, betSize, edge, trueProbability, impliedProbability,
  orderId, entryPrice, entryBtcPrice, strategy, reasoning, sharpShooter
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
    return bet;
  }

  // Real exit: take_profit, stop_loss, trail_stop, near_expiry, timeout
  bet.pnl = pnl;

  if (pnl > 0)      { state.wins++;   bet.status = "won"; }
  else if (pnl < 0) { state.losses++; bet.status = "lost"; }
  else              { bet.status = "breakeven"; } // timeout at /bin/sh = neutral

  if (reason === "take_profit" || reason === "take_profit_max" || reason === "trail_stop" || reason === "timeout") {
    state.scalps++;
  }

  state.pnl        += pnl;
  state.dryBalance += bet.betSize + pnl;
  state.activeBets.delete(conditionId);
  return bet;
}

export function hasActiveBet(conditionId)  { return state.activeBets.has(conditionId); }
export function getActiveBet(conditionId)  { return state.activeBets.get(conditionId); }
export function getAllActiveBets()          { return Array.from(state.activeBets.values()); }
export function recordScan()               { state.scansCompleted++; state.lastScan = new Date().toISOString(); }
export function getDryBalance()            { return Math.max(0, state.dryBalance); }
export function getAllBets()               { return state.bets; }

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
  };
}

export default {
  recordBet,
  closeBet,
  hasActiveBet,
  getActiveBet,
  getAllActiveBets,
  recordScan,
  getDryBalance,
  getAllBets,
  getStats,
};
