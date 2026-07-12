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

console.log(`🚀 PROCESS START ${new Date().toISOString()} — if you see this line often, the bot is crash-looping`);
const everBet = new Set();  // slugs bet at least once — never re-enter

// ── CALIBRATION LEDGER: realized win rate per league + entry-price bucket ──
// The only way to know WHERE the strategy actually beats the price.
const calib = {};  // key "LEAGUE|64-67" → { w, l }
const calBucket = p => { const c = Math.floor(p * 100 / 4) * 4; return `${c}-${c + 3}`; };
function calRecord(league, entryPrice, won) {
  const key = `${(league || "?").toUpperCase()}|${calBucket(entryPrice)}`;
  (calib[key] ||= { w: 0, l: 0 })[won ? "w" : "l"]++;
}
function calReport() {
  const rows = Object.entries(calib).map(([k, v]) => {
    const [lg, bucket] = k.split("|");
    const n = v.w + v.l, rate = v.w / n;
    const be = (parseInt(bucket) + 2 + 2) / 100; // bucket mid + ~2% fee
    return { lg, bucket, n, rate, be, edge: rate - be };
  }).filter(r => r.n >= 3).sort((a, b) => b.edge - a.edge);
  if (!rows.length) return;
  console.log("📐 CALIBRATION (realized win rate vs break-even):");
  for (const r of rows.slice(0, 12)) {
    const flag = r.edge >= 0 ? "🟢" : "🔴";
    console.log(`  ${flag} ${r.lg} ${r.bucket}¢: ${(r.rate*100).toFixed(0)}% over ${r.n} bets (need ${(r.be*100).toFixed(0)}%) → edge ${(r.edge*100).toFixed(1)}%`);
  }
}
const DRY_RUN = process.env.DRY_RUN !== "false";

// ── Config ──────────────────────────────────────────────────────
const BET_SIZE      = 15;      // flat $15 per bet
const BET_MIN       = 15;
const FAV_MIN       = 0.62;    // raised floor: 62¢ minimum favorite
const FAV_MAX       = 0.78;    // per request: range top 78¢ (break-even at 78¢ ≈ 80% win rate)
const FEE           = 0.02;    // fee estimate on winning payout (bookkeeping)
const MAX_CONC      = 14;      // 14 concurrent slots (set during the $15 era)
// ── LEAGUE FOCUS: bet ONLY these leagues. Empty [] = all leagues.
// Fill from calibration data, e.g. ["MLB","ATP","CRICKET"] once the
// 📐 table shows which leagues actually beat their break-even.
const LEAGUE_FOCUS  = [];
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
      calRecord(league, bet.entryPrice, won);
      calReport();
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
let _scanning = false;
export async function runScanCycle() {
  // ── REENTRANCY GUARD: scans take longer than the 3s interval, so they
  // OVERLAP — two scans both pass "have I bet this?" before either records
  // the bet → double/triple fills. One scan at a time, no exceptions.
  if (_scanning) return;
  _scanning = true;
  try {
    return await _runScanCycleInner();
  } finally {
    _scanning = false;
  }
}

