/**
 * bot-sports.js — PolyBettor Sports Engine v5
 *
 * Strategy: BUY YES on sports moneyline favorites at 60–72¢ (confirmed live BBO).
 * - $10 flat bets, 12 concurrent slots
 * - Prioritizes LIVE in-play markets first, then upcoming
 * - Snipes immediately on every scan — no artificial entry throttle
 * - Hold to settlement only (no TP/SL mid-game)
 * - Dedup via both local state and live Polymarket position check
 */

import {
  recordBet, hasActiveBet, getStats, getAllActiveBets,
  closeBet, getDryBalance, countBetsForMarket,
} from "./state.js";
import {
  fetchSportsMoneylines, verifyCandidates, getBBO,
  getSettlement, buyYesFOK, getBuyingPower, getOpenPositions, preflightUS,
} from "./polymarket-us.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ────────────────────────────────────────────────────────────────────
const BET_SIZE            = 10;     // $10 flat
const FAV_MIN             = 0.60;   // 60¢ floor
const FAV_MAX             = 0.72;   // 72¢ ceiling
const MAX_CONC            = 12;     // 12 concurrent slots
const MAX_SPREAD          = 0.08;   // max bid-ask spread to accept
const MAX_PER_MARKET      = 1;      // never enter same market twice
const SESSION_LOSS_LIMIT  = parseFloat(process.env.SESSION_LOSS_LIMIT || "150");
const FEE_EST             = 0.02;   // fee estimate on winning payout

// ── Session circuit breaker ───────────────────────────────────────────────────
let _sessionStartPnl = null;

// ── Live preflight (once per boot, 60s backoff on failure) ───────────────────
let _preflightDone = false, _preflightNext = 0;
async function ensureLiveReady() {
  if (DRY_RUN || _preflightDone) return true;
  if (Date.now() < _preflightNext) return false;
  const check = await preflightUS();
  check.messages.forEach(m => console.log(m));
  if (!check.ok) { _preflightNext = Date.now() + 60_000; return false; }
  _preflightDone = true;
  return true;
}

// Mark-to-market cache (read by /active endpoint)
const liveMarks = new Map(); // slug → { price, pnl, movePct, ts }
export function getSportsMarks() { return liveMarks; }

// BBO throttle for active positions — only call every 30s per market
const _bboMarkCache = new Map(); // slug → ts of last BBO call
const BBO_MARK_TTL  = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const shares   = b  => b.betSize / b.entryPrice;
const winPnl   = b  => shares(b) * (1 - FEE_EST) - b.betSize;
const lossPnl  = b  => -b.betSize;
const mtmPnl   = (b, px) => shares(b) * px - b.betSize;
const cents    = x  => `${(x * 100).toFixed(0)}¢`;
const pct      = x  => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

// ── Exits: settlement-only, hold to close ─────────────────────────────────────
async function processExits() {
  const exits = [];
  const mine  = getAllActiveBets().filter(b => b.strategy === "SPORTS_ML");

  for (const bet of mine) {
    const slug = bet.marketConditionId;

    // Only exit path: market settles
    const settle = await getSettlement(slug);
    if (settle !== null) {
      const won  = settle === 1;
      const pnl  = won ? winPnl(bet) : lossPnl(bet);
      console.log(` 🏁 SETTLED ${won ? "🟢 WIN" : "🔴 LOSS"} | ${bet.entryCoin} $${bet.betSize} @ ${cents(bet.entryPrice)} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${(bet.marketQuestion || "").slice(0, 50)}`);
      closeBet(slug, { exitPrice: settle, reason: "expiry", pnl: +pnl.toFixed(2) });
      liveMarks.delete(slug);
      exits.push({ pnl, won, reason: "expiry", market: bet.marketQuestion });
      continue;
    }

    // Still open — mark to market for dashboard (throttled to every 30s)
    const lastBboTs = _bboMarkCache.get(slug) || 0;
    if (Date.now() - lastBboTs < BBO_MARK_TTL) {
      // Use cached mark if available, just log from it
      const cached = liveMarks.get(slug);
      if (cached) {
        console.log(` 📊 HOLD ${(bet.entryCoin || "SPORT").padEnd(6)} $${bet.betSize} @ ${cents(bet.entryPrice)} | cached ${cents(cached.price)} ${cached.pnl >= 0 ? "+" : ""}$${cached.pnl} | ${(bet.marketQuestion || "").slice(0, 40)}`);
      }
      continue;
    }
    _bboMarkCache.set(slug, Date.now());
    const bbo = await getBBO(slug);
    const bid = bbo?.bid ?? bbo?.currentPx ?? bbo?.last;
    if (bid) {
      const move = (bid - bet.entryPrice) / bet.entryPrice;
      const openPnl = +mtmPnl(bet, bid).toFixed(2);
      liveMarks.set(slug, { price: bid, pnl: openPnl, movePct: move, ts: Date.now() });
      console.log(` 📊 HOLD ${(bet.entryCoin || "SPORT").padEnd(6)} $${bet.betSize} | ${cents(bet.entryPrice)}→${cents(bid)} Δ${pct(move)} | unrealized ${openPnl >= 0 ? "+" : ""}$${openPnl} | ${(bet.marketQuestion || "").slice(0, 40)}`);
    } else {
      console.log(` 📊 HOLD ${(bet.entryCoin || "SPORT").padEnd(6)} $${bet.betSize} @ ${cents(bet.entryPrice)} | no quote, awaiting settlement | ${(bet.marketQuestion || "").slice(0, 40)}`);
    }
  }

  return exits;
}

