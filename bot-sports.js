/**
 * bot-sports.js — BETO.GG Sports v4.3 (polymarket.us native)
 *
 * Strategy: BUY YES on moneyline favorites 55-78¢ (live or starting within 12h)
 *           Flat $12 bets. HOLD TO RESOLUTION — no TP/SL, settlement only.
 * DRY:  paper fills at estimated price (no BBO required)
 * LIVE: FOK limit entries via signed REST
 */

// ── NAMESPACE IMPORTS (load-proof) ───────────────────────────────
// Named imports fail the WHOLE module if a single name is missing from the
// source file — that is what produced "sportsBot loaded: false" with no
// usable error. Namespace imports never fail at load; missing pieces are
// reported below instead of silently killing the bot.
import * as state from "./state.js";
import * as pm from "./polymarket-us.js";
import * as cfgStore from "./config.js";
import * as tracker from "./tracker.js";
import * as fees from "./fees.js";
import * as wsFeed from "./ws-feed.js";
import * as model from "./model.js";

// Optional modules — loaded defensively. A missing file here used to throw at
// import time and take the WHOLE bot down ("sportsBot loaded: false"), which
// is invisible unless you catch the boot log. Now the bot runs regardless and
// simply reports what is missing.
let signal = null;
try { signal = await import("./signal.js"); }
catch (e) { console.error(`⚠️ signal.js not loaded (${e.message}) — market-quality scoring disabled, bot continues`); }


const recordBet         = state.recordBet;
const hasActiveBet      = state.hasActiveBet      || (() => false);
const getStats          = state.getStats          || (() => ({ activeBets: 0, pnl: 0 }));
const getAllActiveBets  = state.getAllActiveBets  || (() => []);
const closeBet          = state.closeBet          || (() => {});
const getDryBalance     = state.getDryBalance     || (() => 0);

const fetchSportsMoneylines = pm.fetchSportsMoneylines;
const getBBO                = pm.getBBO;
const getSettlement         = pm.getSettlement;
const getBookState          = pm.getBookState     || (async () => ({ state: "UNKNOWN", isOpen: false }));
const buyYesMaker           = pm.buyYesMaker      || null;   // falls back to taker if absent
const buyYesFOK             = pm.buyYesFOK;
const getBuyingPower        = pm.getBuyingPower;
const getOpenPositions      = pm.getOpenPositions;
const closePositionLive     = pm.closePositionLive || (async () => ({ ok: false, error: "not available" }));
const preflightUS           = pm.preflightUS      || (async () => ({ ok: true, messages: [] }));

// Report anything essential that is missing, loudly, at boot.
{
  const missing = [];
  if (!recordBet)             missing.push("state.recordBet");
  if (!fetchSportsMoneylines) missing.push("polymarket-us.fetchSportsMoneylines");
  if (!getBBO)                missing.push("polymarket-us.getBBO");
  if (!getSettlement)         missing.push("polymarket-us.getSettlement");
  if (!buyYesFOK)             missing.push("polymarket-us.buyYesFOK");
  if (!getBuyingPower)        missing.push("polymarket-us.getBuyingPower");
  if (!getOpenPositions)      missing.push("polymarket-us.getOpenPositions");
  if (missing.length) console.error("❌ MISSING EXPORTS:", missing.join(", "));
  if (!buyYesMaker) console.log("ℹ️ buyYesMaker not found — maker mode will use taker orders");
}

// ══════════════════════════════════════════════════════════════
// VERSION: v13-DRY-SCALED   (paper trading, $500 virtual bankroll)
//   • 7 slots · edge-scaled sizing $20 (58¢) → $30 (70¢)
//   • LIVE only, 10-min trail, near-low entry, fee-aware discount
//   • DCA: −15% from entry → add 50% of the initial bet (once)
//   • Take profit: see TP settings below
// ══════════════════════════════════════════════════════════════
const BOT_VERSION   = "v14-MICRO-LIVE";
console.log(`🚀 ${BOT_VERSION} START ${new Date().toISOString()}`);
const DRY_START     = 500;    // virtual bankroll for paper mode

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
    const be    = fees.breakEven(midPx, false);           // true break-even win rate
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
// Edge-scaled stake: BET_MIN_USD at FAV_MIN, BET_MAX_USD at FAV_MAX, linear.
let BET_LOW_USD   = 7;       // flat $7
let BET_HIGH_USD  = 7;       // flat $7 (no edge scaling)
const sizeForPx = px => {
  const span = Math.max(0.0001, FAV_MAX - FAV_MIN);
  const t = Math.min(1, Math.max(0, (px - FAV_MIN) / span));
  return +(BET_LOW_USD + t * (BET_HIGH_USD - BET_LOW_USD)).toFixed(2);
};
let BET_SIZE      = BET_LOW_USD;   // fallback / minimum reference
let BET_MIN       = BET_LOW_USD;
let FAV_MIN       = 0.55;    // entry floor: 55%
let FAV_MAX       = 0.68;    // entry cap: 68%
// Fee model lives in fees.js — Θ × C × p × (1−p), taker 0.06 / maker −0.0125.
const feeFor = (px, sizeUsd, isMaker = false) =>
  fees.takerFee(sizeUsd / Math.max(px, 0.01), px) * (isMaker ? 0 : 1)
  - (isMaker ? fees.makerRebate(sizeUsd / Math.max(px, 0.01), px) : 0);
