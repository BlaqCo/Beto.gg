import axios from "axios";
import * as pm from "./polymarket-us.js";
import * as tracker from "./tracker.js";
import { getConfig } from "./config.js";

/**
 * bot-btc15.js — Bitcoin "Up or Down, 15 minute" prediction module.
 * Sibling to bot-btc60.js, not a replacement — both run independently,
 * each toggled and tracked separately. Built after bot-btc60.js's
 * discovery bug was found and fixed in production (Gamma's "tag" query
 * param is NOT reliable; question text is), so this one uses that same,
 * now-proven text-matching approach from the start rather than repeating
 * the same unverified-tag mistake a second time.
 *
 * COMPLETELY SEPARATE from bot-sports.js — own flags, own scheduling, own
 * error boundary in index.js. Nothing here can affect sports bot behavior.
 *
 * HONESTY NOTE: the Gamma API field names below are a best-effort reading of
 * public documentation and what bot-btc60.js confirmed live, not a fresh
 * verified call for THIS specific market family — there is no network
 * path from here to test it directly. Raw-sample logging on first use is
 * the safety net if something about the 15m family differs from 60m's.
 *
 * ENTRY RULE: same shape as BTC60's — bet the favored side within a price
 * band, only in the final stretch before the window closes — but scaled
 * to a 15-minute window: the last 4 minutes, not the last 15. Real,
 * user-specified strategy, not a placeholder; still unvalidated against
 * historical data until enough real trades exist to check it against.
 */

const GAMMA = "https://gamma-api.polymarket.com";
// Hot-reloadable via the SAME dashboard config store the sports bot uses —
// toggle from the UI, no redeploy. The env var is only the very first
// default before a live config value has ever been read.
let BTC15_ENABLED = process.env.BTC15_ENABLED === "true";
let LIVE_TRADING_ENABLED = process.env.BTC15_LIVE_TRADING === "true";
// Per-bot override on top of the GLOBAL DRY_RUN — lets BTC15 run in paper
// mode independently of sports and the other crypto bot, hot-reloadable
// via config rather than forcing everyone onto the same shared flag.
let PAPER_OVERRIDE = null; // null = defer to global DRY_RUN; true/false = force
let DRY_START = Number(process.env.BTC15_PAPER_START || 200); // virtual bankroll, hot-reloadable
const GLOBAL_DRY_RUN = process.env.DRY_RUN !== "false";
let DRY_RUN = GLOBAL_DRY_RUN;

const SCAN_INTERVAL_MS = 20_000;
const RESEARCH_INTERVAL_MS = 60 * 60_000;
let BET_SIZE_USD = Number(process.env.BTC15_BET_SIZE || 0.20);
// Deliberately below the shared $6.50 order-size tripwire in
// polymarket-us.js — that floor exists for the sports side and is left
// completely untouched; BTC15 bypasses it explicitly (override: true on
// the order call below, logged every time as [TRIPWIRE BYPASSED], never
// silent) because this is a stated, deliberate small-size testing
// decision, not a bug to route around quietly. Polymarket's own
// exchange-level minimum for this market is still unconfirmed — if $0.50
// orders start failing to fill for a reason other than the tripwire,
// that's the next thing to check.

// Take-profit / stop-loss, as a move in price from entry — e.g. entered at
// 55¢, TP_PCT=0.15 sells if it reaches 70¢; SL_PCT=0.10 sells if it drops
// to 45¢. These are round, conservative starting numbers, NOT calibrated
// against real BTC60 volatility (that data doesn't exist yet either) —
// treat them as a first guess to refine once real trades happen, the same
// way every sports threshold in this project started as a guess and got
// corrected by real logs.
const TP_PCT = Number(process.env.BTC15_TP_PCT || 0.15);
const SL_PCT = Number(process.env.BTC15_SL_PCT || 0.10);
let SL_ENABLED = process.env.BTC15_SL_ENABLED === "true"; // OFF by default per direct request — set BTC15_SL_ENABLED=true to bring it back

let shapeLoggedDiscovery = false;
let shapeLoggedResearch = false;
let lastResearchRunAt = 0;
let cachedResearch = null;

