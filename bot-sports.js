/**
 * bot-sports.js — PolyBettor Sports Edition v2
 *
 * Self-contained: fetches sports moneyline markets from Gamma directly.
 * Strategy: BUY the favorite (higher-priced outcome, 52-95¢).
 * $10-15 straight bets | TP +6% | SL -15% | expiry settlement.
 * Only touches its own bets (strategy === "SPORTS_ML") so crypto
 * positions are never affected by mode switching.
 */

import axios from "axios";
import { recordBet, hasActiveBet, getStats, getAllActiveBets,
         closeBet, getDryBalance } from "./state.js";
import { placeOrder } from "./polymarket.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ──────────────────────────────────────────────────────
const BET_MIN        = 10;
const BET_MAX        = 15;
const BET_SIZE       = 12;       // flat, inside Anthony's $10-15 range
const FAV_MIN        = 0.52;     // favorite must be ≥52¢ (above coin-flip)
const FAV_MAX        = 0.95;     // skip near-decided games
const TP_PCT         = 0.06;     // +6% price move → take profit (dry only)
const SL_PCT         = 0.15;     // -15% price move → stop loss (dry only)
const SLIPPAGE       = 0.005;
const FEE            = 0.02;     // 2% fee on winning payout
const MAX_CONC       = 8;
const ENTRIES_SCAN   = 2;
const GAMMA_TTL      = 20_000;
const MIN_MINS_LEFT  = 5;        // skip games ending in <5 min

// League slug prefixes Polymarket uses for sports
const LEAGUE_SLUGS = ["nba","nfl","mlb","nhl","wnba","mls","epl","ucl","uel",
  "laliga","la-liga","seriea","serie-a","bundesliga","ligue","cfb","cbb",
  "ncaa","atp","wta","ufc","mma","box","f1","nascar","golf","pga"];

const NOT_MONEYLINE = /spread|total|over|under|o\/u|points|alt |alternate|prop|first|1st|both teams|btts|draw|margin|series|to score/i;

// ── Sports market fetch (Gamma) ─────────────────────────────────
let _cache = null, _cacheTime = 0;

function looksLikeSports(m) {
  const slug = (m.slug || "").toLowerCase();
  const q    = (m.question || "").toLowerCase();
  if (m.gameStartTime) return true;
  if (LEAGUE_SLUGS.some(p => slug.startsWith(p + "-") || slug.includes("-" + p + "-"))) return true;
  return / vs\.? | @ /.test(q);
}

function isMoneyline(m, outcomes) {
  if (m.sportsMarketType) return String(m.sportsMarketType).toLowerCase() === "moneyline";
  if (outcomes.length !== 2) return false;
  if (NOT_MONEYLINE.test(m.question || "")) return false;
  return true;
}

function parseArr(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function fetchSportsMarkets() {
  if (_cache && Date.now() - _cacheTime < GAMMA_TTL) return _cache;

  const nowIso = new Date().toISOString();
  const maxIso = new Date(Date.now() + 36 * 3600_000).toISOString();
  const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
    params: { active: true, closed: false, limit: 500,
              order: "endDate", ascending: true,
              end_date_min: nowIso, end_date_max: maxIso },
    timeout: 10_000,
  });
  const all = Array.isArray(data) ? data : (data?.markets || []);

  const sports = [];
  for (const m of all) {
    if (!looksLikeSports(m)) continue;
    const outcomes = parseArr(m.outcomes);
    const prices   = parseArr(m.outcomePrices).map(Number);
    const tokens   = parseArr(m.clobTokenIds);
    if (!isMoneyline(m, outcomes)) continue;
    if (outcomes.length !== 2 || prices.length !== 2) continue;
    if (prices.some(p => !(p > 0 && p < 1))) continue;

    const endMs = m.endDate ? new Date(m.endDate).getTime() : null;
    sports.push({
      conditionId: m.conditionId || m.condition_id,
      question:    m.question || m.title || "",
      slug:        m.slug || "",
      endMs, endDateIso: m.endDate || null,
      gameStartMs: m.gameStartTime ? new Date(m.gameStartTime).getTime() : null,
      outcomes, prices, tokens,
      live: true,
    });
  }
  _cache = sports; _cacheTime = Date.now();
  return sports;
}

