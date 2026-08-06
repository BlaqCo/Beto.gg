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
import { fetchSportsMoneylines, getBBO, getSettlement, getBookState, buyYesMaker,
         buyYesFOK, getBuyingPower, getOpenPositions, closePositionLive,
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
    const midPx = (parseInt(bucket) + 2) / 100;          // bucket midpoint price
    const stake = 10, contracts = stake / midPx;
    const fee   = 0.03 * contracts * Math.min(midPx, 1 - midPx);
    const be    = (stake + fee) / contracts;              // true break-even win rate
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
const BET_SIZE      = 3;       // flat $3 per bet
const BET_MIN       = 3;
const FAV_MIN       = 0.58;    // band floor: 58¢
const FAV_MAX       = 0.74;    // band cap: 74¢
const FEE_COEF      = 0.03;    // VERIFIED from order ticket: fee = coef × contracts × min(p,1-p)
// $10 @ 48% → 20.20 contracts → $0.30 fee  ⇒  0.03 × 20.20 × 0.48 = $0.29 ✓
const feeFor = (px, sizeUsd) => FEE_COEF * (sizeUsd / Math.max(px, 0.01)) * Math.min(px, 1 - px);
const MAX_CONC      = 2;       // 2 concurrent bets MAX
// ── LEAGUE FOCUS: bet ONLY these leagues. Empty [] = all leagues.
// Fill from calibration data, e.g. ["MLB","ATP","CRICKET"] once the
// 📐 table shows which leagues actually beat their break-even.
// TENNIS + TABLE TENNIS ONLY. Matched loosely so every label variant is
// caught: TENNIS, TABLE-TENNIS, ATP, WTA, ITF (itfme/itfwo), CHALLENGER,
// SETKA/TT (table-tennis feeds). Empty [] would mean all leagues.
const LEAGUE_FOCUS  = [];      // ALL sports/markets allowed
// ── DISCOUNT GATE: live entries must be ≥ this much BELOW the pre-game
// reference price (fee ~2% + 2¢ margin). Buying favorites at a discount to
// their opener is the structural edge condition.
const DISCOUNT_MIN  = 0.01;   // live entries: ≥1¢ below high-water (pre-game exempt)
const MAKER_MODE    = true;   // post at midpoint (cheaper, no taker fee) before paying the ask
const MAKER_WAIT_MS = 20000;  // how long a resting order waits before cancel
const QUOTE_HOLD_MS = 15000;  // ~1 scan cycle: price must be seen twice
const QUOTE_TOL     = 0.05;   // tolerance between sightings (scans are ~18s apart;
                              // 2¢ was tighter than normal drift, so nothing ever confirmed)
const quoteSeen     = new Map(); // slug → { px, since }
// ── DCA / ADD-ON RULES (one add per market, ever) ──
const DCA_ENABLED   = true;   // ON: one add per market, ONLY at a real discount
const DCA_DROP_MIN  = 0.13;   // second buy requires ≥13¢ below entry (69¢ → ≤56¢)
const DCA_ADD_USD   = 3;      // size of the add (matches flat bet)
const DCA_FLOOR_PX  = 0.25;   // never add below this — game is likely decided
// ── TAKE PROFIT: close when unrealized gain hits this % of cost ──
const TP_ENABLED    = true;
const TP_GAIN_PCT   = 0.70;   // +70% on cost (sell price ≥ entry × 1.70)
// ── CIRCUIT BREAKER: hard stop on total account value ──
const KILL_FLOOR    = 50;     // total value (cash + open positions) — below this, NO new bets
let   KILLED        = false;
const addedOn       = new Set(); // slugs that already used their single add
// ── TIER STRATEGY: main-tour tennis is priced by real money; ITF/table
// tennis books are thin and soft (source of the 6-loss cluster). Soft-tier
// markets must clear a much higher liquidity bar to qualify at all.
const TIER_MAIN     = ["ATP","WTA","CHALLENGER","MLB","BASEBALL"];
const SOFT_MIN_QTY  = 500;   // contracts of depth required for soft tier
const MAIN_MIN_QTY  = 100;   // depth required for main tour
const openerRef     = new Map();  // slug → last pre-game price (the "opener")
const ENTRIES_SCAN  = 2;       // aligned with 2-slot cap
const NEXT_DAY_MS   = 48 * 60 * 60 * 1000; // 48h lookahead

// ── Helpers ──────────────────────────────────────────────────────
const shares    = b  => b.betSize / b.entryPrice;
const expiryPnl = (b, won) => {
  const fee = feeFor(b.entryPrice, b.betSize);
  return won ? shares(b) - b.betSize - fee : -(b.betSize + fee);
};
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
// ── ADOPT ORPHAN POSITIONS ───────────────────────────────────────
// Any position in the portfolio that the bot has no record of — manual bets,
// or bets whose record was lost across a redeploy — gets adopted using the
// API's avgPx as its entry price. Once adopted it is monitored, eligible for
// the one-time add-on, and recorded in the calibration ledger on settlement.
async function adoptOrphanPositions() {
  if (DRY_RUN) return;
  try {
    const pos = await getOpenPositions();
    if (!pos) return;
    const known = new Set(getAllActiveBets().map(b => b.marketConditionId));
    for (const [slug, p] of Object.entries(pos)) {
      if (!(p?.qtyBought > 0) || known.has(slug)) continue;
      const entry = p.avgPx;
      if (!entry) { console.log(`  🫥 Orphan ${slug.slice(0,28)} — no avgPx, cannot adopt`); continue; }
      const size = p.cost != null ? +Number(p.cost).toFixed(2) : +(p.qtyBought * entry).toFixed(2);
      recordBet({
        marketConditionId: slug,
        marketQuestion: p.question || slug,
        entryPrice: entry,
        betSize: size,
        strategy: "SPORTS_ML",
        entryCoin: "ADOPTED",
        orderId: `adopted_${Date.now()}`,
      });
      addedOn.add(slug);   // adopted positions don't get an add-on: entry basis is an average, not a single fill
      console.log(`  🧲 ADOPTED position ${slug.slice(0,30)} | entry ${cents(entry)} | $${size}`);
    }
  } catch (e) {
    console.log(`  ⚠️ Orphan adoption skipped: ${e.message}`);
  }
}

async function processExits() {
  const exits = [];
  await adoptOrphanPositions();          // pick up positions the bot didn't record
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

      // ── TAKE PROFIT ──
      // Sell into the BID (what we'd actually receive) once the gain hits target.
      if (TP_ENABLED && !DRY_RUN && bid && bid >= bet.entryPrice * (1 + TP_GAIN_PCT)) {
        const gainPct = (bid - bet.entryPrice) / bet.entryPrice;
        const res = await closePositionLive(slug);
        if (res.ok) {
          const pnl = +(bet.betSize * gainPct).toFixed(2);
          closeBet(slug, { exitPrice: bid, reason: "take_profit", pnl });
          exits.push({ slug, reason: "take_profit", pnl });
          console.log(`  💰 TAKE PROFIT ${cents(bet.entryPrice)}→${cents(bid)} (+${(gainPct*100).toFixed(0)}%) ≈ +$${pnl} | ${bet.marketQuestion?.slice(0, 38)}`);
          continue;
        }
        console.log(`  ⚠️ Take-profit sell failed (${res.error}) — holding`);
      }

      // ── ONE-TIME ADD-ON (DCA) ──
      if (DCA_ENABLED && !DRY_RUN && !addedOn.has(slug)) {
        const ask2 = bbo?.ask;
        // Second buy ONLY if price is ≥DCA_DROP_MIN below our entry and still
        // above the floor. Same price = no add (that was the accidental $30).
        const dip = ask2 && ask2 <= (bet.entryPrice - DCA_DROP_MIN) && ask2 >= DCA_FLOOR_PX;
        if (dip) {
          const addUsd = DCA_ADD_USD;
          // getBuyingPower() returns an OBJECT, not a number (this mismatch
          // crashed processExits and stopped settlements from being recorded).
          const balObj = await getBuyingPower();
          const bal = Number(balObj?.buyingPower ?? balObj?.currentBalance ?? 0);
          if (bal >= addUsd) {
            addedOn.add(slug);   // claim BEFORE ordering — one add, ever
            const r = await buyYesFOK({ slug, sizeUsd: addUsd, ask: ask2,
                                        tick: bet.tick || 0.01, minQty: bet.minQty || 0.01,
                                        allowAddOn: true });
            if (r.filled) {
              console.log(`  ➕ SECOND BUY $${addUsd} @ ${cents(r.fillPrice)} (entry was ${cents(bet.entryPrice)}, −${cents(bet.entryPrice - r.fillPrice)}) | ${bet.marketQuestion?.slice(0, 38)}`);
            } else {
              console.log(`  ➕ Add-on not filled (${r.error})`);
            }
          } else {
            console.log(`  ➕ Add-on skipped — balance $${(Number(bal) || 0).toFixed(2)} < $${addUsd}`);
          }
        }
      }
    } else {
      console.log(`  📊 HOLD ⚽ ${(bet.entryCoin || "SPORT").padEnd(5)} $${bet.betSize} @ ${cents(bet.entryPrice)} | awaiting settlement | ${bet.marketQuestion?.slice(0, 40)}`);
    }
  }
  return exits;
}