let MAX_CONC      = 3;       // 3 concurrent bets MAX
// ── LEAGUE FOCUS: bet ONLY these leagues. Empty [] = all leagues.
// Fill from calibration data, e.g. ["MLB","ATP","CRICKET"] once the
// 📐 table shows which leagues actually beat their break-even.
// TENNIS + TABLE TENNIS ONLY. Matched loosely so every label variant is
// caught: TENNIS, TABLE-TENNIS, ATP, WTA, ITF (itfme/itfwo), CHALLENGER,
// SETKA/TT (table-tennis feeds). Empty [] would mean all leagues.
let LEAGUE_FOCUS  = [];      // all sports allowed — model applies only where it covers
let LEAGUE_BLOCK  = [];      // blacklist — always excluded
// ── DISCOUNT GATE: live entries must be ≥ this much BELOW the pre-game
// reference price (fee ~2% + 2¢ margin). Buying favorites at a discount to
// their opener is the structural edge condition.
// ── FEE-AWARE EDGE MODEL ─────────────────────────────────────────
// Verified from the order ticket: fee = 3% × contracts × min(p, 1−p).
// Per CONTRACT that is 0.03 × min(p,1−p) — i.e. a cost expressed directly
// in price terms: 1.26¢ at 57¢, 1.05¢ at 65¢, 0.78¢ at 74¢.
// (fee coefficient now lives in fees.js)
const feePx = px => fees.costPerContract(px, false);
// An entry must be discounted from its high-water by MORE than the fee it
// costs, plus a margin — otherwise the "edge" is swallowed by the fee.
let EDGE_MARGIN   = 0.01;   // 1¢ of edge required ON TOP of the fee
// Wait this many minutes AFTER tip-off before entering: lets the early
// swing happen so we buy into a settled, informed price rather than the
// opening churn. 0 = enter as soon as the market goes live.
let MIN_LIVE_MIN  = 0;      // superseded by the halfway gate below
// ── HALFWAY GATE ── only enter once a match is at least this far through.
// Progress is read from the live period/score where possible (sets, innings,
// quarters, maps, CS rounds); when that is unavailable we fall back to
// elapsed time against a per-sport typical duration.
// OFF for now: a price set after half the match has been watched by everyone
// is likely SHARPER, not softer. Testing entries without the gate.
let HALFWAY_ONLY  = false;
// PRE-GAME ONLY: skip live markets entirely and buy hours before tip-off.
// Live books are where the fast bots operate; pre-game is thinner and slower.
// ── SELF-LEARNING ── the bot consults its own tracker before betting and
// refuses segments (league or price bucket) that its record shows are losing.
// Needs LEARN_MIN_N settled bets in that segment before it will act.
// ── SIGNAL GATE ── only trade prices the market itself has validated:
// real depth, tight spread, meaningful volume, quote agreeing with trades.
let SIGNAL_ENABLED = true;
let SIGNAL_MIN     = 55;

// ── STATE MODEL ── require the scoreboard to imply a better win probability
// than the price. This is the only non-circular signal in Polymarket's own
// data: the price lags the game state (measured at ~17s, ~7¢).
let MODEL_ENABLED  = true;
let MODEL_EDGE_MIN = 0.03;   // shrunk edge required, on top of the fee

// ── ENDGAME TIMING ── never enter early. Only bet a LIVE match once it is
// past this fraction of typical duration — near the end, not mid-game.
let ENDGAME_ONLY   = true;
let ENDGAME_MIN    = 0.75;   // 0.75 = last quarter of the match

function matchProgressFrac(m) {
  const per = String(m.evPeriod || "").trim();
  const sc  = String(m.evScore  || "").trim();
  let mm;
  if ((mm = per.match(/(\d+)(?:st|nd|rd|th)?\s*set/i)))      return Math.min(1, mm[1] / 3);
  if ((mm = per.match(/(?:top|bot|bottom)?\s*(\d+)(?:st|nd|rd|th)/i))) return Math.min(1, mm[1] / 9);
  if ((mm = per.match(/q(?:uarter)?\s*(\d)/i)))              return Math.min(1, mm[1] / 4);
  if ((mm = per.match(/p(?:eriod)?\s*(\d)/i)))               return Math.min(1, mm[1] / 3);
  if (/2nd half|second half/i.test(per))                       return 0.85;
  if (/1st half|first half/i.test(per))                        return 0.30;
  if ((mm = per.match(/(?:map|game)\s*(\d)/i)))              return Math.min(1, mm[1] / 3);
  if ((mm = sc.match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/))) {
    const lead = Math.max(+mm[1], +mm[2]);
    return lead <= 16 ? Math.min(1, lead / 13) : Math.min(1, (+mm[1] + +mm[2]) / 18);
  }
  if (m.gameStartIso) {
    const mins = (Date.now() - new Date(m.gameStartIso).getTime()) / 60000;
    if (mins < 0) return 0;
    const hay = `${m.league || ""} ${m.slug || ""}`.toUpperCase();
    const typical = /MLB|BASEBALL/.test(hay) ? 180 : /TENNIS|ATP|WTA|ITF/.test(hay) ? 95 : 120;
    return Math.min(1, mins / typical);
  }
  return null;
}

let LEARN_ENABLED = true;
let LEARN_MIN_N   = 12;
let LEARN_CUTOFF  = -4;     // points below break-even that counts as "proven losing"

let PREGAME_ONLY  = false;  // LIVE matches only (see the window filter)
let UPCOMING_MIN  = 0;      // pre-game entries allowed right up to tip-off
let UPCOMING_MAX  = 0;      // 0 = live matches only, no pre-game
let MIN_PROGRESS  = 0.5;