function sportOf(m) {
  const s = (m.slug || "").toLowerCase();
  for (const p of LEAGUE_SLUGS) if (s.startsWith(p + "-") || s.includes("-" + p + "-")) return p.toUpperCase();
  return "SPORT";
}

// ── PnL helpers ─────────────────────────────────────────────────
function fillPrice(entry)        { return Math.min(0.97, entry + SLIPPAGE); }
function sharesOf(bet)           { return bet.betSize / fillPrice(bet.entryPrice); }
function expiryPnl(bet, won)     { return won ? sharesOf(bet) * (1 - FEE) - bet.betSize : -bet.betSize; }
function earlyExit(bet, price) {
  const exitPrice = Math.max(0.01, price - SLIPPAGE);
  return { exitPrice, pnl: sharesOf(bet) * exitPrice - bet.betSize };
}

// ── Settle a single ended market by conditionId ─────────────────
async function fetchFinal(conditionId) {
  try {
    const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
      params: { condition_ids: conditionId, limit: 1 }, timeout: 8_000,
    });
    const m = (Array.isArray(data) ? data : data?.markets || [])[0];
    if (!m) return null;
    return { closed: !!m.closed, outcomes: parseArr(m.outcomes),
             prices: parseArr(m.outcomePrices).map(Number) };
  } catch { return null; }
}

// ── Exits ───────────────────────────────────────────────────────
async function processExits(markets) {
  const exits = [];
  const mine = getAllActiveBets().filter(b => b.strategy === "SPORTS_ML");

  for (const bet of mine) {
    const team = bet.direction;          // team we bought
    const mkt  = markets.find(m => m.conditionId === bet.marketConditionId);

    let curPrice = null, closedInfo = null;
    if (mkt) {
      const idx = mkt.outcomes.findIndex(o => o === team);
      if (idx >= 0) curPrice = mkt.prices[idx];
    } else {
      closedInfo = await fetchFinal(bet.marketConditionId);
      if (closedInfo && !closedInfo.closed && closedInfo.prices.length === 2) {
        const idx = closedInfo.outcomes.findIndex(o => o === team);
        if (idx >= 0) curPrice = closedInfo.prices[idx];
      }
    }

    // ── Final settlement ──
    if (closedInfo && closedInfo.closed) {
      const idx   = closedInfo.outcomes.findIndex(o => o === team);
      const final = idx >= 0 ? closedInfo.prices[idx] : 0;
      const won   = final > 0.5;
      const pnl   = expiryPnl(bet, won);
      console.log(`  🏁 SPORTS SETTLE ${won ? "🟢 WIN" : "🔴 LOSS"} | ${team} $${bet.betSize} | ${won ? "+" : ""}$${pnl.toFixed(2)} | ${bet.marketQuestion?.slice(0, 45)}`);
      closeBet(bet.marketConditionId, { exitPrice: won ? 1 : 0, reason: "expiry", pnl });
      exits.push({ team, pnl, won, reason: "expiry" });
      continue;
    }

    if (curPrice === null) continue; // can't price it this scan — try next

    const movePct = (curPrice - bet.entryPrice) / bet.entryPrice;

    // Live mode: positions ride to resolution (no real sell orders placed)
    if (!DRY_RUN) {
      console.log(`  📊 LIVE HOLD ${team} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(curPrice*100).toFixed(0)}¢ (${movePct>=0?"+":""}${(movePct*100).toFixed(1)}%) — holding to resolution`);
      continue;
    }

    if (movePct >= TP_PCT) {
      const { exitPrice, pnl } = earlyExit(bet, curPrice);
      console.log(`  🎯 SPORTS EXIT [TAKE_PROFIT] 🟢 | ${team} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(exitPrice*100).toFixed(0)}¢ | +$${pnl.toFixed(2)}`);
      closeBet(bet.marketConditionId, { exitPrice, reason: "take_profit", pnl });
      exits.push({ team, pnl, won: pnl > 0, reason: "take_profit" });
    } else if (movePct <= -SL_PCT) {
      const { exitPrice, pnl } = earlyExit(bet, curPrice);
      console.log(`  🎯 SPORTS EXIT [STOP_LOSS] 🔴 | ${team} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(exitPrice*100).toFixed(0)}¢ | -$${Math.abs(pnl).toFixed(2)}`);
      closeBet(bet.marketConditionId, { exitPrice, reason: "stop_loss", pnl });
      exits.push({ team, pnl, won: false, reason: "stop_loss" });
    } else {
      console.log(`  📊 HOLD ⚽ ${team.slice(0,14).padEnd(14)} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(curPrice*100).toFixed(0)}¢ | Δ${movePct>=0?"+":""}${(movePct*100).toFixed(1)}%`);
    }
  }
  return exits;
}