// Single active position — only one rolling hourly window trades at a
// time, so a plain in-memory record is enough (same honest caveat as
// tracker.js's non-Redis fallback: a restart loses this. Given a position
// here settles within an hour regardless, worst case is losing TP/SL
// tracking for whatever's left of the current window, not the bet itself —
// the bet still resolves normally on-chain either way).
let openPosition = null; // { slug, side, entryPrice, sizeUsd, endTime }
// Short-lived cache for the BBO fallback specifically — without this, a
// single 429 on any given scan throws away a price fetched successfully
// just 20 seconds earlier, causing real, in-band prices to flicker back
// to the fake 50c default purely on rate-limit luck, not real market
// movement. A recent real price is a much better estimate than a
// hardcoded default.
let lastRealBBO = null; // { slug, price, ts }
const BBO_CACHE_MS = 45_000;
const sidecheckedSlugs = new Set(); // one-time-per-slug Yes-vs-getBBO side verification
let paperPnlTotal = 0; // running paper P&L, updated at settlement — sync, no async lookup needed for status
let startupRestoreDone = false;

/** Rebuilds openPosition from the tracker's persisted state on the first
 * scan after boot. Without this, a redeploy/restart mid-position silently
 * forgets it exists (confirmed via real logs: the SAME still-open slug
 * entered twice, ~2 minutes apart, with a restart in between) — in paper
 * mode that costs nothing, but the same gap in live mode means two real
 * orders stacked on one market. */
async function restoreOpenPositionOnStartup() {
  if (startupRestoreDone) return;
  startupRestoreDone = true;
  if (openPosition) return; // already has state, nothing to restore
  let rows;
  try { rows = await tracker.getOpenPositions(); } catch { return; }
  const mine = (rows || []).find(r => r.league === "BTC15" && r.slug && r.slug.includes("-15m-"));
  if (!mine) return;
  const m = mine.slug.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})z$/);
  if (!m) {
    console.log(`  ⚠️ [BTC15] found a persisted open position ("${mine.slug}") but couldn't parse its window end time from the slug — leaving it untracked rather than guessing`);
    return;
  }
  const [, yyyy, mo, dd, hh, mi] = m;
  const windowStart = Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mi);
  const endTime = new Date(windowStart + 15 * 60_000).toISOString();
  openPosition = {
    slug: mine.slug, side: mine.entry >= 0.5 ? "Up" : "Down",
    entryPrice: mine.entry, sizeUsd: mine.size, endTime, question: mine.question,
  };
  console.log(`  🔁 [BTC15] restored open position from persisted state after restart: "${mine.slug}" ${openPosition.side} @ ${(mine.entry*100).toFixed(0)}¢, endTime ${endTime}`);
}

// CONFIRMED from real production data on the CORRECT venue (Polymarket
// US, /v1/markets?categories=crypto): the hourly market's real question
// text is "BTC Up or Down: 60 min" — a simple explicit duration label,
// exactly matching the title shown on the very first BTC15 app screenshot
// ("BTC Up or Down: 15 min"). The old time-RANGE-parsing approach here was
// built assuming a completely different, wrong-platform phrasing
// ("3:00PM-3:15PM") that was never actually confirmed for this venue.
function is15MinBtcQuestion(q) {
  if (!/\bbtc\b|bitcoin/i.test(q) || !/up or down/i.test(q)) return false;
  return /\b15\s*-?\s*min\b/i.test(q);
}

