/**
 * bot-sports.js — PolyBettor Sports v4 (polymarket.us native)
 *
 * Data + execution via official polymarket-us SDK.
 * Strategy: BUY YES on LIVE (in-progress) moneyline favorites only (ask 52-95¢),
 *           flat $10 bets, HOLD TO RESOLUTION — no TP/SL, no early exits.
 * DRY:  paper fills at ask, settlement booked when market resolves.
 * LIVE: FOK limit entries, settlement booked when market resolves.
 * Only touches its own bets (strategy === "SPORTS_ML").
 */

import { recordBet, hasActiveBet, getStats, getAllActiveBets,
         closeBet, getDryBalance, countBetsForMarket } from "./state.js";
import { fetchSportsMoneylines, verifyCandidates, getBBO, getSettlement,
         buyYesFOK, getBuyingPower, getOpenPositions,
         preflightUS } from "./polymarket-us.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ──────────────────────────────────────────────────────
const BET_SIZE      = 5;       // flat $5 per bet (testing)
const BET_MIN       = 5;
const FAV_MIN       = 0.60;    // wait for the favorite to climb to 60¢ before entering
const FAV_MAX       = 0.70;    // skip heavy favorites/near-decided games
const FEE           = 0.02;    // fee estimate on winning payout (bookkeeping)
const MAX_CONC      = 5;
const ENTRIES_SCAN  = 2;
const MAX_ENTRIES_PER_MARKET = 2; // hard cap — never enter the same market more than this, ever
// book quality: require two-sided quotes, spread ≤ 6¢ (checked at entry)
// HOLD-TO-CLOSE: no TP/SL. Positions are only closed by market settlement.

// ── Circuit breaker: session loss limit ──────────────────────────
// If realized P&L for this boot session drops below -LOSS_LIMIT, the bot
// stops placing NEW entries (existing open positions still hold to close
// and still settle normally — this only blocks fresh risk). Resets when
// the process restarts. Override via env var if you want a different cap.
const SESSION_LOSS_LIMIT = parseFloat(process.env.SESSION_LOSS_LIMIT || "100"); // dollars
let _sessionStartPnl = null; // captured on first scan of this boot

// ── Helpers ─────────────────────────────────────────────────────
const shares = b => b.betSize / b.entryPrice;
const expiryPnl = (b, won) => won ? shares(b) * (1 - FEE) - b.betSize : -b.betSize;
const exitPnl = (b, px) => shares(b) * px - b.betSize;
const pct = x => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const cents = x => `${(x * 100).toFixed(0)}¢`;

// ── Live preflight (once; 60s backoff on failure) ───────────────
let _preflightDone = false;
let _preflightNextTry = 0;
async function ensureLiveReady() {
  if (DRY_RUN || _preflightDone) return true;
  if (Date.now() < _preflightNextTry) return false; // quiet backoff, no spam
  const check = await preflightUS();
  check.messages.forEach(m => console.log(m));
  if (!check.ok) {
    _preflightNextTry = Date.now() + 60_000;
    console.error("❌ LIVE preflight failed — retrying in 60s");
    return false;
  }
  _preflightDone = true;
  return true;
}

// ── Live mark-to-market cache (read by index.js /bets) ──────────
const liveMarks = new Map(); // slug → { price, pnl, movePct, ts }
export function getSportsMarks() { return liveMarks; }

