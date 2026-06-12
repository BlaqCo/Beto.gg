/**
 * bot-sports.js — PolyBettor Sports v3 (polymarket.us native)
 *
 * Data + execution via official polymarket-us SDK.
 * Strategy: BUY YES on moneyline favorites (ask 52-95¢), $10-15 flat.
 * DRY:  paper fills at ask, exits priced off bid.
 * LIVE: FOK limit entries, REAL TP/SL via closePosition, settlement booked.
 * Only touches its own bets (strategy === "SPORTS_ML").
 */

import { recordBet, hasActiveBet, getStats, getAllActiveBets,
         closeBet, getDryBalance } from "./state.js";
import { fetchSportsMoneylines, getBBO, getSettlement,
         buyYesFOK, closePositionLive, getBuyingPower,
         preflightUS } from "./polymarket-us.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ──────────────────────────────────────────────────────
const BET_SIZE      = 12;      // flat, inside $10-15
const BET_MIN       = 10;
const FAV_MIN       = 0.52;    // favorite = YES ask above coin-flip
const FAV_MAX       = 0.95;    // skip near-decided games
const TP_PCT        = 0.06;    // +6% on bid vs entry → take profit
const SL_PCT        = 0.15;    // -15% on bid vs entry → stop loss
const FEE           = 0.02;    // fee estimate on winning payout (bookkeeping)
const MAX_CONC      = 8;
const ENTRIES_SCAN  = 2;
// book quality: require two-sided quotes, spread ≤ 6¢ (checked at entry)

// ── Helpers ─────────────────────────────────────────────────────
const shares = b => b.betSize / b.entryPrice;
const expiryPnl = (b, won) => won ? shares(b) * (1 - FEE) - b.betSize : -b.betSize;
const exitPnl = (b, px) => shares(b) * px - b.betSize;
const pct = x => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const cents = x => `${(x * 100).toFixed(0)}¢`;

// ── Live preflight (once) ───────────────────────────────────────
let _preflightDone = false;
async function ensureLiveReady() {
  if (DRY_RUN || _preflightDone) return true;
  const check = await preflightUS();
  check.messages.forEach(m => console.log(m));
  if (!check.ok) {
    console.error("❌ LIVE preflight failed — sports entries disabled this scan");
    return false;
  }
  _preflightDone = true;
  return true;
}

// ── Exits ───────────────────────────────────────────────────────
async function processExits() {
  const exits = [];
  const mine = getAllActiveBets().filter(b => b.strategy === "SPORTS_ML");

  for (const bet of mine) {
    const slug = bet.marketConditionId;

    // 1) Settled? (game over, market resolved)
    const settle = await getSettlement(slug);
    if (settle !== null) {
      const won = settle === 1;
      const pnl = expiryPnl(bet, won);
      console.log(`  🏁 SETTLE ${won ? "🟢 WIN" : "🔴 LOSS"} | ${bet.entryCoin} $${bet.betSize} @ ${cents(bet.entryPrice)} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${bet.marketQuestion?.slice(0, 48)}`);
      closeBet(slug, { exitPrice: settle, reason: "expiry", pnl });
      exits.push({ pnl, won, reason: "expiry" });
      continue;
    }

    // 2) Mark to current bid
    const bbo = await getBBO(slug);
    const bid = bbo?.bid ?? bbo?.last;
    if (!bid) continue; // no quote this scan — try next

    const move = (bid - bet.entryPrice) / bet.entryPrice;
    const wantTP = move >= TP_PCT;
    const wantSL = move <= -SL_PCT;

    if (!wantTP && !wantSL) {
      console.log(`  📊 HOLD ⚽ ${(bet.entryCoin || "SPORT").padEnd(5)} $${bet.betSize} | ${cents(bet.entryPrice)}→${cents(bid)} | Δ${pct(move)} | ${bet.marketQuestion?.slice(0, 40)}`);
      continue;
    }

    const reason = wantTP ? "take_profit" : "stop_loss";
    const icon   = wantTP ? "🟢" : "🔴";

    if (!DRY_RUN) {
      // REAL exit: market-close entire position
      const res = await closePositionLive(slug);
      if (!res.ok) {
        console.log(`  ⚠️ ${reason.toUpperCase()} close failed (${res.error}) — will retry next scan`);
        continue;
      }
    }

    const pnl = exitPnl(bet, bid);
    console.log(`  🎯 EXIT [${reason.toUpperCase()}] ${icon} | ${bet.entryCoin} $${bet.betSize} | ${cents(bet.entryPrice)}→${cents(bid)} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}${DRY_RUN ? "" : " | LIVE position closed"}`);
    closeBet(slug, { exitPrice: bid, reason, pnl });
    exits.push({ pnl, won: pnl > 0, reason });
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

  // ── Entry candidates: favorites by ask, strongest first ──
  const candidates = markets
    .filter(m => m.ask && m.ask >= FAV_MIN && m.ask <= FAV_MAX)
    .filter(m => m.bid && m.ask && (m.ask - m.bid) <= 0.06) // real two-sided book, sane spread
    .sort((a, b) => b.ask - a.ask);

  if (candidates.length) {
    console.log(`🏆 ${candidates.length} favorites ${cents(FAV_MIN)}-${cents(FAV_MAX)}. Top: ${candidates.slice(0, 3).map(c => `${cents(c.ask)} ${c.question.slice(0, 28)}`).join(" · ")}`);
  } else {
    console.log(`[INFO] No favorites in range right now`);
  }

  let betsPlaced = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 3; // hard cap on order attempts per scan (incl. failures)
  for (const m of candidates) {
    if (betsPlaced >= ENTRIES_SCAN || attempts >= MAX_ATTEMPTS) break;
    if (getAllActiveBets().length >= MAX_CONC) break;
    if (balance < BET_MIN) { console.log("  ⏸ Balance below $" + BET_MIN); break; }
    if (hasActiveBet(m.slug)) continue;

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

    recordBet({
      market: { conditionId: m.slug, question: m.question, endDateIso: m.endIso },
      side: "YES",
      betSize,
      edge: 0,
      trueProbability: entryPrice,
      impliedProbability: entryPrice,
      orderId,
      entryPrice,
      strategy: "SPORTS_ML",
      reasoning: `⚽ Favorite ML @ ${cents(entryPrice)} | flat $${betSize}${DRY_RUN ? "" : " | LIVE FOK fill"}`,
      entryBtcPrice: null,
      entryCoin: "SPORT",
      sharpShooter: false,
      valueBet: false,
      strike: null,
      direction: m.question.slice(0, 30),
    });

    betsPlaced++;
    const payout = (betSize / entryPrice).toFixed(2);
    console.log(`  ✅ ENTRY${DRY_RUN ? "" : " 🔴LIVE"} $${betSize} @ ${cents(entryPrice)} | win → $${payout} | ${m.question.slice(0, 50)}`);
  }

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
  return { signals: null, exits, betsPlaced };
}