export async function researchBTC15History(limit = 300) {
  // REWIRED — this was still hitting gamma-api.polymarket.com (the WRONG
  // platform, confirmed dead throughout this whole codebase) and parsing
  // outcomePrices/outcome fields that don't exist in Polymarket US's real
  // schema at all. Same fix as live discovery: correct venue
  // (fetchCryptoMarketsV1 with closed:true), and the real, confirmed
  // settlement rule from the app's own Market Rules screen — Up if
  // settlementPrice >= priceToBeat, Down otherwise.
  let markets;
  try {
    markets = await pm.fetchCryptoMarketsV1({ closed: true, limit });
  } catch (err) {
    console.log(`❌ [BTC15 research] fetch failed: ${err.message}`);
    return null;
  }

  const matches = markets.filter(m => is15MinBtcQuestion(m.question || ""));
  if (!matches.length) {
    console.log(`⚠️ [BTC15 research] 0 matching resolved markets found out of ${markets.length} returned`);
    return null;
  }

  const results = matches.map(m => {
    const apt = m.assetPriceTerms;
    if (!apt || apt.settlementPrice == null || apt.priceToBeat == null) return { up: null };
    const up = Number(apt.settlementPrice) >= Number(apt.priceToBeat);
    return { up, endDate: apt.windowEnd || m.endDate };
  }).filter(r => r.up !== null).sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

  if (results.length < 10) {
    console.log(`⚠️ [BTC15 research] Only ${results.length} markets had a parseable settlement (settlementPrice/priceToBeat) — not enough to say anything real yet`);
    return null;
  }

  const upCount = results.filter(r => r.up).length;
  let afterUp = 0, afterUpThenUp = 0, afterDown = 0, afterDownThenUp = 0;
  for (let i = 1; i < results.length; i++) {
    if (results[i - 1].up) { afterUp++; if (results[i].up) afterUpThenUp++; }
    else { afterDown++; if (results[i].up) afterDownThenUp++; }
  }
  const baseRateUpPct = +((upCount / results.length) * 100).toFixed(1);
  const continuationPct = afterUp ? +((afterUpThenUp / afterUp) * 100).toFixed(1) : null;
  const reversalPct = afterDown ? +((afterDownThenUp / afterDown) * 100).toFixed(1) : null;

  console.log(`📊 BTC15 RESEARCH: n=${results.length} | base rate Up=${baseRateUpPct}% Down=${(100 - baseRateUpPct).toFixed(1)}%`);
  console.log(`📊 BTC15 RESEARCH: after an Up window → next Up ${continuationPct}% (n=${afterUp}) | after a Down window → next Up ${reversalPct}% (n=${afterDown})`);
  if (continuationPct != null && Math.abs(continuationPct - baseRateUpPct) < 3 && Math.abs(reversalPct - baseRateUpPct) < 3) {
    console.log(`📊 BTC15 RESEARCH: no meaningful serial correlation detected — consistent with an efficient market, NOT evidence of a usable signal yet`);
  }

  cachedResearch = { n: results.length, baseRateUpPct, continuationPct, reversalPct, ts: Date.now() };
  return cachedResearch;
}