// ── Exits: settlement-only, hold to close ───────────────────────
async function processExits() {
  const exits = [];
  const mine = getAllActiveBets().filter(b => b.strategy === "SPORTS_ML");

  for (const bet of mine) {
    const slug = bet.marketConditionId;

    // 1) Settled? (game over, market resolved) — the ONLY exit path.
    const settle = await getSettlement(slug);
    if (settle !== null) {
      const won = settle === 1;
      const pnl = expiryPnl(bet, won);
      console.log(`  🏁 SETTLE ${won ? "🟢 WIN" : "🔴 LOSS"} | ${bet.entryCoin} $${bet.betSize} @ ${cents(bet.entryPrice)} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${bet.marketQuestion?.slice(0, 48)}`);
      closeBet(slug, { exitPrice: settle, reason: "expiry", pnl });
      liveMarks.delete(slug);
      exits.push({ pnl, won, reason: "expiry" });
      continue;
    }

    // 2) Not settled — just mark-to-market for dashboard, NO exit. Hold until close.
    const bbo = await getBBO(slug);
    const bid = bbo?.bid ?? bbo?.last;
    if (bid) {
      const move = (bid - bet.entryPrice) / bet.entryPrice;
      liveMarks.set(slug, { price: bid, pnl: +exitPnl(bet, bid).toFixed(2), movePct: move, ts: Date.now() });
      console.log(`  📊 HOLD ⚽ ${(bet.entryCoin || "SPORT").padEnd(5)} $${bet.betSize} | ${cents(bet.entryPrice)}→${cents(bid)} | Δ${pct(move)} | holding to close | ${bet.marketQuestion?.slice(0, 40)}`);
    } else {
      console.log(`  📊 HOLD ⚽ ${(bet.entryCoin || "SPORT").padEnd(5)} $${bet.betSize} @ ${cents(bet.entryPrice)} | awaiting settlement | ${bet.marketQuestion?.slice(0, 40)}`);
    }
  }
  return exits;
}