function matchProgress(m) {
  const per = String(m.evPeriod || "").trim();
  const sc  = String(m.evScore  || "").trim();
  let mm;
  // halves first — "2nd Half" would otherwise match the innings pattern
  if (/2nd half|second half|ht|half.?time/i.test(per))         return 0.75;
  if (/1st half|first half/i.test(per))                        return 0.25;
  // tennis / table tennis — "2nd Set"
  if ((mm = per.match(/(\d+)(?:st|nd|rd|th)?\s*set/i)))      return Math.min(1, (+mm[1] - 0.5) / 3);
  // baseball — "Bot 5th" / "Top 7th"
  if ((mm = per.match(/(?:top|bot|bottom)?\s*(\d+)(?:st|nd|rd|th)/i))) return Math.min(1, (+mm[1] - 0.5) / 9);
  // basketball / hockey — "Q3", "3rd Quarter", "P2"
  if ((mm = per.match(/q(?:uarter)?\s*(\d)/i)))              return Math.min(1, (+mm[1] - 0.5) / 4);
  if ((mm = per.match(/p(?:eriod)?\s*(\d)/i)))               return Math.min(1, (+mm[1] - 0.5) / 3);
  // esports — "Map 2" / "Game 3"
  if ((mm = per.match(/(?:map|game)\s*(\d)/i)))              return Math.min(1, (+mm[1] - 0.5) / 3);
  // CS-style round score "13-9" → first to 13
  if ((mm = sc.match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/))) {
    const a = +mm[1], b = +mm[2], lead = Math.max(a, b);
    if (lead <= 16) return Math.min(1, lead / 13);
    return Math.min(1, (a + b) / 18);                          // soccer-ish minutes
  }
  // fallback: elapsed time against a rough typical duration
  if (m.gameStartIso) {
    const mins = (Date.now() - new Date(m.gameStartIso).getTime()) / 60000;
    if (mins < 0) return 0;
    const hay = `${m.league || ""} ${m.slug || ""}`.toUpperCase();
    const typical = /MLB|BASEBALL|NPB|KBO/.test(hay) ? 180
                  : /NBA|BASKETBALL/.test(hay)       ? 135
                  : /NFL|FOOTBALL/.test(hay)         ? 190
                  : /NHL|HOCKEY/.test(hay)           ? 150
                  : /SOCCER|EPL|UCL|LIGA/.test(hay)  ? 105
                  : /CS2|VALORANT|LOL|ESPORT/.test(hay) ? 45
                  : 95;                                        // tennis default
    return Math.min(1, mins / typical);
  }
  return null;
}
// ── PRICE-DRIFT STUDY ────────────────────────────────────────────
// Records each market's price at first sight (pre-game or first live look)
// and compares it to the price at the MIN_LIVE_MIN mark, so we can answer
// empirically: does waiting actually get us cheaper entries?
const driftFirst = new Map();  // slug → { px, t, live }
const liveSince  = new Map();  // slug → timestamp we FIRST saw it live
const lowSeen    = new Map();  // slug → LOWEST price observed while trailing
// Enter only when price is within this much of the trailing low — i.e. near
// the bottom of the range we've watched, not just any pullback.
let NEAR_LOW_TOL  = 0.01;
// Prices at/below this get first claim on slots (cheap-entry priority).
let PRIORITY_PX   = 0.68;   // ≤68¢ gets first claim
const driftStats = { n: 0, sumDelta: 0, cheaper: 0, dearer: 0, sumAbs: 0 };
let DISCOUNT_MIN  = 0.01;   // absolute floor (superseded by fee-aware test)
let MAKER_MODE    = true;   // post at midpoint (cheaper, no taker fee) before paying the ask
const MAKER_WAIT_MS = 20000;  // live: cancel quickly, the price is moving
// Pre-game there is no rush. A resting order that waits minutes is far more
// likely to fill as a MAKER — flipping a ~2.6% fee into a rebate. This is the
// real fee lever, worth ~1.8 points of win rate.
const MAKER_WAIT_PREGAME_MS = 150000;
const QUOTE_HOLD_MS = 15000;  // ~1 scan cycle: price must be seen twice
const QUOTE_TOL     = 0.05;   // tolerance between sightings (scans are ~18s apart;
                              // 2¢ was tighter than normal drift, so nothing ever confirmed)