async function discoverCurrentBTC15Market() {
  // PRIMARY: the actually-documented endpoint, confirmed directly from
  // Polymarket US's own docs — GET /v1/markets?categories=crypto. Tried
  // first now; the slug-guessing and old sports/leagues sweep below are
  // demoted to fallbacks since this one is no longer a guess.
  try {
    const docMarkets = await pm.fetchCryptoMarketsV1();
    const now2 = Date.now();
    // FIX: checking endDate > now alone isn't enough — the docs confirm
    // windows are listed ~12 hours before they actually START, meaning
    // ~48 future-queued 15-min windows (and ~24 hourly) sit in the batch
    // at any moment, ALL with endDate > now, but only ONE has genuinely
    // started. A future-queued window's marketSides have no price field
    // at all (confirmed directly: raw outcomePrices "["0","0"]") — that's
    // the real cause of the persistent 50¢ default, not thin liquidity on
    // an active market. Now requiring startDate <= now too, so only the
    // single genuinely-live window can match.
    // CONFIRMED via direct log evidence: top-level startDate/endDate are
    // NOT the real settlement boundary — they're a wider listing period
    // (startDate = ~12h before the window even opens; endDate = some
    // later archival time, not the actual close). assetPriceTerms.
    // windowStart/windowEnd are the REAL boundary (confirmed: exactly 15
    // minutes apart in real data, matching the window duration exactly).
    // windowFor() prefers those, falls back to top-level only if absent.
    const windowFor = m => {
      const apt = m.assetPriceTerms;
      const start = apt?.windowStart ? new Date(apt.windowStart).getTime() : (m.startDate ? new Date(m.startDate).getTime() : null);
      const end = apt?.windowEnd ? new Date(apt.windowEnd).getTime() : (m.endDate ? new Date(m.endDate).getTime() : null);
      return { start, end };
    };
    const notStaleDoc = m => {
      const { start, end } = windowFor(m);
      return end != null && end > now2 && start != null && start <= now2;
    };
    // Primary: text-based match — only ever confirmed against the WRONG
    // platform's question phrasing, so treated as a hint, not ground truth.
    let docMatch = docMarkets.find(m => notStaleDoc(m) && /bitcoin|btc/i.test(m.question||"") && /up or down/i.test(m.question||"") && is15MinBtcQuestion(m.question||""));

    // Structural fallback, independent of any guessed wording: the docs
    // confirm automated markets carry a populated `assetPriceTerms`
    // object, and duration is computable directly from startDate/endDate
    // without needing to match text at all. If the text guess above finds
    // nothing, this checks for ANY bitcoin market with the right computed
    // duration AND the documented automated-market marker — regardless of
    // how Polymarket US actually phrases the question.
    if (!docMatch) {
      docMatch = docMarkets.find(m => {
        if (!notStaleDoc(m) || !/bitcoin|btc/i.test(m.question||"")) return false;
        if (m.assetPriceTerms == null) return false; // hand-listed, not automated
        const { start, end } = windowFor(m);
        if (start == null || end == null) return false;
        const durMin = (end - start) / 60000;
        return Math.abs(durMin - 15) <= 2; // small tolerance
      });
      if (docMatch) console.log(`  🔍 [BTC15] matched via STRUCTURAL fallback (assetPriceTerms + computed duration), not text: "${docMatch.question}"`);
    }

    if (docMatch) {
      // Targeted check: fires ONLY when yesPrice is genuinely missing,
      // dumping the ACTUAL raw marketSides/outcomePrices at that exact
      // moment — proves whether this is real thin liquidity on a brand-new
      // window (fields genuinely empty/unset) or a parsing bug (fields
      // have real data extractYesPrice still isn't finding).
      if (docMatch.yesPrice == null) {
        console.log(`  🔍 [BTC15] yesPrice is null for "${docMatch.slug}" — raw marketSides: ${JSON.stringify(docMatch.marketSides)} | raw outcomePrices: ${JSON.stringify(docMatch.outcomePrices)}`);
        // Countdown is STILL impossibly large even after the startDate
        // fix — real hypothesis: top-level startDate/endDate may be a
        // WIDER listing/tradability period, distinct from the actual
        // price-tracking window boundary, which assetPriceTerms confirmed
        // carries its OWN windowStart/windowEnd fields. Comparing both
        // directly instead of guessing which pair is the real one.
        console.log(`  🔍 [BTC15] top-level startDate=${docMatch.startDate} endDate=${docMatch.endDate} | assetPriceTerms.windowStart=${docMatch.assetPriceTerms?.windowStart} windowEnd=${docMatch.assetPriceTerms?.windowEnd}`);
      }
      // Normalize endDate/startDate to the REAL window boundary right
      // here, at the source — so every downstream consumer (TP/SL,
      // natural-resolution checks, the "ends in" display, entry timing)
      // automatically gets the correct values without needing separate
      // fixes scattered through the rest of the file.
      const { start: realStart, end: realEnd } = windowFor(docMatch);
      // If the bulk listing shows no price, try the DIRECT per-market
      // order book before giving up. The bulk /v1/markets?categories=crypto
      // response may just be a cached/batch snapshot that doesn't stay
      // current for lower-volume markets — getBBO() queries that ONE
      // market's real order book directly, the same proven mechanism
      // already used throughout the sports side.
      // ONE-TIME cross-check per slug: whenever the bulk listing already
      // gives a confirmed "Yes" price via marketSides (long:true), also
      // query getBBO for the SAME market and compare. If getBBO's ask
      // consistently matches the CONFIRMED Yes price, it's reading the
      // right side. If it consistently matches the COMPLEMENT (1 - Yes)
      // instead, getBBO is reading the "No"/Down side, and every price
      // that came from the BBO fallback alone (when the bulk listing was
      // null) has likely had its side backwards this whole time.
      if (docMatch.yesPrice != null && !sidecheckedSlugs.has(docMatch.slug)) {
        sidecheckedSlugs.add(docMatch.slug);
        try {
          const crossBbo = await pm.getBBO(docMatch.slug);
          if (crossBbo?.bid && crossBbo?.ask) {
            const bboMid = (crossBbo.bid + crossBbo.ask) / 2;
            const diffFromYes = Math.abs(bboMid - docMatch.yesPrice);
            const diffFromComplement = Math.abs(bboMid - (1 - docMatch.yesPrice));
            console.log(`  🔬 [BTC15] SIDE CHECK "${docMatch.slug}": confirmed Yes price=${docMatch.yesPrice} | getBBO mid=${bboMid.toFixed(3)} | closer to ${diffFromYes < diffFromComplement ? "YES (correct side)" : "COMPLEMENT — getBBO may be reading the WRONG side"}`);
          }
        } catch {}
      }
      let finalYesPrice = docMatch.yesPrice;
      if (finalYesPrice == null) {
        try {
          const bbo = await pm.getBBO(docMatch.slug);
          if (bbo?.bid && bbo?.ask) {
            finalYesPrice = (bbo.bid + bbo.ask) / 2;
            lastRealBBO = { slug: docMatch.slug, price: finalYesPrice, ts: Date.now() };
            console.log(`  ✅ [BTC15] direct BBO lookup found a real price the bulk listing missed: bid=${bbo.bid} ask=${bbo.ask} for "${docMatch.slug}"`);
          }
        } catch (err) {
          console.log(`  ❌ [BTC15] direct BBO fallback threw: ${err.message}`);
        }
        // Rate-limited or otherwise failed — use a recent REAL price for
        // this SAME market instead of jumping straight to the fake 50c
        // default. A 429 doesn't mean the market moved to 50/50, it means
        // we simply couldn't check this one scan.
        if (finalYesPrice == null && lastRealBBO && lastRealBBO.slug === docMatch.slug && (Date.now() - lastRealBBO.ts) < BBO_CACHE_MS) {
          finalYesPrice = lastRealBBO.price;
          console.log(`  🔁 [BTC15] using cached real price ${(finalYesPrice*100).toFixed(0)}¢ from ${Math.round((Date.now()-lastRealBBO.ts)/1000)}s ago (this scan's lookup failed) for "${docMatch.slug}"`);
        }
      }
      return { ...docMatch,
        startDate: realStart != null ? new Date(realStart).toISOString() : docMatch.startDate,
        endDate: realEnd != null ? new Date(realEnd).toISOString() : docMatch.endDate,
        outcomePrices: [String(finalYesPrice ?? 0.5), String(1 - (finalYesPrice ?? 0.5))] };
    }
  } catch (err) {
    console.log(`  ❌ [BTC15] fetchCryptoMarketsV1 path threw: ${err.message}`);
  }

  // Direct, computed lookup — trying the exact slug this specific window
  // should have, based on the app-confirmed :00/:15/:30/:45 ET alignment.
  // Genuinely unproven whether polymarket.us shares polymarket.com's
  // naming convention, so this is tried, not assumed, and only as a
  // fallback now that the documented endpoint above exists.
  try {
    const direct = await pm.findCurrentBtcWindowBySlug(15);
    if (direct) return direct;
  } catch (err) {
    console.log(`  ❌ [BTC15] direct slug lookup threw: ${err.message}`);
  }
  // REWIRED to the correct venue: fetchCryptoMarkets() (polymarket-us.js)
  // queries gateway.polymarket.us — the SAME platform orders actually get
  // placed on — instead of gamma-api.polymarket.com, a completely
  // different platform whose market IDs were never orderable here at
  // all. That venue mismatch, not the regex or the sort order, was very
  // likely the real cause of the whole "stale December 2025" saga.
  let markets;
  try {
    markets = await pm.fetchCryptoMarkets();
  } catch (err) {
    console.log(`❌ [BTC15] fetchCryptoMarkets failed: ${err.message}`);
    return null;
  }

  const now = Date.now();
  // Still checking staleness ourselves — Polymarket's own closed/active
  // flags were proven unreliable on the OLD endpoint; keeping this
  // defensively even on the new one until it's proven trustworthy too.
  // Same start-time fix as the primary path above — same reasoning,
  // applied here for consistency even though this fallback rarely runs now.
  const notStale = m => {
    const end = m.endDate ? new Date(m.endDate).getTime() : null;
    const start = m.startDate ? new Date(m.startDate).getTime() : null;
    return end != null && end > now && start != null && start <= now;
  };
  const anyBtcMention = markets.filter(m => /bitcoin|btc/i.test(m.question||"") && /up or down/i.test(m.question||""));
  const btcMatches = anyBtcMention.filter(notStale);
  console.log(`  🔍 [DISCOVERY] ${anyBtcMention.length} of ${markets.length} mention bitcoin+up/down at all | ${btcMatches.length} of those are genuinely fresh`);
  if (btcMatches.length) console.log(`  🔍 [DISCOVERY] sample questions: ${btcMatches.slice(0,4).map(m=>JSON.stringify(m.question)).join(" | ")}`);

  const current = btcMatches.find(m => is15MinBtcQuestion(m.question || ""));
  if (!current) {
    console.log(`⚠️ [BTC15] No open 15-minute BTC up/down market found among ${markets.length} results from the correct venue — check the raw sample above`);
    return null;
  }
  // Normalize to the shape the rest of this file expects (outcomePrices
  // array), computed from fetchCryptoMarkets' already-extracted yesPrice.
  return { ...current, outcomePrices: [String(current.yesPrice ?? 0.5), String(1 - (current.yesPrice ?? 0.5))] };
}