// ── Main scan ───────────────────────────────────────────────────
export async function runScanCycle() {
  const stats = getStats();
  console.log(`\n── SPORTS SCAN ${new Date().toISOString()} ${DRY_RUN ? "[DRY]" : "[🔴 LIVE]"} ──`);

  let markets;
  try {
    markets = await fetchSportsMoneylines();
  } catch (err) {
    console.error("polymarket.us fetch error:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  console.log(`📊 polymarket.us: ${markets.length} full-game moneylines live`);

  const exits = await processExits();

  // ── Balance ──
  let balance = getDryBalance();
  if (!DRY_RUN) {
    const ok = await ensureLiveReady();
    if (!ok) {
      const s = getStats();
      console.log(`── +0 entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
      return { signals: null, exits, betsPlaced: 0 };
    }
    try { balance = (await getBuyingPower()).buyingPower; } catch {}
  }
  console.log(`💰 ${DRY_RUN ? "Paper" : "Buying power"}: $${Number(balance).toFixed(2)} | Active: ${stats.activeBets}/${MAX_CONC} | P&L: $${stats.pnl}`);

  // ── Entry candidates: LIVE games prioritized over next-24h pre-game ──
  const now = Date.now();
  const NEXT_DAY_MS = 24 * 60 * 60 * 1000;
  const pool = markets
    .map(m => ({ ...m, px: m.ask ?? m.est }))
    .filter(m => m.px && m.px >= FAV_MIN && m.px <= FAV_MAX)
    // game must have either already started (live) or start within the next 24h
    .filter(m => {
      if (!m.gameStartIso) return false;
      const start = new Date(m.gameStartIso).getTime();
      return start <= now || (start - now) <= NEXT_DAY_MS;
    })
    // and not yet resolved/closed
    .filter(m => !m.endIso || new Date(m.endIso).getTime() > now)
    // tag each candidate as live or pre-game for sorting/logging
    .map(m => ({ ...m, isLive: new Date(m.gameStartIso).getTime() <= now }))
    // LIVE games first (isLive=true sorts before false), then by price within each tier
    .sort((a, b) => (b.isLive - a.isLive) || (b.px - a.px));

  let candidates = [];
  if (pool.length) {
    const liveCount = pool.filter(m => m.isLive).length;
    console.log(`🏆 ${pool.length} favorites (${liveCount} live, ${pool.length - liveCount} next-24h) ${cents(FAV_MIN)}-${cents(FAV_MAX)} (est). Verifying top books…`);
    candidates = await verifyCandidates(pool.slice(0, 8));
    if (candidates.length) {
      console.log(`📗 ${candidates.length} with live two-sided books: ${candidates.slice(0, 3).map(c => `${c.isLive ? "🔴" : "⏳"}${cents(c.ask)} ${c.question.slice(0, 26)}`).join(" · ")}`);
    } else {
      console.log("[INFO] Books too thin/wide on top live favorites this scan");
    }
  } else {
    console.log(`[INFO] No favorites in range (live or next-24h) right now`);
  }

  // ── Ground-truth dedup: real Polymarket positions (LIVE only) ──
  // Catches duplicates regardless of local state, restarts, or redeploys —
  // if the account ever bought into a market at all, skip it.
  let ownedSlugs = null;
  if (!DRY_RUN) {
    const positions = await getOpenPositions();
    if (positions) {
      ownedSlugs = new Set(
        Object.entries(positions)
          .filter(([, p]) => p.qtyBought > 0)
          .map(([slug]) => slug)
      );
    } else {
      console.log("  ⚠️ Could not verify live positions this scan — skipping new entries to be safe");
    }
  }

  // ── Circuit breaker: pause new entries if session realized P&L breaches limit ──
  // Existing open positions are untouched — they still hold to close/settle
  // normally. This only blocks placing FRESH bets once losses pile up.
  const currentPnl = parseFloat(stats.pnl || 0);
  if (_sessionStartPnl === null) _sessionStartPnl = currentPnl; // baseline on first scan this boot
  const sessionPnl = currentPnl - _sessionStartPnl;
  const breakerTripped = sessionPnl <= -SESSION_LOSS_LIMIT;
  if (breakerTripped) {
    console.log(`  🛑 CIRCUIT BREAKER: session P&L $${sessionPnl.toFixed(2)} ≤ -$${SESSION_LOSS_LIMIT} limit — new entries paused (open positions still hold/settle normally)`);
  }

  let betsPlaced = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 3; // hard cap on order attempts per scan (incl. failures)
  if (!breakerTripped) {
    for (const m of candidates) {
      if (betsPlaced >= ENTRIES_SCAN || attempts >= MAX_ATTEMPTS) break;
      if (getAllActiveBets().length >= MAX_CONC) break;
      if (balance < BET_MIN) { console.log("  ⏸ Balance below $" + BET_MIN); break; }
      if (hasActiveBet(m.slug)) continue;
      if (countBetsForMarket(m.slug) >= MAX_ENTRIES_PER_MARKET) {
        console.log(`  ⏭ Skipping ${m.slug.slice(0, 24)} — already entered ${MAX_ENTRIES_PER_MARKET}x (local)`);
        continue;
      }
      if (!DRY_RUN) {
        if (ownedSlugs === null) continue; // couldn't verify positions this scan — don't risk a dupe
        if (ownedSlugs.has(m.slug)) {
          console.log(`  ⏭ Skipping ${m.slug.slice(0, 24)} — already hold this position on Polymarket`);
          continue;
        }
      }

      let entryPrice = m.ask;
      let betSize = BET_SIZE;
      let orderId = `dry_${Date.now()}`;

      if (!DRY_RUN) {
        attempts++;
        const r = await buyYesFOK({ slug: m.slug, sizeUsd: BET_SIZE, ask: m.ask, tick: m.tick });
        if (!r.filled) {
          console.log(`  ⚠️ Entry not filled (${r.error}) | ${m.question.slice(0, 40)}`);
          continue;
        }
        entryPrice = r.fillPrice;
        betSize    = +r.cost.toFixed(2);
        orderId    = r.orderId;
        balance   -= betSize;
      } else {
        balance -= betSize;
      }

      const league = m.league || "SPORT";
      const game = [m.question, m.subtitle].filter(Boolean).join(" — ");
      recordBet({
        market: { conditionId: m.slug, question: `[${league}] ${game}`, endDateIso: m.endIso },
        side: "YES",
        betSize,
        edge: 0,
        trueProbability: entryPrice,
        impliedProbability: entryPrice,
        orderId,
        entryPrice,
        strategy: "SPORTS_ML",
        reasoning: `⚽ ${league} LIVE moneyline favorite @ ${cents(entryPrice)} | ${game} | flat $${betSize} | hold to close${DRY_RUN ? "" : " | LIVE FOK fill"}`,
        entryBtcPrice: null,
        entryCoin: league,
        sharpShooter: false,
        valueBet: false,
        strike: null,
        direction: m.question.slice(0, 30),
      });

      betsPlaced++;
      const payout = (betSize / entryPrice).toFixed(2);
      console.log(`  ✅ ENTRY${DRY_RUN ? "" : " 🔴LIVE"} ${league} $${betSize} @ ${cents(entryPrice)} | win → $${payout} | ${game.slice(0, 46)}`);
    }
  }

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl}${breakerTripped ? " | 🛑 BREAKER ACTIVE" : ""} ──`);
  return { signals: null, exits, betsPlaced };
}
