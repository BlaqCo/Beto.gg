/**
 * bot-sports.js — BETO.GG Sports v4.3 (polymarket.us native)
 *
 * Strategy: BUY YES on moneyline favorites 55-78¢ (live or starting within 12h)
 *           Flat $12 bets. HOLD TO RESOLUTION — no TP/SL, settlement only.
 * DRY:  paper fills at estimated price (no BBO required)
 * LIVE: FOK limit entries via signed REST
 */

import { recordBet, hasActiveBet, getStats, getAllActiveBets,
         closeBet, getDryBalance, countBetsForMarket } from "./state.js";
import { fetchSportsMoneylines, getBBO, getSettlement, getBookState,
         buyYesFOK, getBuyingPower, getOpenPositions,
         preflightUS } from "./polymarket-us.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ──────────────────────────────────────────────────────
const BET_SIZE      = 12;      // flat $12 per bet
const BET_MIN       = 12;
const FAV_MIN       = 0.35;    // 35¢ minimum - VERY loose
const FAV_MAX       = 0.90;    // up to 90¢ - catch anything with edge
const FEE           = 0.02;    // fee estimate on winning payout (bookkeeping)
const MAX_CONC      = 12;      // 12 concurrent slots
const ENTRIES_SCAN  = 12;      // up to 12 entries per scan
const NEXT_DAY_MS   = 48 * 60 * 60 * 1000; // 48h lookahead

// ── Helpers ──────────────────────────────────────────────────────
const shares    = b  => b.betSize / b.entryPrice;
const expiryPnl = (b, won) => won ? shares(b) * (1 - FEE) - b.betSize : -b.betSize;
const exitPnl   = (b, px) => shares(b) * px - b.betSize;
const pct       = x  => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const cents     = x  => `${(x * 100).toFixed(0)}¢`;

// ── Live preflight (once per boot; 60s backoff on failure) ──────
let _preflightDone = false;
let _preflightNextTry = 0;
async function ensureLiveReady() {
  if (DRY_RUN || _preflightDone) return true;
  if (Date.now() < _preflightNextTry) return false;
  try {
    const check = await preflightUS();
    check.messages.forEach(m => console.log(m));
    if (!check.ok) {
      _preflightNextTry = Date.now() + 60_000;
      console.error("❌ LIVE preflight failed — retrying in 60s");
      return false;
    }
    _preflightDone = true;
    return true;
  } catch (err) {
    console.error("❌ Preflight threw:", err.message);
    _preflightNextTry = Date.now() + 60_000;
    return false;
  }
}

// ── Mark-to-market cache (read by dashboard) ────────────────────
const liveMarks = new Map();
export function getSportsMarks() { return liveMarks; }