async function _runScanCycleInner() {
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

      // v11: TIGHT spread caps — we pay the ask, so the spread is a direct
      // cost. Old caps (15-30¢) were bleeding up to ~15¢ of edge per entry.
      const maxSpread = m.isLive ? 0.06 : 0.04;

      if (spread > maxSpread) {
        return null; // illiquid book — entering at the ask would burn the edge
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
    // LIVE: live games ALWAYS eligible (even mid-game); pre-game only if
    // starting within 6h so capital isn't parked half a day before tip-off.
    const UPCOMING_MAX_H = 6;
    const pool = bbosWithData
      .filter(m => m.px >= FAV_MIN && m.px <= FAV_MAX)
      .filter(m => !LEAGUE_FOCUS.length || LEAGUE_FOCUS.includes((m.league || "").toUpperCase()))
      .filter(m => m.isLive || m.hoursUntil == null || m.hoursUntil <= UPCOMING_MAX_H)
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
  let slotsUsed  = getAllActiveBets().length;  // bot memory (resets on restart)
  if (!DRY_RUN && candidates.length) {
    // Any slug present in the portfolio = we've bet it. Blacklist ALL keys,
    // regardless of quantity parsing — maximum stacking protection.
    const positions = await getOpenPositions();  // null only on error
    if (positions === null) {
      // FAIL CLOSED: positions are the only restart-proof dedupe layer.
      // Without them we cannot guarantee no stacking → no entries this scan.
      console.log("  🛑 Cannot verify Polymarket positions — NO ENTRIES this scan (anti-stacking)");
      candidates = [];
    } else {
      ownedSlugs = new Set(Object.keys(positions));
      // ── RESTART-PROOF SLOT CAP: slots = REAL open positions on Polymarket.
      // Bot memory resets on every restart; the exchange doesn't. (v13 fix:
      // restarts saw 0/14 and stacked a fresh book on top of the old one.)
      const liveCount = Object.values(positions).filter(p => p.qtyBought > 0).length;
      slotsUsed = Math.max(slotsUsed, liveCount);
      if (ownedSlugs.size) console.log(`  🔒 Holding ${ownedSlugs.size} positions (${liveCount} open) — slots ${slotsUsed}/${MAX_CONC}`);
      if (slotsUsed >= MAX_CONC) {
        console.log(`  ⏸ All ${MAX_CONC} slots filled by REAL positions — no entries until settlements free slots`);
        candidates = [];
      }
    }
  }

  // ── ONE BET PER MARKET, EVER (no stacking) ──
  // Permanent per-process record of every slug the bot has entered, seeded
  // from active bets each scan. Third layer on top of hasActiveBet + ownedSlugs.
  for (const b of getAllActiveBets()) everBet.add(b.slug);

  let entryErrors = 0;
  for (const m of candidates) {
    if (betsPlaced >= ENTRIES_SCAN || attempts >= MAX_ATTEMPTS) break;
    if (slotsUsed + betsPlaced >= MAX_CONC) break;
    if (balance < BET_MIN) { console.log("  ⏸ Balance below $" + BET_MIN); break; }
    if (everBet.has(m.slug)) continue;                 // already bet this market — never stack
    if (hasActiveBet(m.slug)) continue;
    if (!DRY_RUN && ownedSlugs.has(m.slug)) {
      console.log(`  ⏭ Already holding ${m.slug.slice(0, 24)} on Polymarket`);
      continue;
    }

    // ── ARMORED: one candidate failing can NEVER kill the rest of the loop ──
    // RESERVE FIRST: claim this market before any slow API call, so no
    // concurrent code path can order it too. Released only if we don't fill.
    everBet.add(m.slug);
    let filledThis = false;
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
    // ── DEPTH FLOOR: top of book must absorb the whole bet at this price ──
    // Thin books = worst fills and least reliable prices. Skip when we can
    // SEE there isn't enough size (unknown depth stays fail-open, FOK protects).
    const contractsNeeded = Math.floor(BET_SIZE / Math.max(0.01, m.ask));
    if (book.askQty > 0 && book.askQty < contractsNeeded) {
      console.log(`  💧 Thin book (${book.askQty}/${contractsNeeded} contracts) | ${m.question?.slice(0, 38)}`);
      continue;
    }
    // Use live book ask if available (fresher than BBO from seconds ago)
    if (book.bestAsk && book.bestAsk > 0.01 && book.bestAsk < 0.99) {
      entryPrice = book.bestAsk;
      m.ask = book.bestAsk;
    } else {
      // ── STALE-QUOTE SEAL (v15): book couldn't confirm a price, and the
      // scan-start BBO can be minutes old. A FOK limit from a stale price
      // fills BELOW range when a favorite collapses mid-game (the 50-54%
      // entries). Re-fetch a FRESH quote now; it must still be in range.
      const fresh = await getBBO(m.slug);
      if (!fresh?.ask) {
        console.log(`  🚫 No fresh quote available — skipping | ${m.question?.slice(0, 38)}`);
        everBet.delete(m.slug);
        continue;
      }
      entryPrice = fresh.ask;
      m.ask = fresh.ask;
      if (fresh.bid && (fresh.ask - fresh.bid) > 0.06) {
        console.log(`  🚫 Fresh spread ${((fresh.ask - fresh.bid) * 100).toFixed(0)}¢ too wide | ${m.question?.slice(0, 38)}`);
        everBet.delete(m.slug);
        continue;
      }
    }
    // ── FINAL-PRICE REVALIDATION (v14): the live book price must pass the
    // SAME rules the candidate qualified under. Without this, a 67¢ pick
    // whose price spiked to 85¢ between BBO and book got bought at 86¢ —
    // systematically buying tops after moves. Range + spread, re-checked.
    if (entryPrice < FAV_MIN || entryPrice > FAV_MAX) {
      console.log(`  🚫 Price moved out of range (${cents(entryPrice)}) since BBO | ${m.question?.slice(0, 38)}`);
      continue;
    }
    if (book.bestBid && (entryPrice - book.bestBid) > 0.06) {
      console.log(`  🚫 Book spread widened to ${((entryPrice - book.bestBid) * 100).toFixed(0)}¢ | ${m.question?.slice(0, 38)}`);
      continue;
    }
    console.log(`  ✅ Attempting entry | ask=${cents(m.ask)}${book.askQty ? ` askQty=${book.askQty}` : ""} | ${m.question?.slice(0, 40)}`);

    if (!DRY_RUN) {
      attempts++;
      const r = await buyYesFOK({ slug: m.slug, sizeUsd: BET_SIZE, ask: m.ask, tick: m.tick });
      if (!r.filled) {
        console.log(`  ⚠️ Entry not filled (${r.error}) | ${m.question.slice(0, 40)}`);
        everBet.delete(m.slug);  // release reservation — nothing filled
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

    filledThis = true;     // reservation becomes permanent
    betsPlaced++;
    const payout = (betSize / entryPrice).toFixed(2);
    console.log(`  ✅ ENTRY${DRY_RUN ? "" : " 🔴LIVE"} ${league} $${betSize} @ ${cents(entryPrice)} | win → $${payout} | ${game.slice(0, 46)}`);
    } catch (err) {
      entryErrors++;
      console.log(`  💥 Entry error [${m.slug?.slice(0,28)}]: ${err.message} — continuing to next candidate`);
      if (!filledThis) everBet.delete(m.slug);  // release reservation — nothing filled
      continue;
    }
  }

  console.log(`📋 ENTRY SUMMARY: candidates=${candidates.length} attempted=${attempts} placed=${betsPlaced} errors=${entryErrors} activeSlots=${getAllActiveBets().length}/${MAX_CONC} balance=$${balance.toFixed(2)}`);

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
  return { signals: null, exits, betsPlaced };
}