const quoteSeen     = new Map(); // slug → { px, since }
// ── DCA / ADD-ON RULES (one add per market, ever) ──
// ── TAKE PROFIT: close when unrealized gain hits this % of cost ──
let TP_ENABLED    = false;  // OFF — hold every position to settlement
// NOTE: a +80% GAIN is unreachable in a 58-70¢ band — max possible profit at
// settlement is +72% (58¢) down to +43% (70¢). So gain-mode at 0.80 could
// never fire. Default is PRICE mode: sell when the market reaches 80¢.
const TP_MODE       = "price";  // "price" | "gain"
let TP_PRICE      = 0.95;     // take profit when probability hits 95%
// ── STOP LOSS ── sell if the market collapses to this price.
// OFF: selling at 29¢ returned $3.00 on a position worth $3.25 — a ~$0.25
// spread+fee leak every trigger, plus it forfeits the recoveries. Fee maths
// on this exchange favours holding to settlement.
let SL_ENABLED    = false;
let SL_PRICE      = 0.29;
let TP_GAIN_PCT   = 0.80;     // gain mode: +80% on cost (see note)
// ── CIRCUIT BREAKER: hard stop on total account value ──
let KILL_ENABLED  = false;  // circuit breaker OFF
let KILL_FLOOR    = 120;    // total value (cash + open positions) — below this, NO new bets
let   KILLED        = false;
// ── TIER STRATEGY: main-tour tennis is priced by real money; ITF/table
// tennis books are thin and soft (source of the 6-loss cluster). Soft-tier
// markets must clear a much higher liquidity bar to qualify at all.
const TIER_MAIN     = ["ATP","WTA","CHALLENGER","MLB","BASEBALL"];
const SOFT_MIN_QTY  = 500;   // contracts of depth required for soft tier
const MAIN_MIN_QTY  = 100;   // depth required for main tour
const openerRef     = new Map();  // slug → last pre-game price (the "opener")
let ENTRIES_SCAN  = 3;       // aligned with 3-slot cap
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
    // Prefer the streamed price for exit checks — a 20s poll can miss a stop.
    const streamed = wsFeed.livePrice(slug);
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

      // Pass the outcome EXPLICITLY. Previously only pnl/exitPrice went through
      // and state.js had to infer it — which is how 116W/0L happened.
      closeBet(slug, { exitPrice: settle, reason: "expiry", pnl,
                       won, status: won ? "won" : "lost", result: won ? "win" : "loss" });
      try {
        tracker.recordSettle(slug, { won, pnl, exitPrice: settle, reason: "expiry",
          fallback: { slug, question: bet.marketQuestion, league,
                      entry: bet.entryPrice, size: bet.betSize, at: bet.placedAt } });
      } catch {}
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

      // ── STOP LOSS ── the market has collapsed; cut it.
      const exitBid = (streamed?.bid != null) ? streamed.bid : bid;
      if (SL_ENABLED && !DRY_RUN_SELL_GUARD && exitBid && exitBid <= SL_PRICE) {
        const bid = exitBid;
        const shares = bet.betSize / bet.entryPrice;
        const pnl = +(shares * bid - bet.betSize).toFixed(2);
        const res = DRY_RUN ? { ok: true } : await closePositionLive(slug);
        if (res.ok) {
          closeBet(slug, { exitPrice: bid, reason: "stop_loss", pnl,
                           won: false, status: "lost", result: "loss" });
          try {
            tracker.recordSettle(slug, { won: false, pnl, exitPrice: bid, reason: "stop_loss",
              fallback: { slug, question: bet.marketQuestion, league: (bet.entryCoin || "SPORT").toUpperCase(),
                          entry: bet.entryPrice, size: bet.betSize, at: bet.placedAt } });
          } catch {}
          exits.push({ slug, reason: "stop_loss", pnl });
          console.log(`  🛑 STOP LOSS ${cents(bet.entryPrice)}→${cents(bid)} = $${pnl} | ${bet.marketQuestion?.slice(0, 38)}`);
          continue;
        }
        console.log(`  ⚠️ Stop-loss sell failed (${res.error}) — holding`);
      }

      // ── TAKE PROFIT ──
      // Sell into the BID (what we'd actually receive) once the gain hits target.
      const tpBid = (streamed?.bid != null) ? streamed.bid : bid;
      const tpHit = tpBid && (TP_MODE === "price"
        ? tpBid >= TP_PRICE
        : tpBid >= bet.entryPrice * (1 + TP_GAIN_PCT));
      if (TP_ENABLED && tpHit) {
        const gainPct = (bid - bet.entryPrice) / bet.entryPrice;
        const res = DRY_RUN ? { ok: true } : await closePositionLive(slug);
        if (res.ok) {
          const pnl = +(bet.betSize * gainPct).toFixed(2);
          closeBet(slug, { exitPrice: bid, reason: "take_profit", pnl,
                           won: pnl > 0, status: pnl > 0 ? "won" : "lost", result: pnl > 0 ? "win" : "loss" });
          try {
            tracker.recordSettle(slug, { won: pnl > 0, pnl, exitPrice: bid, reason: "take_profit",
              fallback: { slug, question: bet.marketQuestion, league: (bet.entryCoin || "SPORT").toUpperCase(),
                          entry: bet.entryPrice, size: bet.betSize, at: bet.placedAt } });
          } catch {}
          exits.push({ slug, reason: "take_profit", pnl });
          console.log(`  💰 TAKE PROFIT ${cents(bet.entryPrice)}→${cents(bid)} (+${(gainPct*100).toFixed(0)}%) ≈ +$${pnl} | ${bet.marketQuestion?.slice(0, 38)}`);
          continue;
        }
        console.log(`  ⚠️ Take-profit sell failed (${res.error}) — holding`);
      }

      // (DCA removed — one bet per market, no averaging down)
      console.log(`  📊 HOLD ⚽ ${(bet.entryCoin || "SPORT").padEnd(5)} $${bet.betSize} @ ${cents(bet.entryPrice)} | awaiting settlement | ${bet.marketQuestion?.slice(0, 40)}`);
    }
  }
  return exits;
}

