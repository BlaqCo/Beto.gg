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

const everBet = new Set();  // slugs bet at least once — never re-enter
const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ──────────────────────────────────────────────────────
const BET_SIZE      = 15;      // flat $15 per bet
const BET_MIN       = 15;
const FAV_MIN       = 0.60;    // PRODUCTION: 60¢ minimum favorite
const FAV_MAX       = 0.74;    // PRODUCTION: 74¢ maximum favorite
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
        return null; // PRODUCTION: reject wide spreads — poor liquidity, bad fills
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

  // Fetch positions already held on Polymarket (prevents double-betting).
  // FAIL-OPEN: if this fails, proceed with what the bot's own state knows
  // (hasActiveBet) rather than silently skipping every entry.
  let ownedSlugs = new Set();
  if (!DRY_RUN && candidates.length) {
    try {
      const positions = await getOpenPositions();
      ownedSlugs = new Set((positions || []).map(p => p.slug || p.marketSlug || p.market?.slug).filter(Boolean));
    } catch (e) {
      console.log(`  ⚠️ Positions fetch failed (${e.message}) — proceeding with bot-state dedupe only`);
    }
  }

  // ── ONE BET PER MARKET, EVER (no stacking) ──
  // Permanent per-process record of every slug the bot has entered, seeded
  // from active bets each scan. Third layer on top of hasActiveBet + ownedSlugs.
  for (const b of getAllActiveBets()) everBet.add(b.slug);

  let entryErrors = 0;
  for (const m of candidates) {
    if (betsPlaced >= ENTRIES_SCAN || attempts >= MAX_ATTEMPTS) break;
    if (getAllActiveBets().length >= MAX_CONC) break;
    if (balance < BET_MIN) { console.log("  ⏸ Balance below $" + BET_MIN); break; }
    if (everBet.has(m.slug)) continue;                 // already bet this market — never stack
    if (hasActiveBet(m.slug)) continue;
    if (!DRY_RUN && ownedSlugs.has(m.slug)) {
      console.log(`  ⏭ Already holding ${m.slug.slice(0, 24)} on Polymarket`);
      continue;
    }

    // ── ARMORED: one candidate failing can NEVER kill the rest of the loop ──
    try {

    let entryPrice = m.ask;
    let betSize    = BET_SIZE;
    let orderId    = `dry_${Date.now()}`;

    // ── Book-state check (ADVISORY, fail-open) ──
    // Only hard-skip on EXPLICIT dead states. If the endpoint errors or the
    // shape is unknown, proceed — the FOK order is self-protecting: it either
    // fills at our price on a live book or does nothing.
    const book = await getBookState(m.slug);
    const st = String(book.state || "").toUpperCase();
    if (/EXPIRED|TERMINATED|RESOLVED|SETTLED|CLOSED|HALT|SUSPEND|PAUSED|CANCEL/.test(st)) {
      console.log(`  ⛔ Dead market (state=${st}) | ${m.question?.slice(0, 40)}`);
      continue;
    }
    if (!/OPEN/.test(st)) {
      console.log(`  ⚠️ Book state=${st || "?"} — proceeding, FOK protects | ${m.question?.slice(0, 35)}`);
    }
    // Use live book ask if available (fresher than BBO from seconds ago)
    if (book.bestAsk && book.bestAsk > 0.01 && book.bestAsk < 0.99) {
      entryPrice = book.bestAsk;
      m.ask = book.bestAsk;
    }
    console.log(`  ✅ Attempting entry | ask=${cents(m.ask)}${book.askQty ? ` askQty=${book.askQty}` : ""} | ${m.question?.slice(0, 40)}`);

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

    everBet.add(m.slug);   // permanent: this market can never be bet again
    betsPlaced++;
    const payout = (betSize / entryPrice).toFixed(2);
    console.log(`  ✅ ENTRY${DRY_RUN ? "" : " 🔴LIVE"} ${league} $${betSize} @ ${cents(entryPrice)} | win → $${payout} | ${game.slice(0, 46)}`);
    } catch (err) {
      entryErrors++;
      console.log(`  💥 Entry error [${m.slug?.slice(0,28)}]: ${err.message} — continuing to next candidate`);
      continue;
    }
  }

  console.log(`📋 ENTRY SUMMARY: candidates=${candidates.length} attempted=${attempts} placed=${betsPlaced} errors=${entryErrors} activeSlots=${getAllActiveBets().length}/${MAX_CONC} balance=$${balance.toFixed(2)}`);

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
  return { signals: null, exits, betsPlaced };
}
