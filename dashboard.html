/**
 * bot-sports.js — BETO.GG Sports v4.2 (polymarket.us native)
 *
 * Strategy: BUY YES on moneyline favorites 60-70¢ (live or starting within 12h)
 *           Flat $10 bets. HOLD TO RESOLUTION — no TP/SL, settlement only.
 * DRY:  paper fills at estimated price (no BBO required)
 * LIVE: FOK limit entries via signed REST
 */

import { recordBet, hasActiveBet, getStats, getAllActiveBets,
         closeBet, getDryBalance, countBetsForMarket } from "./state.js";
import { fetchSportsMoneylines, getBBO, getSettlement,
         buyYesFOK, getBuyingPower, getOpenPositions,
         preflightUS } from "./polymarket-us.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ──────────────────────────────────────────────────────
const BET_SIZE      = 5;       // flat $5 per bet
const BET_MIN       = 5;
const FAV_MIN       = 0.60;    // 60¢ minimum edge
const FAV_MAX       = 0.70;    // skip near-decided games
const FEE           = 0.02;    // fee estimate on winning payout (bookkeeping)
const MAX_CONC      = 10;      // 10 concurrent slots
const ENTRIES_SCAN  = 10;      // up to 10 entries per scan
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

  // ── Entry candidates: favorites 60-70¢ ──────────────────────────
  // polymarket-us.js already handles all time filtering.
  // Here we ONLY filter by price range and reject already-ended markets.
  const now = Date.now();

  console.log(`  📋 Raw markets from fetch: ${markets.length} | checking price range ${cents(FAV_MIN)}-${cents(FAV_MAX)}`);

  const pool = markets
    .map(m => ({ ...m, px: m.ask ?? m.est }))
    .filter(m => {
      if (!m.px || m.px < FAV_MIN || m.px > FAV_MAX) return false;
      // Only reject if market is confirmed ended
      if (m.endIso && new Date(m.endIso).getTime() < now - 3_600_000) return false;
      return true;
    })
    // Sort: 1) live first 2) by price descending (strongest edge)
    .sort((a, b) => {
      const aLive = a.isLive ? 1 : 0;
      const bLive = b.isLive ? 1 : 0;
      if (bLive !== aLive) return bLive - aLive;
      return b.px - a.px;
    });

  if (!pool.length) {
    // Show what prices ARE available so we can debug range issues
    const sample = markets.slice(0, 5).map(m => `${cents(m.ask ?? m.est)} ${m.question?.slice(0,25)}`).join(" | ");
    console.log(`[INFO] No favorites in ${cents(FAV_MIN)}-${cents(FAV_MAX)} range. Sample prices: ${sample}`);
    const s = getStats();
    console.log(`── +0 entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
    return { signals: null, exits, betsPlaced: 0 };
  }

  const liveCount = pool.filter(m => m.isLive).length;
  const preCount  = pool.length - liveCount;
  console.log(`🏆 ${pool.length} favorites (${liveCount} 🔴 live, ${preCount} ⏳ pre-game) ${cents(FAV_MIN)}-${cents(FAV_MAX)}`);
  console.log(`  Top: ${pool.slice(0,5).map(m => `${m.isLive?"🔴":"⏳"} ${cents(m.px)} ${m.question?.slice(0,30)}`).join(" | ")}`);

  // ── In dry run: skip BBO check, paper fill at est price ────────
  let candidates;
  if (DRY_RUN) {
    candidates = pool.slice(0, 16).map(m => ({
      ...m,
      ask: m.ask ?? m.est ?? 0.65,
      bid: m.bid ?? (m.est ? m.est - 0.02 : 0.63),
    }));
    console.log(`📗 ${candidates.length} dry candidates: ${candidates.slice(0, 3).map(c => `${cents(c.ask)} ${c.question.slice(0, 24)}`).join(" · ")}`);
  } else {
    // Live: verify real orderbook (spread ≤ 6¢)
    const checks = await Promise.all(pool.slice(0, 16).map(async c => {
      const bbo = await getBBO(c.slug);
      if (!bbo?.bid || !bbo?.ask) return null;
      if (bbo.ask - bbo.bid > 0.06) return null;
      return { ...c, ask: bbo.ask, bid: bbo.bid };
    }));
    candidates = checks.filter(Boolean);
    if (candidates.length) {
      console.log(`📗 ${candidates.length} verified: ${candidates.slice(0, 3).map(c => `${cents(c.ask)} ${c.question.slice(0, 24)}`).join(" · ")}`);
    } else {
      console.log("[INFO] Books too thin/wide on all candidates this scan");
    }
  }

  // ── Position dedup (live only) ─────────────────────────────────
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
      console.log("  ⚠️ Could not verify live positions — skipping new entries to be safe");
    }
  }

  // ── Entry loop ─────────────────────────────────────────────────
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