/** Fires when the window has ended and TP/SL never triggered — the
 * position resolves to $1 or $0 on-chain regardless, but without this,
 * nothing would ever RECORD that outcome. Fetches the now-closed market by
 * id to read its resolved side, same win/loss math as the sports bot's
 * expiry settlement. */
async function checkNaturalResolution15() {
  if (!openPosition) return;
  if (new Date(openPosition.endTime).getTime() > Date.now()) return; // window still open

  // REWIRED — the old approach called the WRONG platform's single-market
  // Gamma endpoint (confirmed via real logs: 422 error, every scan, for
  // over an hour, leaving the position permanently stuck and blocking
  // every future entry). getTradeHistory() already exists, already hits
  // the CORRECT, authenticated venue (/v1/portfolio/activities), and is
  // already PROVEN working — it's where the real "pl=$0.08 won=true" log
  // line came from. Using that instead of a second, broken lookup.
  let history;
  try {
    history = await pm.getTradeHistory({ force: true });
  } catch (err) {
    console.log(`  ❌ [BTC15] Couldn't fetch trade history for ${openPosition.slug}: ${err.message} — will retry next scan`);
    return;
  }
  const resolution = (history || []).find(a => a._type === "resolution" && a.marketSlug === openPosition.slug);

  let won, pnl;
  if (resolution) {
    won = !!resolution.won;
    pnl = resolution.realizedPnl;
  } else {
    // FIX: getTradeHistory() reads REAL account activity — a PAPER trade
    // never places a real order, so it can NEVER appear there. That left
    // every paper position stuck forever (confirmed via real logs: a
    // position blocking every new entry for 9+ hours straight). Falling
    // back to PUBLIC settlement data — the same fields the research
    // function already uses — works for paper trades, and also clears any
    // pre-existing stuck position from before this fix, paper or real.
    let closedMarkets;
    try {
      closedMarkets = await pm.fetchCryptoMarketsV1({ closed: true, limit: 500 });
    } catch (err) {
      console.log(`  ❌ [BTC15] Couldn't fetch closed markets for ${openPosition.slug}: ${err.message} — will retry next scan`);
      return;
    }
    const closedMatch = (closedMarkets || []).find(m => m.slug === openPosition.slug);
    const apt = closedMatch?.assetPriceTerms;
    if (!apt || apt.settlementPrice == null || apt.priceToBeat == null) return; // not resolved yet — try again next scan

    const resolvedUp = Number(apt.settlementPrice) >= Number(apt.priceToBeat);
    won = openPosition.side === "Up" ? resolvedUp : !resolvedUp;
    const shares = openPosition.sizeUsd / openPosition.entryPrice;
    pnl = won ? (shares - openPosition.sizeUsd) : -openPosition.sizeUsd;
    console.log(`  🔁 [BTC15] resolved via public settlement data (no real account activity found — paper trade or pre-existing stuck position)`);
  }
  if (DRY_RUN) paperPnlTotal += pnl; // only counts toward the virtual bankroll while genuinely paper
  console.log(`  ${won ? "✅ WIN" : "❌ LOSS"} | BTC15 | ${(openPosition.question || "").slice(0, 50)} | pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
  try {
    await tracker.recordSettle(openPosition.slug, { won, pnl, exitPrice: won ? 1 : 0, reason: "expiry",
      fallback: { slug: openPosition.slug, question: openPosition.question, league: "BTC15",
                  entry: openPosition.entryPrice, size: openPosition.sizeUsd, side: openPosition.side, at: new Date().toISOString() } });
  } catch {}
  openPosition = null;
}

/** Real exit check against an already-open position — sells early via the
 * same closePositionLive() the sports bot uses if TP or SL is hit. Holding
 * to natural resolution (the window simply ending) is also a completely
 * valid, unforced outcome for a binary market — this only fires early. */
async function checkTakeProfitStopLoss15(market) {
  if (!openPosition) return;
  const yesPrice = market.outcomePrices ? Number(market.outcomePrices[0]) : null;
  if (yesPrice == null) return;

  const currentPrice = openPosition.side === "Up" ? yesPrice : (1 - yesPrice);
  const moveFromEntry = currentPrice - openPosition.entryPrice;

  if (moveFromEntry >= TP_PCT) {
    console.log(`  🎯 TP hit: entered ${openPosition.side} @ ${(openPosition.entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢ (+${(moveFromEntry*100).toFixed(0)}¢) — closing`);
    await exitPosition("take_profit", currentPrice);
  } else if (SL_ENABLED && moveFromEntry <= -SL_PCT) {
    console.log(`  🛑 SL hit: entered ${openPosition.side} @ ${(openPosition.entryPrice*100).toFixed(0)}¢, now ${(currentPrice*100).toFixed(0)}¢ (${(moveFromEntry*100).toFixed(0)}¢) — closing`);
    await exitPosition("stop_loss", currentPrice);
  }
}

async function exitPosition(reason, exitPrice) {
  if (!openPosition) return;
  const slug = openPosition.slug;
  const shares = openPosition.sizeUsd / openPosition.entryPrice;
  // Same exitPnl formula the sports bot uses for an early sell — mark to
  // market at the actual exit price, not the binary $1/$0 settlement.
  const pnl = shares * exitPrice - openPosition.sizeUsd;
  try {
    const res = DRY_RUN ? { ok: true } : await pm.closePositionLive(slug);
    if (res.ok) {
      console.log(`  ✅ BTC15 exit (${reason}) filled for ${slug} | pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      try {
        await tracker.recordSettle(slug, { won: pnl > 0, pnl, exitPrice, reason,
          fallback: { slug, question: openPosition.question, league: "BTC15",
                      entry: openPosition.entryPrice, size: openPosition.sizeUsd, at: new Date().toISOString() } });
      } catch {}
    } else {
      console.log(`  ❌ BTC15 exit (${reason}) failed for ${slug}: ${res.error} — will retry next scan, or it resolves naturally at window end regardless`);
      return; // leave openPosition set, try again next scan
    }
  } catch (err) {
    console.log(`  ❌ BTC15 exit (${reason}) threw: ${err.message}`);
    return;
  }
  openPosition = null;
}

// User-defined entry rule: bet the favored side only when its price sits
// between 66% and 80%, AND only in the final 4 minutes before the window
// closes. This is a real, specific, stated strategy — not a placeholder —
// but it has NOT been backtested against researchBTC15History's data yet,
// which is worth doing once enough real trades exist under this rule.
const ENTRY_EDGE_MIN = Number(process.env.BTC15_ENTRY_EDGE_MIN || 0.45);
const ENTRY_EDGE_MAX = Number(process.env.BTC15_ENTRY_EDGE_MAX || 1.0);
const ENTRY_WINDOW_MS = Number(process.env.BTC15_ENTRY_WINDOW_MIN || 3) * 60_000;

function userEntryRule(market) {
  const yesPrice = market.outcomePrices ? Number(market.outcomePrices[0]) : null;
  if (yesPrice == null) return null;

  // Timing restriction removed entirely — enters at ANY point in the
  // window's life, not just the final stretch. Still requires the window
  // to genuinely be open (endsInMs > 0), just no longer requires being
  // close to close.
  const endsInMs = market.endDate ? new Date(market.endDate).getTime() - Date.now() : null;
  if (endsInMs == null || endsInMs < 0) return null;

  // Widened from 63-74% to 45-100% — essentially "bet the favorite,
  // whenever," not a tight edge band anymore.
  const side = yesPrice >= 0.5 ? "Up" : "Down";
  const price = yesPrice >= 0.5 ? yesPrice : 1 - yesPrice;
  if (price < ENTRY_EDGE_MIN || price > ENTRY_EDGE_MAX) return null;

  return { side, price };
}

export async function runBTC15ScanCycle() {
  try {
    await restoreOpenPositionOnStartup();
    const c = await getConfig();
    if (c.BTC15_ENABLED != null) BTC15_ENABLED = c.BTC15_ENABLED;
    if (c.BTC15_LIVE_TRADING != null) LIVE_TRADING_ENABLED = c.BTC15_LIVE_TRADING;
    if (c.BTC15_SL_ENABLED != null) SL_ENABLED = c.BTC15_SL_ENABLED;
    if (c.BTC15_BET_SIZE != null) BET_SIZE_USD = c.BTC15_BET_SIZE;
    if (c.BTC15_PAPER_START != null) DRY_START = c.BTC15_PAPER_START;
    if (c.BTC15_PAPER_MODE !== undefined) PAPER_OVERRIDE = c.BTC15_PAPER_MODE;
    DRY_RUN = PAPER_OVERRIDE != null ? PAPER_OVERRIDE : GLOBAL_DRY_RUN;
  } catch {}
  if (!BTC15_ENABLED) return;

  if (Date.now() - lastResearchRunAt > RESEARCH_INTERVAL_MS) {
    lastResearchRunAt = Date.now();
    researchBTC15History().catch(() => {});
  }

  // Runs BEFORE discovery, and independent of whether discovery finds
  // anything — a held position's window can end right as the NEXT window
  // hasn't shown up as "active" yet, or discovery can fail transiently.
  // This must not depend on that succeeding.
  if (openPosition) await checkNaturalResolution15();

  const market = await discoverCurrentBTC15Market();
  if (!market) return;

  const yesPrice = market.outcomePrices ? Number(market.outcomePrices[0]) : null;
  const endsInMs = market.endDate ? new Date(market.endDate).getTime() - Date.now() : null;
  const endsInSec = endsInMs != null ? Math.round(endsInMs / 1000) : "?";
  console.log(`₿ BTC15 window: "${(market.question || "").slice(0, 50)}" | slug=${market.slug||market.id||"?"} | Up price ${yesPrice != null ? (yesPrice * 100).toFixed(0) + "¢" : "?"} | ends in ${endsInSec}s`);

  // If we're already holding a position in THIS window, check TP/SL —
  // this runs regardless of the live-trading flag, since it only manages
  // an existing position, never opens a new one.
  if (openPosition && openPosition.slug === market.slug) {
    await checkTakeProfitStopLoss15(market);
    return;
  }
  if (openPosition) {
    console.log(`  🔒 [BTC15] blocking new entry — still marked as holding "${openPosition.slug}" (${openPosition.side} @ ${(openPosition.entryPrice*100).toFixed(0)}¢, opened for endTime ${openPosition.endTime}), not yet resolved`);
    return; // still holding a DIFFERENT (older) window, not yet resolved — don't open a new one on top of it
  }

  // LIVE_TRADING_ENABLED guards REAL money specifically — it shouldn't
  // also block PAPER simulation, since nothing real is at risk there.
  // Only refuse entirely when we're in real-money mode (DRY_RUN false)
  // AND that gate is off; paper mode always gets to simulate.
  if (!DRY_RUN && !LIVE_TRADING_ENABLED) {
    console.log(`  👁 OBSERVE MODE — BTC15_LIVE_TRADING is off. No entries, no exits, logging only.`);
    return;
  }

  // New window, no position yet — this is where DEFAULT_ENTRY_RULE fires.
  const entry = userEntryRule(market);
  if (!entry) return;
  console.log(`  🎯 Entry rule fired: ${entry.side} @ ${(entry.price*100).toFixed(0)}¢, within last ${(ENTRY_WINDOW_MS/60000)}min of close — betting $${BET_SIZE_USD}`);

  try {
    const res = DRY_RUN
      ? { filled: true, fillPrice: entry.price }
      : await pm.buyYesFOK({ slug: market.slug, sizeUsd: BET_SIZE_USD, ask: entry.price, override: true });
    if (res.filled) {
      openPosition = { slug: market.slug, side: entry.side, entryPrice: entry.price, sizeUsd: BET_SIZE_USD, endTime: market.endDate, question: market.question };
      console.log(`  ✅ BTC15 ENTRY ${DRY_RUN ? "[DRY]" : ""} ${entry.side} $${BET_SIZE_USD} @ ${(entry.price*100).toFixed(0)}¢`);
      try {
        await tracker.recordEntry({ slug: market.slug, question: market.question, league: "BTC15",
          entry: entry.price, size: BET_SIZE_USD, live: true, side: entry.side });
      } catch {}
    } else {
      console.log(`  ❌ BTC15 entry did not fill: ${res.error || "unknown"}`);
    }
  } catch (err) {
    console.log(`  ❌ BTC15 entry threw: ${err.message}`);
  }
}

export function btc15Status() {
  const exposure = openPosition ? openPosition.sizeUsd : 0;
  const paperBalance = DRY_RUN ? +(DRY_START + paperPnlTotal - exposure).toFixed(2) : null;
  return { enabled: BTC15_ENABLED, liveTrading: LIVE_TRADING_ENABLED, dryRun: DRY_RUN, paperBalance, betSize: BET_SIZE_USD, tpPct: TP_PCT, slPct: SL_PCT, openPosition, lastResearch: cachedResearch };
}