// ── Main scan ───────────────────────────────────────────────────
export async function runScanCycle() {
  const balance = getDryBalance();
  const stats   = getStats();

  console.log(`\n── SPORTS SCAN ${new Date().toISOString()} ──`);
  console.log(`💰 Balance: $${Number(balance).toFixed(2)} | Active: ${stats.activeBets}/${MAX_CONC} | P&L: $${stats.pnl}`);

  let markets;
  try {
    markets = await fetchSportsMarkets();
  } catch (err) {
    console.error("Sports fetch error:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  console.log(`📊 Gamma sports: ${markets.length} moneyline markets in next 36h`);

  // ── Exits first ──
  const exits = await processExits(markets);

  // ── Entries: strongest favorites first ──
  let betsPlaced = 0;
  const candidates = markets
    .map(m => {
      const favIdx = m.prices[0] >= m.prices[1] ? 0 : 1;
      return { m, favIdx, favPrice: m.prices[favIdx], team: m.outcomes[favIdx] };
    })
    .filter(c => c.favPrice >= FAV_MIN && c.favPrice <= FAV_MAX)
    .filter(c => c.m.endMs && (c.m.endMs - Date.now()) / 60000 > MIN_MINS_LEFT)
    .sort((a, b) => b.favPrice - a.favPrice);

  if (candidates.length) {
    console.log(`🏆 ${candidates.length} favorites in ${(FAV_MIN*100).toFixed(0)}-${(FAV_MAX*100).toFixed(0)}¢ range. Top: ${candidates.slice(0,3).map(c => `${c.team} ${(c.favPrice*100).toFixed(0)}¢`).join(" · ")}`);
  }

  for (const c of candidates) {
    if (betsPlaced >= ENTRIES_SCAN) break;
    if (getAllActiveBets().length >= MAX_CONC) break;
    if (getDryBalance() < BET_MIN) { console.log("  ⏸ Balance below min bet"); break; }
    if (hasActiveBet(c.m.conditionId)) continue;

    const q = c.m.question.toLowerCase().trim();
    if (getAllActiveBets().some(b => (b.marketQuestion || "").toLowerCase().includes(q))) continue;

    const betSize = Math.min(BET_SIZE, BET_MAX, Math.max(BET_MIN, BET_SIZE));
    const sport   = sportOf(c.m);
    const tokenId = c.m.tokens[c.favIdx];
    if (!tokenId) continue;

    try {
      const order = await placeOrder({
        tokenId, side: "BUY", size: betSize, price: c.favPrice,
        marketQuestion: `${c.team} ML — ${c.m.question}`,
      });

      recordBet({
        market: { ...c.m, question: `${c.team} ML — ${c.m.question}` },
        side: "YES",
        betSize,
        edge: 0,
        trueProbability: c.favPrice,
        impliedProbability: c.favPrice,
        orderId: order.orderID || order.id,
        entryPrice: c.favPrice,
        strategy: "SPORTS_ML",
        reasoning: `⚽ Favorite ML | ${sport} | ${c.team} @ ${(c.favPrice*100).toFixed(0)}¢ | flat $${betSize}`,
        entryBtcPrice: null,
        entryCoin: sport,
        sharpShooter: false,
        valueBet: false,
        strike: null,
        direction: c.team,
      });

      betsPlaced++;
      const mins = ((c.m.endMs - Date.now()) / 60000).toFixed(0);
      console.log(`  ✅ ENTRY ${sport} | ${c.team} $${betSize} @ ${(c.favPrice*100).toFixed(1)}¢ | ends ${mins}min | ${c.m.question.slice(0, 45)}`);
    } catch (err) {
      console.error(`  ❌ Sports order failed: ${err.message}`);
    }
  }

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
  return { signals: null, exits, betsPlaced };
}