// ── Exits: settlement only — hold to close ──────────────────────
async function processExits() {
  const exits = [];
  const mine = getAllActiveBets().filter(b => b.strategy === "SPORTS_ML");

  for (const bet of mine) {
    const slug = bet.marketConditionId;

    // Only exit path: market settlement
    const settle = await getSettlement(slug);
    if (settle !== null) {
      const won = settle === 1;
      const pnl = expiryPnl(bet, won);
      const q   = (bet.marketQuestion || slug).replace(/^\[.*?\]\s*/, "").slice(0, 50);
      const league = (bet.entryCoin || "SPORT").toUpperCase();

      // Prominent settlement log — appears in dashboard System Log
      if (won) {
        console.log(`✅ WIN | ${league} | ${q}`);
        console.log(`   Bet: $${bet.betSize} @ ${cents(bet.entryPrice)} | Payout: +$${pnl.toFixed(2)} | Net P/L: +$${pnl.toFixed(2)}`);
      } else {
        console.log(`❌ LOSS | ${league} | ${q}`);
        console.log(`   Bet: $${bet.betSize} @ ${cents(bet.entryPrice)} | Lost: -$${bet.betSize.toFixed(2)} | Net P/L: -$${bet.betSize.toFixed(2)}`);
      }

      closeBet(slug, { exitPrice: settle, reason: "expiry", pnl });
      liveMarks.delete(slug);
      exits.push({ pnl, won, reason: "expiry", question: q, league });
      continue;
    }

    // Not settled — mark-to-market for dashboard only, never exit early
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

// ── Main scan ────────────────────────────────────────────────────
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

  console.log(`📊 polymarket.us: ${markets.length} full-game moneylines`);

  const exits = await processExits();

  // ── Balance ──────────────────────────────────────────────────
  let balance = getDryBalance();
  if (!DRY_RUN) {
    const ok = await ensureLiveReady();
    if (!ok) {
      console.log(`💰 Buying power: checking... | Active: ${stats.activeBets}/${MAX_CONC} | P&L: $${stats.pnl}`);
      const s = getStats();
      console.log(`── +0 entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
      return { signals: null, exits, betsPlaced: 0 };
    }
    try {
      const bp = await getBuyingPower();
      balance = bp.buyingPower;
      console.log(`💰 Buying power: $${Number(balance).toFixed(2)} | Active: ${stats.activeBets}/${MAX_CONC} | P&L: $${stats.pnl}`);
    } catch (err) {
      console.error("⚠️ getBuyingPower failed:", err.message);
      console.log(`💰 Buying power: unknown | Active: ${stats.activeBets}/${MAX_CONC} | P&L: $${stats.pnl}`);
    }
  } else {
    console.log(`💰 Paper: $${Number(balance).toFixed(2)} | Active: ${stats.activeBets}/${MAX_CONC} | P&L: $${stats.pnl}`);
  }

  // ── Entry candidates ──────────────────────────
  const now = Date.now();
  
  console.log(`📡 Received ${markets.length} markets from API`);
  if (markets.length === 0) {
    console.log("❌ NO MARKETS AVAILABLE — API returned empty list");
  } else {
    console.log(`  Top 3: ${markets.slice(0, 3).map(m => m.question?.slice(0, 40)).join(" | ")}`);
  }
  
  const candidatePool = markets.slice(0, 200); // check all 200
  console.log(`📋 Fetching BBO for ${candidatePool.length} markets`);

  // Fetch live BBO for ALL candidates
  const bboResults = await Promise.all(candidatePool.map(async m => {
    try {
      const bbo = await getBBO(m.slug);
      if (!bbo?.bid || !bbo?.ask) {
        console.log(`  ❌ No BBO: ${m.question?.slice(0, 35)}`);
        return null;
      }
      const livePx = bbo.ask;
      const spread = bbo.ask - bbo.bid;

      // Spread check by sport type - VERY RELAXED
      const q = (m.question || "").toLowerCase();
      const league = (m.league || "").toUpperCase();
      const isTennis  = ["TENNIS","ITF","ATP","WTA"].includes(league) || /atp|wta|itf|challenger/i.test(q);
      const isEsports = ["ESPORTS"].includes(league) || /esport|cs2|valorant|dota/i.test(q);
      const isCombat  = /ufc|mma|boxing|fight|round|knockout/i.test(q);
      const maxSpread = isTennis ? 0.30 : isEsports ? 0.25 : isCombat ? 0.20 : 0.15;

      if (spread > maxSpread) {
        console.log(`  ⚠️ Spread ${(spread*100).toFixed(0)}¢ > ${(maxSpread*100).toFixed(0)}¢ (accepting anyway) | ${m.question?.slice(0,35)}`);
      }
      return { ...m, ask: bbo.ask, bid: bbo.bid, px: bbo.ask };
    } catch (e) {
      console.log(`  ❌ BBO error for ${m.slug}: ${e.message}`);
      return null;
    }
  }));
  
  const bbosWithData = bboResults.filter(b => b != null);
  console.log(`✅ ${bbosWithData.length}/${candidatePool.length} markets have BBO data`);

  let candidates;
  if (DRY_RUN) {
    candidates = bboResults
      .filter(m => m && m.px >= FAV_MIN && m.px <= FAV_MAX)
      .slice(0, 30);
    const lc = candidates.filter(m => m.isLive).length;
    console.log(`🏆 ${candidates.length} favorites (${lc} 🔴 live, ${candidates.length-lc} ⏳) ${cents(FAV_MIN)}-${cents(FAV_MAX)}`);
    console.log(`  Top: ${candidates.slice(0,5).map(m => `${m.isLive?"🔴":"⏳"} ${cents(m.px)} ${m.question?.slice(0,30)}`).join(" | ")}`);
    console.log(`📗 ${candidates.length} dry candidates`);
  } else {
    // LIVE: bet on any market in price range, live games first
    const pool = bbosWithData
      .filter(m => m.px >= FAV_MIN && m.px <= FAV_MAX)
      .sort((a, b) => {
        if (b.isLive !== a.isLive) return b.isLive ? 1 : -1;
        return b.px - a.px;
      });
    const lc = pool.filter(m => m.isLive).length;
    if (pool.length) {
      console.log(`🏆 ${pool.length} favorites (${lc} 🔴 live) in ${cents(FAV_MIN)}-${cents(FAV_MAX)}`);
      console.log(`  Top: ${pool.slice(0,5).map(m => `${m.isLive?"🔴":"⏳"} ${cents(m.px)} ${m.question?.slice(0,30)}`).join(" | ")}`);
    } else {
      console.log(`[INFO] No favorites in ${cents(FAV_MIN)}-${cents(FAV_MAX)}. BBO sample: ${bbosWithData.slice(0,5).map(m=>`${cents(m.px)} ${m.question?.slice(0,20)}`).join(" | ")}`);
    }
    candidates = pool;
  }
  // ── Entry loop ─────────────────────────────────────────────────
  console.log(`🎯 ${candidates.length} candidates ready for entry`);
  if (candidates.length === 0) {
    console.log("❌ NO CANDIDATES — nothing to bet on");
  } else {
    console.log(`  First candidate: ${candidates[0].question?.slice(0, 50)} @ ${cents(candidates[0].px)}`);
  }
  
  let betsPlaced = 0;
  let attempts   = 0;
  const MAX_ATTEMPTS = 12;

  for (const m of candidates) {
    if (betsPlaced >= ENTRIES_SCAN || attempts >= MAX_ATTEMPTS) break;
    if (getAllActiveBets().length >= MAX_CONC) break;
    if (balance < BET_MIN) { console.log("  ⏸ Balance below $" + BET_MIN); break; }
    if (hasActiveBet(m.slug)) continue;
    if (!DRY_RUN) {
      if (ownedSlugs === null) continue;
      if (ownedSlugs.has(m.slug)) {
        console.log(`  ⏭ Already holding ${m.slug.slice(0, 24)} on Polymarket`);
        continue;
      }
    }

    let entryPrice = m.ask;
    let betSize    = BET_SIZE;
    let orderId    = `dry_${Date.now()}`;

    // ── GROUND TRUTH CHECK: market must be genuinely OPEN for trading ──
    // Official market state from the order book. Stale/resolved markets
    // report EXPIRED/TERMINATED here even when list metadata says active.
    const book = await getBookState(m.slug);
    if (!book.isOpen) {
      console.log(`  ⛔ Not tradeable (state=${book.state}) | ${m.question?.slice(0, 40)}`);
      continue;
    }
    // Use live book ask if available (fresher than BBO from seconds ago)
    if (book.bestAsk && book.bestAsk > 0.01 && book.bestAsk < 0.99) {
      entryPrice = book.bestAsk;
      m.ask = book.bestAsk;
    }
    console.log(`  ✅ Market OPEN | ask=${cents(m.ask)} askQty=${book.askQty} | ${m.question?.slice(0, 40)}`);

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
    const game   = [m.question, m.subtitle].filter(Boolean).join(" — ");
    recordBet({
      market:             { conditionId: m.slug, question: `[${league}] ${game}`, endDateIso: m.endIso },
      side:               "YES",
      betSize,
      edge:               0,
      trueProbability:    entryPrice,
      impliedProbability: entryPrice,
      orderId,
      entryPrice,
      strategy:           "SPORTS_ML",
      reasoning:          `⚽ ${league} moneyline favorite @ ${cents(entryPrice)} | ${game} | flat $${betSize} | hold to close${DRY_RUN ? "" : " | LIVE FOK fill"}`,
      entryBtcPrice:      null,
      entryCoin:          league,
      sharpShooter:       false,
      valueBet:           false,
      strike:             null,
      direction:          m.question.slice(0, 30),
    });

    betsPlaced++;
    const payout = (betSize / entryPrice).toFixed(2);
    console.log(`  ✅ ENTRY${DRY_RUN ? "" : " 🔴LIVE"} ${league} $${betSize} @ ${cents(entryPrice)} | win → $${payout} | ${game.slice(0, 46)}`);
  }

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
  return { signals: null, exits, betsPlaced };
}