// ── Main scan ──────────────────────────────────────────────────────────────────
export async function runScanCycle() {
  const stats = getStats();
  console.log(`\n── SPORTS SCAN ${new Date().toISOString()} ${DRY_RUN ? "[DRY]" : "[🔴 LIVE]"} ──`);

  // Fetch all sports markets
  let markets;
  try {
    markets = await fetchSportsMoneylines();
  } catch (err) {
    console.error("[scan] market fetch error:", err.message);
    return { exits: [], betsPlaced: 0, markets: [] };
  }

  const liveCount = markets.filter(m => m.isLive).length;
  console.log(`📊 ${markets.length} markets | 🔴 ${liveCount} LIVE`);

  // Process exits first
  const exits = await processExits();

  // Balance
  let balance = getDryBalance();
  if (!DRY_RUN) {
    const ready = await ensureLiveReady();
    if (!ready) {
      const s = getStats();
      return { exits, betsPlaced: 0, markets };
    }
    try {
      const bp = await getBuyingPower();
      balance = bp.buyingPower;
    } catch (e) {
      console.error("[scan] balance error:", e.message);
    }
  }

  console.log(`💰 ${DRY_RUN ? "Paper" : "Buying power"}: $${Number(balance).toFixed(2)} | Active: ${stats.activeBets}/${MAX_CONC}`);

  // ── Circuit breaker ────────────────────────────────────────────────────────
  const currentPnl = parseFloat(stats.pnl || 0);
  if (_sessionStartPnl === null) _sessionStartPnl = currentPnl;
  const sessionPnl    = currentPnl - _sessionStartPnl;
  const breakerActive = sessionPnl <= -SESSION_LOSS_LIMIT;
  if (breakerActive) {
    console.log(` 🛑 CIRCUIT BREAKER: session P&L $${sessionPnl.toFixed(2)} ≤ -$${SESSION_LOSS_LIMIT} | entries paused`);
  }

  // ── Build candidate pool ───────────────────────────────────────────────────
  // 1) Filter by price estimate (pre-BBO screen)
  // 2) Live markets first, then upcoming
  // 3) Skip already-held slots
  const now = Date.now();
  const pool = markets
    .filter(m => {
      // Must have a price estimate in range
      const px = m.ask ?? m.est;
      if (!px || px < FAV_MIN || px > FAV_MAX) return false;
      // Only live or games starting within 48h
      if (m.isLive) return true;
      if (m.upcoming && m.startMs) {
        return (m.startMs - now) <= 48 * 60 * 60 * 1000;
      }
      return false;
    })
    .filter(m => !hasActiveBet(m.slug))
    .filter(m => countBetsForMarket(m.slug) < MAX_PER_MARKET);

  let betsPlaced = 0;

  if (!breakerActive && pool.length > 0 && getAllActiveBets().length < MAX_CONC && balance >= BET_SIZE) {
    // Cap BBO checks to available slots × 2 max — avoids burst rate limit
    const slotsLeft  = MAX_CONC - getAllActiveBets().length;
    const bboLimit   = Math.min(pool.length, slotsLeft * 2, 20);
    const poolCapped = pool.slice(0, bboLimit);

    console.log(`🎯 ${pool.length} candidates pre-BBO (${pool.filter(m => m.isLive).length} live) | verifying top ${bboLimit}...`);

    // Verify BBO in parallel — snipe speed
    const verified = await verifyCandidates(poolCapped, { maxSpread: MAX_SPREAD, favMin: FAV_MIN, favMax: FAV_MAX });

    if (verified.length) {
      console.log(`✅ ${verified.length} confirmed: ${verified.slice(0, 3).map(c => `${cents(c.ask)} ${(c.question || "").slice(0, 25)}`).join(" · ")}`);
    } else {
      console.log("[scan] No verified candidates this scan");
    }

    // Ground-truth dedup via live Polymarket positions (LIVE only)
    let ownedSlugs = null;
    if (!DRY_RUN) {
      const positions = await getOpenPositions();
      if (positions) {
        ownedSlugs = new Set(Object.keys(positions));
      } else {
        console.log(" ⚠️ Could not verify positions — skipping new entries");
      }
    }

    // Enter every valid candidate immediately (snipe all available slots)
    for (const m of verified) {
      if (getAllActiveBets().length >= MAX_CONC) break;
      if (balance < BET_SIZE) { console.log(" ⏸ Balance below $10"); break; }
      if (hasActiveBet(m.slug)) continue;
      if (!DRY_RUN && ownedSlugs === null) continue;
      if (!DRY_RUN && ownedSlugs?.has(m.slug)) {
        console.log(` ⏭ Already own ${m.slug.slice(0, 24)} on Polymarket`);
        continue;
      }

      let entryPrice = m.ask;
      let betSize    = BET_SIZE;
      let orderId    = `dry_${Date.now()}_${m.slug.slice(-8)}`;

      if (!DRY_RUN) {
        const r = await buyYesFOK({ slug: m.slug, sizeUsd: BET_SIZE, ask: m.ask, tick: m.tick });
        if (!r.filled) {
          console.log(` ⚠️ Not filled (${r.error}) | ${(m.question || "").slice(0, 40)}`);
          continue;
        }
        entryPrice = r.fillPrice;
        betSize    = +r.cost.toFixed(2);
        orderId    = r.orderId;
        balance   -= betSize; // track local balance for this scan's slot checks
      }
      // DRY_RUN: don't decrement local balance here — recordBet() decrements state.dryBalance.
      // After recordBet we re-read getDryBalance() to get accurate remaining balance.

      const league  = m.league || "SPORT";
      const game    = [m.question, m.subtitle].filter(Boolean).join(" — ");
      const isLive  = m.isLive;

      recordBet({
        market: {
          conditionId: m.slug,
          question:    `[${league}] ${game}`,
          endDateIso:  m.endIso,
        },
        side:              "YES",
        betSize,
        edge:              0,
        trueProbability:   entryPrice,
        impliedProbability: entryPrice,
        orderId,
        entryPrice,
        strategy:          "SPORTS_ML",
        reasoning:         `${isLive ? "🔴 LIVE" : "⏰ UPCOMING"} ${league} moneyline @ ${cents(entryPrice)} | ${game} | $${betSize} flat | hold to settlement${DRY_RUN ? "" : " | LIVE FOK fill"}`,
        entryBtcPrice:     null,
        entryCoin:         league,
        sharpShooter:      false,
        valueBet:          false,
        strike:            null,
        direction:         (m.question || "").slice(0, 30),
      });

      betsPlaced++;
      if (DRY_RUN) balance = getDryBalance(); // re-read state after recordBet decremented it
      const potentialPayout = (betSize / entryPrice).toFixed(2);
      console.log(` ✅ ENTRY${DRY_RUN ? "" : " 🔴LIVE"} [${isLive ? "LIVE" : "UPCOMING"}] ${league} $${betSize} @ ${cents(entryPrice)} → win $${potentialPayout} | ${game.slice(0, 48)}`);
    }
  } else if (pool.length === 0) {
    console.log("[scan] No candidates in 60–72¢ range");
  }

  const s = getStats();
  // Compute open PnL from liveMarks
  let openPnl = 0;
  for (const mark of liveMarks.values()) openPnl += mark.pnl || 0;

  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | Realized P&L:$${s.pnl} | Open P&L:${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}${breakerActive ? " | 🛑 BREAKER" : ""} ──`);

  return { exits, betsPlaced, markets, openPnl: +openPnl.toFixed(2) };
}