// ── Main scan ────────────────────────────────────────────────────
// ── LIVE CONFIG: re-read every scan so dashboard edits apply within one
// cycle. No redeploy, no lost calibration ledger.
let PAUSED = false;
const DRY_RUN_SELL_GUARD = false;   // paper mode still simulates exits
async function applyLiveConfig() {
  try {
    const c = await cfgStore.getConfig();
    if (!c) return;
    if (c.BET_SIZE      != null) { BET_SIZE = c.BET_SIZE; BET_MIN = c.BET_SIZE;
                                   BET_LOW_USD = c.BET_SIZE; BET_HIGH_USD = c.BET_SIZE; }
    if (c.MAX_CONC      != null) MAX_CONC      = c.MAX_CONC;
    if (c.ENTRIES_SCAN  != null) ENTRIES_SCAN  = c.ENTRIES_SCAN;
    if (c.FAV_MIN       != null) FAV_MIN       = c.FAV_MIN;
    if (c.FAV_MAX       != null) FAV_MAX       = c.FAV_MAX;
    if (c.PRIORITY_PX   != null) PRIORITY_PX   = c.PRIORITY_PX;
    if (c.EDGE_MARGIN   != null) EDGE_MARGIN   = c.EDGE_MARGIN;
    if (c.NEAR_LOW_TOL  != null) NEAR_LOW_TOL  = c.NEAR_LOW_TOL;
    if (c.MIN_LIVE_MIN  != null) MIN_LIVE_MIN  = c.MIN_LIVE_MIN;
    if (c.MAKER_MODE    != null) MAKER_MODE    = c.MAKER_MODE;
    if (c.TP_ENABLED    != null) TP_ENABLED    = c.TP_ENABLED;
    if (c.TP_PRICE      != null) TP_PRICE      = c.TP_PRICE;
    if (c.SL_ENABLED    != null) SL_ENABLED    = c.SL_ENABLED;
    if (c.SL_PRICE      != null) SL_PRICE      = c.SL_PRICE;
    if (c.HALFWAY_ONLY  != null) HALFWAY_ONLY  = c.HALFWAY_ONLY;
    if (c.PREGAME_ONLY  != null) PREGAME_ONLY  = c.PREGAME_ONLY;
    if (c.ENDGAME_ONLY  != null) ENDGAME_ONLY  = c.ENDGAME_ONLY;
    if (c.ENDGAME_MIN   != null) ENDGAME_MIN   = c.ENDGAME_MIN;
    if (c.LEARN_ENABLED != null) LEARN_ENABLED = c.LEARN_ENABLED;
    if (c.MODEL_ENABLED != null) MODEL_ENABLED = c.MODEL_ENABLED;
    if (c.MODEL_EDGE_MIN != null) MODEL_EDGE_MIN = c.MODEL_EDGE_MIN;
    if (c.SIGNAL_ENABLED != null) SIGNAL_ENABLED = c.SIGNAL_ENABLED;
    if (c.SIGNAL_MIN     != null) SIGNAL_MIN     = c.SIGNAL_MIN;
    if (c.LEARN_MIN_N   != null) LEARN_MIN_N   = c.LEARN_MIN_N;
    if (c.UPCOMING_MIN  != null) UPCOMING_MIN  = c.UPCOMING_MIN;
    if (c.UPCOMING_MAX  != null) UPCOMING_MAX  = c.UPCOMING_MAX;
    if (c.MIN_PROGRESS  != null) MIN_PROGRESS  = c.MIN_PROGRESS;
    if (c.KILL_ENABLED  != null) KILL_ENABLED  = c.KILL_ENABLED;
    if (c.KILL_FLOOR    != null) KILL_FLOOR    = c.KILL_FLOOR;
    if (Array.isArray(c.LEAGUE_FOCUS)) LEAGUE_FOCUS = c.LEAGUE_FOCUS;
    if (Array.isArray(c.LEAGUE_BLOCK)) LEAGUE_BLOCK = c.LEAGUE_BLOCK;
    PAUSED = !!c.PAUSED;
  } catch { /* keep last-known config */ }
}

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
  await applyLiveConfig();
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

  try { wsFeed.setWatchlist(getAllActiveBets().map(b => b.marketConditionId)); } catch {}
  const exits = await processExits();

  // ── Balance ──────────────────────────────────────────────────
  let balance = DRY_RUN
    ? DRY_START + Number(getStats().pnl || 0) - getAllActiveBets().reduce((t, b) => t + (b.betSize || 0), 0)
    : getDryBalance();
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
      return { ...m, ask: bbo.ask, bid: bbo.bid, px: bbo.ask, lastTradePx: bbo.last ?? m.lastTradePx ?? null };
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
    const UPCOMING_MIN_H = UPCOMING_MIN;
    const UPCOMING_MAX_H = UPCOMING_MAX;
    // Track opener references: keep updating while pre-game; freeze once live.
    // Stamp when each market was first observed live (trailing clock) and
    // track the lowest price seen while trailing.
    for (const m of bbosWithData) {
      if (!m.isLive) continue;
      if (!liveSince.has(m.slug)) liveSince.set(m.slug, Date.now());
      if (m.px) {
        const lo = lowSeen.get(m.slug);
        if (lo == null || m.px < lo) lowSeen.set(m.slug, m.px);
      }
    }

    // Price-drift study: stamp first sighting, then measure at the mark.
    for (const m of bbosWithData) {
      if (!m.px) continue;
      const prev = driftFirst.get(m.slug);
      if (!prev) { driftFirst.set(m.slug, { px: m.px, t: Date.now(), live: !!m.isLive, done: false }); continue; }
      if (prev.done || !m.isLive || !m.gameStartIso) continue;
      const mins = (Date.now() - new Date(m.gameStartIso).getTime()) / 60000;
      if (mins >= MIN_LIVE_MIN) {
        prev.done = true;
        const delta = m.px - prev.px;           // negative = cheaper after waiting
        driftStats.n++; driftStats.sumDelta += delta; driftStats.sumAbs += Math.abs(delta);
        if (delta < -0.005) driftStats.cheaper++; else if (delta > 0.005) driftStats.dearer++;
        if (driftStats.n % 10 === 0) {
          const avg = driftStats.sumDelta / driftStats.n * 100;
          const avgAbs = driftStats.sumAbs / driftStats.n * 100;
          console.log(`📉 DRIFT STUDY (n=${driftStats.n}): avg ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}¢ at ${MIN_LIVE_MIN}min | cheaper ${driftStats.cheaper} vs dearer ${driftStats.dearer} | avg swing ${avgAbs.toFixed(2)}¢`);
        }
      }
    }

    // Reference = HIGH-WATER price seen for this market. "Discount" then means
    // the price has pulled back from its peak — achievable, unlike the old
    // first-sight reference which could never be beaten on first sight.
    for (const m of bbosWithData) {
      if (!m.px) continue;
      const prev = openerRef.get(m.slug);
      if (prev == null || m.px > prev) openerRef.set(m.slug, m.px);
    }
    let discountRejects = 0, thinRejects = 0, windowRejects = 0, bookRejects = 0, flickerRejects = 0, earlyRejects = 0, nearLowRejects = 0, sportRejects = 0;
    const isMainTour = m => TIER_MAIN.some(t => `${m.league||""} ${m.slug||""}`.toUpperCase().includes(t));
    const pool = bbosWithData
      .filter(m => m.px >= FAV_MIN && m.px <= FAV_MAX)
      .filter(m => {
        const hay = `${m.league || ""} ${m.slug || ""} ${m.question || ""}`.toUpperCase();
        if (LEAGUE_BLOCK.length && LEAGUE_BLOCK.some(t => hay.includes(t))) { sportRejects++; return false; }
        if (!LEAGUE_FOCUS.length) return true;
        if (LEAGUE_FOCUS.some(t => hay.includes(t))) return true;
        sportRejects++; return false;
      })
      .filter(m => {
        // ENDGAME: a live match only qualifies once it's nearly over.
        if (ENDGAME_ONLY && m.isLive) {
          const frac = matchProgressFrac(m);
          if (frac == null || frac < ENDGAME_MIN) { earlyRejects++; return false; }
          return true;
        }
        // PRE-GAME ONLY: never touch a match that has already started.
        if (PREGAME_ONLY) {
          if (m.isLive) { windowRejects++; return false; }
          if (m.hoursUntil == null) { windowRejects++; return false; }
          if (m.hoursUntil < UPCOMING_MIN_H || m.hoursUntil > UPCOMING_MAX_H) { windowRejects++; return false; }
          return true;
        }
        // LIVE ONLY: never enter before a match starts.
        if (!m.isLive) { windowRejects++; return false; }
        // HALFWAY: wait until the match is at least half played.
        if (HALFWAY_ONLY) {
          const prog = matchProgress(m);
          if (prog == null || prog < MIN_PROGRESS) { earlyRejects++; return false; }
          return true;
        }
        if (MIN_LIVE_MIN <= 0) return true;
        // Minutes of play. Prefer the official start time; fall back to when
        // WE first saw it live (many esports/TT markets carry no start time,
        // and the old code silently skipped the wait for those).
        let mins = null;
        if (m.gameStartIso) {
          const t = new Date(m.gameStartIso).getTime();
          if (!Number.isNaN(t)) mins = (Date.now() - t) / 60000;
        }
        if (mins == null) {
          const seen = liveSince.get(m.slug);
          if (!seen) { liveSince.set(m.slug, Date.now()); earlyRejects++; return false; } // start trailing now
          mins = (Date.now() - seen) / 60000;
        }
        if (mins < MIN_LIVE_MIN) { earlyRejects++; return false; }
        return true;
      })
      .filter(m => {
        // Depth gate by tier — soft books need far more size behind the ask
        const need = isMainTour(m) ? MAIN_MIN_QTY : SOFT_MIN_QTY;
        if (m.askQty != null && m.askQty > 0 && m.askQty < need) {
          thinRejects++;
          if (m.px >= FAV_MIN && m.px <= FAV_MAX) console.log(`  🔬 In-band but thin book: ${m.askQty} contracts (need ${need}) | ${m.question?.slice(0,36)}`);
          return false;
        }
        return true;
      })
      // ── BOOK SANITY: reject stub/fake books (bid 0.03 / ask 0.98 pairs) ──
      .filter(m => {
        // FIX: bid and ask are the SAME side of the book, so they do NOT sum
        // to ~1.00 (a 69¢ market quotes ~65/69 → sum 1.34). The earlier sum
        // check rejected every real market. Correct test: a real two-sided
        // book has bid < ask, a tight gap, and neither side pinned at the rail.
        const bid = m.bid || 0, ask = m.ask || 0;
        if (!(bid > 0.02 && ask < 0.98 && ask > bid && (ask - bid) <= 0.08)) {
          bookRejects++;
          if (m.px >= FAV_MIN && m.px <= FAV_MAX) console.log(`  🔬 In-band but bad book: bid=${bid} ask=${ask} | ${m.question?.slice(0,36)}`);
          return false;
        }
        return true;
      })
      // ── QUOTE PERSISTENCE: price must hold ~8s before we act on it ──
      .filter(m => {
        const prev = quoteSeen.get(m.slug);
        const now2 = Date.now();
        if (!prev || Math.abs(prev.px - m.px) > QUOTE_TOL) {
          quoteSeen.set(m.slug, { px: m.px, since: now2 }); flickerRejects++;
          if (m.px >= FAV_MIN && m.px <= FAV_MAX) console.log(`  🔬 In-band but quote just moved: ${cents(m.px)} | ${m.question?.slice(0,36)}`);
          return false;
        }
        if (now2 - prev.since < QUOTE_HOLD_MS) {
          flickerRejects++;
          if (m.px >= FAV_MIN && m.px <= FAV_MAX) console.log(`  🔬 In-band but quote too fresh (${Math.round((now2-prev.since)/1000)}s held) | ${m.question?.slice(0,36)}`);
          return false;
        }
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
        // Required pullback = fee cost at this price + margin.
        const need = feePx(m.px) + EDGE_MARGIN;
        if (m.px > ref - need) {
          discountRejects++;
          if (m.px >= FAV_MIN && m.px <= FAV_MAX) console.log(`  🔬 In-band but no discount: ${cents(m.px)}, high-water ${cents(ref)}, need ${cents(need)} more | ${m.question?.slice(0,36)}`);
          return false;
        }
        // NEAR-LOW: only buy at/near the bottom of the trailing range.
        const lo = lowSeen.get(m.slug);
        if (lo != null && m.px > lo + NEAR_LOW_TOL) {
          nearLowRejects++;
          if (m.px >= FAV_MIN && m.px <= FAV_MAX) console.log(`  🔬 In-band but above trailing low: ${cents(m.px)} vs low ${cents(lo)} | ${m.question?.slice(0,36)}`);
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        // NET EDGE = pullback from high-water MINUS the fee that price costs.
        // This is the closest thing we have to expected value per contract.
        const netEdge = m => {
          const r = openerRef.get(m.slug);
          const dip = r == null ? 0 : Math.max(0, r - m.px);
          return dip - feePx(m.px);
        };
        // CHEAP-ENTRY PRIORITY: anything at/below PRIORITY_PX ranks first.
        const ap = a.px <= PRIORITY_PX, bp = b.px <= PRIORITY_PX;
        if (ap !== bp) return ap ? -1 : 1;
        const am = isMainTour(a), bm = isMainTour(b);
        if (am !== bm) return am ? -1 : 1;                 // main tour (deep books) first
        const ea = netEdge(a), eb = netEdge(b);
        if (Math.abs(eb - ea) >= 0.005) return eb - ea;    // best fee-adjusted edge first
        if (b.isLive !== a.isLive) return b.isLive ? 1 : -1;
        return a.px - b.px;                                // tie-break: cheaper
      });
    if (sportRejects)   console.log(`  🚷 Sport filter: ${sportRejects} excluded by your sport settings`);
    if (bookRejects)    console.log(`  📕 Book sanity: ${bookRejects} rejected (stub/one-sided quotes)`);
    if (flickerRejects) console.log(`  ⏳ Quote hold: ${flickerRejects} waiting for price to persist`);
    if (nearLowRejects) console.log(`  📍 Not near low: ${nearLowRejects} above trailing low +${(NEAR_LOW_TOL*100).toFixed(0)}¢`);
    if (earlyRejects) console.log(`  🕐 Too early: ${earlyRejects} live match(es) not yet past ${Math.round(ENDGAME_MIN * 100)}% (endgame gate)`);
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
  if (PAUSED) {
    console.log("  ⏸ PAUSED from dashboard — monitoring only, no new bets");
    candidates = [];
  }

  // ── CIRCUIT BREAKER CHECK (before any entry logic) ──
  if (KILL_ENABLED) try {
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
  if (KILL_ENABLED && KILLED) {
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

  let entryErrors = 0, learnSkips = 0, signalSkips = 0, modelSkips = 0;
  for (const m of candidates) {
    if (betsPlaced >= ENTRIES_SCAN || attempts >= MAX_ATTEMPTS) break;
    if (slotsUsed + betsPlaced >= MAX_CONC) break;
    if (balance < BET_MIN) { console.log("  ⏸ Balance below $" + BET_MIN); break; }
    if (everBet.has(m.slug)) continue;                 // already bet this market — never stack

    // ── SIGNAL: is this price trustworthy enough to trade? ──
    if (SIGNAL_ENABLED && signal?.scoreMarket) {
      const sg = signal.scoreMarket(m, null, BET_SIZE);
      m._signal = sg;
      if (sg.score < SIGNAL_MIN) {
        signalSkips++;
        console.log(`  📉 Signal ${sg.score}/${SIGNAL_MIN} (${sg.grade}) — ${sg.reasons.join(", ") || "low quality"} | ${m.question?.slice(0, 30)}`);
        continue;
      }
    }

    // ── STATE MODEL: the scoreboard must justify the price ──
    // Model applies only to leagues it actually covers (MLB, tennis). Other
    // sports were excluded entirely before — "allow all sports" means they
    // now trade on price/edge alone, same as pre-model behaviour, while
    // MLB/tennis get the extra scoreboard confirmation as a bonus filter.
    const leagueUpper = String(m.league || "").toUpperCase();
    const modelCovers = model.MODELLED_LEAGUES.some(l => leagueUpper.includes(l));
    if (MODEL_ENABLED && modelCovers) {
      const sig = model.stateEdge(m, m.ask);
      if (!sig)                      { modelSkips++; continue; }   // no model for this game state
      if (sig.side === "ambiguous")  { modelSkips++; continue; }   // still refuses when truly unresolvable
      if (sig.side === "tied-overpriced") {
        // Confidently rejected: price isn't justified under EITHER home/away
        // assignment. Real signal, not a guess.
        modelSkips++;
        console.log(`  📐 ${sig.reason}`);
        continue;
      }
      if (sig.side === "tied-bestguess") {
        // Betting the more favourable home/away read, per request. Honest
        // flag: which named team is home is a real guess here, not derived
        // baseball math — shrinkage and the edge cap keep a wrong guess cheap.
        console.log(`  📐 ${sig.reason} (best-guess side)`);
      }
      const need = MODEL_EDGE_MIN + fees.costPerContract(m.ask, false);
      if (sig.edge < need) { modelSkips++; continue; }
      m._modelReason = sig.reason;
      m._modelEdge = sig.edge;
    }

    // ── SELF-LEARNING: skip segments our own record says are losing ──
    if (LEARN_ENABLED) {
      try {
        const v = await tracker.shouldSkip(m.league, m.ask, { minN: LEARN_MIN_N, cutoff: LEARN_CUTOFF });
        if (v.skip) { learnSkips++; console.log(`  🧠 Skipping — ${v.why} | ${m.question?.slice(0, 34)}`); continue; }
      } catch {}
    }
    if (hasActiveBet(m.slug)) continue;
    if (!DRY_RUN && ownedSlugs.has(m.slug)) {
      console.log(`  ⏭ Already holding ${m.slug.slice(0, 24)} on Polymarket`);
      continue;
    }

    // ── ARMORED: one candidate failing can NEVER kill the rest of the loop ──
    // RESERVE FIRST: claim this market before any slow API call, so no
    // concurrent code path can order it too. Released only if we don't fill.
    everBet.add(m.slug);
    // Durable claim — survives restarts, which in-memory everBet does not.
    // This is what stopped the same market being bought again after a deploy.
    try {
      const got = await tracker.claimMarket(m.slug);
      if (!got) { console.log(`  🔒 Already claimed (durable lock) | ${m.question?.slice(0, 36)}`); continue; }
    } catch {}
    let filledThis = false;
    let orderSent = false;      // true once ANY order has been transmitted
    try {

    let entryPrice = m.ask;
    let betSize    = sizeForPx(m.ask);
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
        everBet.delete(m.slug); try { tracker.releaseMarket(m.slug); } catch {}
        continue;
      }
      entryPrice = fresh.ask;
      m.ask = fresh.ask;
      if (fresh.bid && (fresh.ask - fresh.bid) > 0.06) {
        console.log(`  🚫 Fresh spread ${((fresh.ask - fresh.bid) * 100).toFixed(0)}¢ too wide | ${m.question?.slice(0, 38)}`);
        everBet.delete(m.slug); try { tracker.releaseMarket(m.slug); } catch {}
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
    if (SIGNAL_ENABLED && signal?.scoreMarket) {
      const sg2 = signal.scoreMarket(m, book, BET_SIZE);
      m._signal = sg2;
      if (sg2.score < SIGNAL_MIN) {
        signalSkips++;
        console.log(`  📉 Signal ${sg2.score}/${SIGNAL_MIN} after depth check — ${sg2.reasons.join(", ")} | ${m.question?.slice(0, 30)}`);
        everBet.delete(m.slug); try { tracker.releaseMarket(m.slug); } catch {}
        continue;
      }
    }
    console.log(`  ✅ Attempting entry | ask=${cents(m.ask)} signal=${m._signal?.score ?? "—"}${m._signal?.grade ? m._signal.grade : ""}${book.askQty ? ` askQty=${book.askQty}` : ""} | ${m.question?.slice(0, 36)}`);

    if (!DRY_RUN) {
      attempts++;
      let r = null;
      orderSent = true;
      if (MAKER_MODE && buyYesMaker && m.bid > 0 && m.ask > m.bid) {
        r = await buyYesMaker({ slug: m.slug, sizeUsd: BET_SIZE, bid: m.bid, ask: m.ask,
                                tick: m.tick, minQty: m.minQty,
                                waitMs: m.isLive ? MAKER_WAIT_MS : MAKER_WAIT_PREGAME_MS });
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
        // KEEP the reservation. An order was sent; a maker fill can still land
        // after we've been told "unfilled", and releasing here is how the same
        // market got bought twice. It stays blocked for this process.
        console.log(`  ⚠️ Entry not filled (${r.error}) — market stays reserved | ${m.question.slice(0, 36)}`);
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
    // Persistent ledger: record WHY this bet was taken, not just that it was.
    try {
      const ref = openerRef.get(m.slug);
      tracker.recordEntry({
        slug: m.slug, question: m.question, league: m.league,
        entry: entryPrice, size: betSize,
        spread: (m.ask != null && m.bid != null) ? m.ask - m.bid : null,
        depth: book?.askQty ?? null,
        discount: ref != null ? ref - entryPrice : null,
        live: !!m.isLive,
        minsIn: m.gameStartIso ? (Date.now() - new Date(m.gameStartIso).getTime()) / 60000 : null,
        maker: !!(r && r.maker),
      });
    } catch {}
    betsPlaced++;
    const payout = (betSize / entryPrice).toFixed(2);
    console.log(`  ✅ ENTRY${DRY_RUN ? "" : " 🔴LIVE"} ${league} $${betSize} @ ${cents(entryPrice)} | win → $${payout} | ${game.slice(0, 40)}`);
    if (m._modelReason) console.log(`     📐 ${m._modelReason} (+${(m._modelEdge * 100).toFixed(1)} pts)`);
    } catch (err) {
      entryErrors++;
      console.log(`  💥 Entry error [${m.slug?.slice(0,28)}]: ${err.message} — continuing to next candidate`);
      // Only release if we never reached the order stage; otherwise a late
      // fill could still exist and re-entry would double the position.
      if (!filledThis && !orderSent) {
        everBet.delete(m.slug);
        try { tracker.releaseMarket(m.slug); } catch {}
      }
      continue;
    }
  }

  try {
    cfgStore.publishFunnel({
      version: BOT_VERSION,
      mode: DRY_RUN ? "PAPER" : "LIVE",
      paused: PAUSED,
      entries: betsPlaced,
      band: [FAV_MIN, FAV_MAX],
      betSize: BET_SIZE,
      slots: { used: getAllActiveBets().length, max: MAX_CONC },
      balance: +Number(balance).toFixed(2),
      stages: [
        { name: "markets",   count: markets.length },
        { name: "priced",    count: bbosWithData.length },
        { name: "candidates",count: candidates.length },
        { name: "entries",   count: betsPlaced },
      ],
      // the board as the bot sees it — powers "what games look promising?"
      watchlist: (bbosWithData || [])
        .filter(m => m.px && m.isLive)
        .map(m => {
          const ref = openerRef.get(m.slug), lo = lowSeen.get(m.slug);
          const inBand = m.px >= FAV_MIN && m.px <= FAV_MAX;
          const dip = ref == null ? 0 : Math.max(0, ref - m.px);
          let blocker = null;
          if (!inBand) blocker = m.px < FAV_MIN ? "below band" : "above band";
          else if (ref != null && m.px > ref - (feePx(m.px) + EDGE_MARGIN)) blocker = "no discount yet";
          else if (lo != null && m.px > lo + NEAR_LOW_TOL) blocker = "above its low";
          return { q: (m.question || m.slug || "").slice(0, 46), league: m.league || "",
                   px: +m.px.toFixed(2), high: ref ? +ref.toFixed(2) : null,
                   low: lo ? +lo.toFixed(2) : null, dip: +dip.toFixed(3), blocker };
        })
        .sort((a, b) => (a.blocker ? 1 : 0) - (b.blocker ? 1 : 0) || b.dip - a.dip)
        .slice(0, 8),
      // why candidates were rejected — powers "why haven't I made any bets?"
      gates: {
        notLive:   typeof windowRejects   !== "undefined" ? windowRejects   : 0,
        tooEarly:  typeof earlyRejects    !== "undefined" ? earlyRejects    : 0,
        badBook:   typeof bookRejects     !== "undefined" ? bookRejects     : 0,
        quoteHold: typeof flickerRejects  !== "undefined" ? flickerRejects  : 0,
        noDiscount:typeof discountRejects !== "undefined" ? discountRejects : 0,
        notNearLow:typeof nearLowRejects  !== "undefined" ? nearLowRejects  : 0,
        thinBook:  typeof thinRejects     !== "undefined" ? thinRejects     : 0,
        sportFilter: typeof sportRejects  !== "undefined" ? sportRejects    : 0,
      },
    });
  } catch {}

  if (signalSkips) console.log(`  📉 Signal gate skipped ${signalSkips} low-quality market(s)`);
  if (modelSkips) console.log(`  📐 State model rejected ${modelSkips} candidate(s) — scoreboard didn't justify the price`);
  if (learnSkips) console.log(`  🧠 Self-learning gate skipped ${learnSkips} candidate(s) from proven-losing segments`);
  console.log(`📋 ENTRY SUMMARY: candidates=${candidates.length} attempted=${attempts} placed=${betsPlaced} errors=${entryErrors} activeSlots=${getAllActiveBets().length}/${MAX_CONC} balance=$${balance.toFixed(2)}`);

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets}/${MAX_CONC} | P&L:$${s.pnl} ──`);
  return { signals: null, exits, betsPlaced };
}