// ── Main scan ────────────────────────────────────────────────────
let _scanning = false;
let _lastScanEnd = 0;
const SCAN_MIN_GAP_MS = 15_000; // changelog Jul 1: tiered rate limits (~60 req/min public) — space scans out
export async function runScanCycle() {
  if (Date.now() - _lastScanEnd < SCAN_MIN_GAP_MS) return;
  // ── REENTRANCY GUARD: scans take longer than the 3s interval, so they
  // OVERLAP — two scans both pass "have I bet this?" before either records
  // the bet → double/triple fills. One scan at a time, no exceptions.
  if (_scanning) return;
  _scanning = true;
  try {
    return await _runScanCycleInner();
  } finally {
    _scanning = false;
    _lastScanEnd = Date.now();
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
  
  // Rate-limit hygiene: BBO only for the 60 most promising markets
  // (in-band price estimate first, live first) instead of all 200.
  const prioritized = [...markets].sort((a, b) => {
    const aBand = (a.est >= 0.55 && a.est <= 0.85) ? 0 : 1;
    const bBand = (b.est >= 0.55 && b.est <= 0.85) ? 0 : 1;
    if (aBand !== bBand) return aBand - bBand;
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return 0;
  });
  const candidatePool = prioritized.slice(0, 60);
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
    // ── ENTRY WINDOW: only games starting 4–12 hours from now.
    // Pre-game window entries only; live and near-tipoff games excluded.
    const UPCOMING_MIN_H = 4;
    const UPCOMING_MAX_H = 12;
    // Track opener references: keep updating while pre-game; freeze once live.
    // Reference = HIGH-WATER price seen for this market. "Discount" then means
    // the price has pulled back from its peak — achievable, unlike the old
    // first-sight reference which could never be beaten on first sight.
    for (const m of bbosWithData) {
      if (!m.px) continue;
      const prev = openerRef.get(m.slug);
      if (prev == null || m.px > prev) openerRef.set(m.slug, m.px);
    }
    let discountRejects = 0, thinRejects = 0, windowRejects = 0, bookRejects = 0, flickerRejects = 0;
    const isMainTour = m => TIER_MAIN.some(t => `${m.league||""} ${m.slug||""}`.toUpperCase().includes(t));
    const pool = bbosWithData
      .filter(m => m.px >= FAV_MIN && m.px <= FAV_MAX)
      .filter(m => {
        if (!LEAGUE_FOCUS.length) return true;
        const hay = `${m.league || ""} ${m.slug || ""} ${m.question || ""}`.toUpperCase();
        return LEAGUE_FOCUS.some(t => hay.includes(t));
      })
      .filter(m => {
        // LIVE ONLY: never enter before a match starts.
        if (m.isLive) return true;
        windowRejects++;
        return false;
      })
      .filter(m => {
        // Depth gate by tier — soft books need far more size behind the ask
        const need = isMainTour(m) ? MAIN_MIN_QTY : SOFT_MIN_QTY;
        if (m.askQty != null && m.askQty > 0 && m.askQty < need) { thinRejects++; return false; }
        return true;
      })
      // ── BOOK SANITY: reject stub/fake books (bid 0.03 / ask 0.98 pairs) ──
      .filter(m => {
        // FIX: bid and ask are the SAME side of the book, so they do NOT sum
        // to ~1.00 (a 69¢ market quotes ~65/69 → sum 1.34). The earlier sum
        // check rejected every real market. Correct test: a real two-sided
        // book has bid < ask, a tight gap, and neither side pinned at the rail.
        const bid = m.bid || 0, ask = m.ask || 0;
        if (!(bid > 0.02 && ask < 0.98 && ask > bid && (ask - bid) <= 0.08)) { bookRejects++; return false; }
        return true;
      })
      // ── QUOTE PERSISTENCE: price must hold ~8s before we act on it ──
      .filter(m => {
        const prev = quoteSeen.get(m.slug);
        const now2 = Date.now();
        if (!prev || Math.abs(prev.px - m.px) > QUOTE_TOL) { quoteSeen.set(m.slug, { px: m.px, since: now2 }); flickerRejects++; return false; }
        if (now2 - prev.since < QUOTE_HOLD_MS) { flickerRejects++; return false; }
        return true;
      })
      .filter(m => {
        // Discount applies to LIVE entries only — in-play prices swing, so a
        // pullback is meaningful there. Pre-game window entries are exempt:
        // requiring a dip from high-water blocked everything (prices sit AT
        // their high-water most of the time, so px == ref → permanent reject).
        if (!m.isLive) return true;
        const ref = openerRef.get(m.slug);
        if (ref == null) return true;
        if (m.px <= ref - DISCOUNT_MIN) return true;
        discountRejects++;
        return false;
      })
      .sort((a, b) => {
        const dip = m => { const r = openerRef.get(m.slug); return r == null ? 0 : Math.max(0, r - m.px); };
        const am = isMainTour(a), bm = isMainTour(b);
        if (am !== bm) return am ? -1 : 1;                 // main tour first
        const da = dip(a), db = dip(b);
        if (Math.abs(db - da) >= 0.01) return db - da;     // bigger pullback first
        if (b.isLive !== a.isLive) return b.isLive ? 1 : -1;
        return a.px - b.px;                                // CHEAPEST FIRST (lower band priority)
      });
    if (bookRejects)    console.log(`  📕 Book sanity: ${bookRejects} rejected (stub/one-sided quotes)`);
    if (flickerRejects) console.log(`  ⏳ Quote hold: ${flickerRejects} waiting for price to persist`);
    if (windowRejects) console.log(`  ⏱ Entry window: ${windowRejects} skipped (outside ${UPCOMING_MIN_H}-${UPCOMING_MAX_H}h before start)`);
    if (thinRejects) console.log(`  💧 Depth gate: ${thinRejects} candidates lacked required book depth`);
    if (discountRejects) console.log(`  💹 Discount gate: ${discountRejects} live candidates lacked ≥${(DISCOUNT_MIN*100).toFixed(0)}¢ discount to opener`);
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
  // ── CIRCUIT BREAKER CHECK (before any entry logic) ──
  try {
    const balObj = await getBuyingPower();
    const cash   = Number(balObj?.buyingPower ?? balObj?.currentBalance ?? 0);
    const posAll = await getOpenPositions();
    const posVal = posAll ? Object.values(posAll)
      .reduce((t, p) => t + Number(p.cashValue ?? p.cost ?? 0), 0) : 0;
    const total  = cash + posVal;
    if (total < KILL_FLOOR) {
      if (!KILLED) {
        KILLED = true;
        console.log(`\n🛑🛑 CIRCUIT BREAKER TRIPPED — total $${total.toFixed(2)} below floor $${KILL_FLOOR}`);
        console.log(`🛑 NO NEW BETS. Open positions will still settle. Set KILL_FLOOR lower or redeploy to resume.\n`);
      }
    } else if (!KILLED) {
      console.log(`  🛟 Account total $${total.toFixed(2)} (cash $${cash.toFixed(2)} + positions $${posVal.toFixed(2)}) | floor $${KILL_FLOOR}`);
    }
  } catch (e) {
    console.log(`  ⚠️ Circuit-breaker check failed (${e.message}) — no entries this scan`);
    KILLED = true;
  }
  if (KILLED) {
    console.log(`  🛑 Circuit breaker active — skipping all entries`);
    candidates = [];
  }

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
      let r = null;
      if (MAKER_MODE && m.bid > 0 && m.ask > m.bid) {
        r = await buyYesMaker({ slug: m.slug, sizeUsd: BET_SIZE, bid: m.bid, ask: m.ask,
                                tick: m.tick, minQty: m.minQty, waitMs: MAKER_WAIT_MS });
        if (r.filled) console.log(`  🎯 MAKER FILL @ ${cents(r.fillPrice)} (saved ~${cents(m.ask - r.fillPrice)} vs ask + no taker fee)`);
        else console.log(`  ↩︎ Maker unfilled — ${r.error}`);
      }
      if (!r || !r.filled) {
        // GUARD: never fall back onto a market we may have just filled as maker.
        // A late maker fill + taker fallback = double position (the $30 bug).
        let alreadyHave = false;
        try {
          const posNow = await getOpenPositions();
          alreadyHave = !!(posNow && posNow[m.slug]);
        } catch { alreadyHave = true; }   // can't verify → do NOT risk a second order
        if (alreadyHave) {
          console.log(`  ⛔ Skipping taker fallback — position already exists | ${m.question?.slice(0, 38)}`);
          filledThis = true;              // keep the slug reserved; no second order
          continue;
        }
        r = await buyYesFOK({ slug: m.slug, sizeUsd: BET_SIZE, ask: m.ask, tick: m.tick, minQty: m.minQty });
      }
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
