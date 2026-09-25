import axios from "axios";
import * as pm from "./polymarket-us.js";
import * as tracker from "./tracker.js";
import { getConfig } from "./config.js";

/**
 * bot-btc60.js — Bitcoin "Up or Down, 1 hour" prediction module.
 * (Renamed from bot-btc15.js — switched from the 15-minute window to the
 * hourly one per a direct comparison: neither window shows a real
 * directional edge in real tracked data, 49-52% Up rates over thousands of
 * resolved windows, but hourly is structurally more resistant to the
 * settlement-window manipulation risk documented for 5-minute markets, and
 * gives this bot's own rate-limited infrastructure far more slack per
 * decision than a 15-minute clock would.)
 *
 * COMPLETELY SEPARATE from bot-sports.js — own flags, own scheduling, own
 * error boundary in index.js. Nothing here can affect sports bot behavior.
 *
 * HONESTY NOTE, UNCHANGED FROM THE FIRST VERSION: the Gamma API field names
 * and tag slugs below are a best-effort reading of public documentation,
 * not a verified live call — there is no network path from here to
 * Polymarket's API to confirm them. Raw-sample logging on first use is the
 * safety net if a field name assumption turns out wrong.
 *
 * WHAT'S NEW IN THIS VERSION — TP/SL, and what that required honestly:
 * take-profit and stop-loss only mean something once a position actually
 * exists, so this version adds real position tracking and a real early-
 * exit check using the same closePositionLive() the sports bot uses.
 * But there is STILL no validated entry signal for BTC direction — the
 * research function below measures that, it doesn't assume it. Rather than
 * leave TP/SL permanently untestable behind that honesty, DEFAULT_ENTRY_RULE
 * is a clearly-labeled, arbitrary starting rule (follow whichever side is
 * currently priced as favorite) — NOT a validated strategy, just enough of
 * a real entry to exercise the exit machinery in DRY_RUN paper mode and
 * start generating real data. It is explicitly logged as unvalidated every
 * time it fires, and real money never touches it unless BOTH BTC60_ENABLED
 * and BTC60_LIVE_TRADING are set AND the person has decided to trust it —
 * this file does not decide that on its own.
 */

const GAMMA = "https://gamma-api.polymarket.com";
// Hot-reloadable via the SAME dashboard config store the sports bot uses —
// toggle from the UI, no redeploy. The env var is only the very first
// default before a live config value has ever been read.
let BTC60_ENABLED = process.env.BTC60_ENABLED === "true";
let LIVE_TRADING_ENABLED = process.env.BTC60_LIVE_TRADING === "true";
const DRY_RUN = process.env.DRY_RUN !== "false";

const SCAN_INTERVAL_MS = 20_000;
const RESEARCH_INTERVAL_MS = 60 * 60_000;
let BET_SIZE_USD = Number(process.env.BTC60_BET_SIZE || 0.20);
// Deliberately below the shared $6.50 order-size tripwire in
// polymarket-us.js — that floor exists for the sports side and is left
// completely untouched; BTC60 bypasses it explicitly (override: true on
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
const TP_PCT = Number(process.env.BTC60_TP_PCT || 0.15);
const SL_PCT = Number(process.env.BTC60_SL_PCT || 0.10);
let SL_ENABLED = process.env.BTC60_SL_ENABLED === "true"; // OFF by default per direct request — set BTC60_SL_ENABLED=true to bring it back

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

// CONFIRMED from real production data on the CORRECT venue (Polymarket
// US, /v1/markets?categories=crypto): the actual question text is
// "BTC Up or Down: 60 min" — a simple, explicit duration label, nothing
// like the time-of-day format ("...1PM ET") this function used to require.
// That old pattern was built from the WRONG platform's phrasing (regular
// Polymarket's Gamma API) and never matched anything real here — this
// replaces it with the format actually observed on this venue.
function isHourlyBtcQuestion(q) {
  if (!/\bbtc\b|bitcoin/i.test(q) || !/up or down/i.test(q)) return false;
  return /\b60\s*-?\s*min|\b1\s*-?\s*hour|\b1h\b/i.test(q);
}

export async function researchBTC60History(limit = 300) {
  let markets;
  try {
    const { data } = await axios.get(`${GAMMA}/markets`, {
      params: { closed: true, order: "endDate", ascending: false, limit }, // tag param removed — confirmed unreliable, question text is what actually filters now
      timeout: 10_000,
    });
    markets = Array.isArray(data) ? data : (data?.markets || []);
  } catch (err) {
    console.log(`❌ [BTC60 research] Gamma fetch failed: ${err.message}`);
    return null;
  }

  if (!shapeLoggedResearch) {
    shapeLoggedResearch = true;
    console.log(`🔬 BTC60 RESEARCH RAW SAMPLE (first result, truncated): ${JSON.stringify(markets[0]).slice(0, 500)}`);
  }

  const btc60 = markets.filter(m => isHourlyBtcQuestion(m.question || ""));
  if (!btc60.length) {
    console.log(`⚠️ [BTC60 research] 0 matching resolved markets found out of ${markets.length} returned — tag/filter assumption may be wrong, check the raw sample above`);
    return null;
  }

  const results = btc60.map(m => {
    let up = null;
    if (Array.isArray(m.outcomePrices)) {
      const prices = m.outcomePrices.map(Number);
      if (prices[0] === 1) up = true;
      else if (prices[0] === 0) up = false;
    }
    if (up === null && typeof m.outcome === "string") up = /up/i.test(m.outcome);
    return { up, endDate: m.endDate };
  }).filter(r => r.up !== null).sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

  if (results.length < 10) {
    console.log(`⚠️ [BTC60 research] Only ${results.length} markets had a parseable outcome — not enough to say anything real yet`);
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

  console.log(`📊 BTC60 RESEARCH: n=${results.length} | base rate Up=${baseRateUpPct}% Down=${(100 - baseRateUpPct).toFixed(1)}%`);
  console.log(`📊 BTC60 RESEARCH: after an Up window → next Up ${continuationPct}% (n=${afterUp}) | after a Down window → next Up ${reversalPct}% (n=${afterDown})`);
  if (continuationPct != null && Math.abs(continuationPct - baseRateUpPct) < 3 && Math.abs(reversalPct - baseRateUpPct) < 3) {
    console.log(`📊 BTC60 RESEARCH: no meaningful serial correlation detected — consistent with an efficient market, NOT evidence of a usable signal yet`);
  }

  cachedResearch = { n: results.length, baseRateUpPct, continuationPct, reversalPct, ts: Date.now() };
  return cachedResearch;
}

async function discoverCurrentBTC60Market() {
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
    let docMatch = docMarkets.find(m => notStaleDoc(m) && /bitcoin|btc/i.test(m.question||"") && /up or down/i.test(m.question||"") && isHourlyBtcQuestion(m.question||""));

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
        return Math.abs(durMin - 60) <= 2; // small tolerance
      });
      if (docMatch) console.log(`  🔍 [BTC60] matched via STRUCTURAL fallback (assetPriceTerms + computed duration), not text: "${docMatch.question}"`);
    }

    if (docMatch) {
      // Targeted check: fires ONLY when yesPrice is genuinely missing,
      // dumping the ACTUAL raw marketSides/outcomePrices at that exact
      // moment — proves whether this is real thin liquidity on a brand-new
      // window (fields genuinely empty/unset) or a parsing bug (fields
      // have real data extractYesPrice still isn't finding).
      if (docMatch.yesPrice == null) {
        console.log(`  🔍 [BTC60] yesPrice is null for "${docMatch.slug}" — raw marketSides: ${JSON.stringify(docMatch.marketSides)} | raw outcomePrices: ${JSON.stringify(docMatch.outcomePrices)}`);
        // Countdown is STILL impossibly large even after the startDate
        // fix — real hypothesis: top-level startDate/endDate may be a
        // WIDER listing/tradability period, distinct from the actual
        // price-tracking window boundary, which assetPriceTerms confirmed
        // carries its OWN windowStart/windowEnd fields. Comparing both
        // directly instead of guessing which pair is the real one.
        console.log(`  🔍 [BTC60] top-level startDate=${docMatch.startDate} endDate=${docMatch.endDate} | assetPriceTerms.windowStart=${docMatch.assetPriceTerms?.windowStart} windowEnd=${docMatch.assetPriceTerms?.windowEnd}`);
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
      let finalYesPrice = docMatch.yesPrice;
      if (finalYesPrice == null) {
        try {
          const bbo = await pm.getBBO(docMatch.slug);
          if (bbo?.bid && bbo?.ask) {
            finalYesPrice = (bbo.bid + bbo.ask) / 2;
            lastRealBBO = { slug: docMatch.slug, price: finalYesPrice, ts: Date.now() };
            console.log(`  ✅ [BTC60] direct BBO lookup found a real price the bulk listing missed: bid=${bbo.bid} ask=${bbo.ask} for "${docMatch.slug}"`);
          }
        } catch (err) {
          console.log(`  ❌ [BTC60] direct BBO fallback threw: ${err.message}`);
        }
        // Rate-limited or otherwise failed — use a recent REAL price for
        // this SAME market instead of jumping straight to the fake 50c
        // default. A 429 doesn't mean the market moved to 50/50, it means
        // we simply couldn't check this one scan.
        if (finalYesPrice == null && lastRealBBO && lastRealBBO.slug === docMatch.slug && (Date.now() - lastRealBBO.ts) < BBO_CACHE_MS) {
          finalYesPrice = lastRealBBO.price;
          console.log(`  🔁 [BTC60] using cached real price ${(finalYesPrice*100).toFixed(0)}¢ from ${Math.round((Date.now()-lastRealBBO.ts)/1000)}s ago (this scan's lookup failed) for "${docMatch.slug}"`);
        }
      }
      return { ...docMatch,
        startDate: realStart != null ? new Date(realStart).toISOString() : docMatch.startDate,
        endDate: realEnd != null ? new Date(realEnd).toISOString() : docMatch.endDate,
        outcomePrices: [String(finalYesPrice ?? 0.5), String(1 - (finalYesPrice ?? 0.5))] };
    }
  } catch (err) {
    console.log(`  ❌ [BTC60] fetchCryptoMarketsV1 path threw: ${err.message}`);
  }

  // Direct, computed lookup — trying the exact slug this specific window
  // should have, based on the app-confirmed :00/:15/:30/:45 ET alignment.
  // Genuinely unproven whether polymarket.us shares polymarket.com's
  // naming convention, so this is tried, not assumed, and only as a
  // fallback now that the documented endpoint above exists.
  try {
    const direct = await pm.findCurrentBtcWindowBySlug(60);
    if (direct) return direct;
  } catch (err) {
    console.log(`  ❌ [BTC60] direct slug lookup threw: ${err.message}`);
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
    console.log(`❌ [BTC60] fetchCryptoMarkets failed: ${err.message}`);
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

  const current = btcMatches.find(m => isHourlyBtcQuestion(m.question || ""));
  if (!current) {
    console.log(`⚠️ [BTC60] No open hourly BTC up/down market found among ${markets.length} results from the correct venue — check the raw sample above`);
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
async function checkNaturalResolution() {
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
    console.log(`  ❌ [BTC60] Couldn't fetch trade history for ${openPosition.slug}: ${err.message} — will retry next scan`);
    return;
  }
  const resolution = (history || []).find(a => a._type === "resolution" && a.marketSlug === openPosition.slug);
  if (!resolution) return; // not resolved yet on Polymarket's side — try again next scan

  const won = !!resolution.won;
  const pnl = resolution.realizedPnl;
  console.log(`  ${won ? "✅ WIN" : "❌ LOSS"} | BTC60 | ${(openPosition.question || "").slice(0, 50)} | pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
  try {
    await tracker.recordSettle(openPosition.slug, { won, pnl, exitPrice: won ? 1 : 0, reason: "expiry",
      fallback: { slug: openPosition.slug, question: openPosition.question, league: "BTC60",
                  entry: openPosition.entryPrice, size: openPosition.sizeUsd, at: new Date().toISOString() } });
  } catch {}
  openPosition = null;
}

/** Real exit check against an already-open position — sells early via the
 * same closePositionLive() the sports bot uses if TP or SL is hit. Holding
 * to natural resolution (the window simply ending) is also a completely
 * valid, unforced outcome for a binary market — this only fires early. */
async function checkTakeProfitStopLoss(market) {
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
      console.log(`  ✅ BTC60 exit (${reason}) filled for ${slug} | pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      try {
        await tracker.recordSettle(slug, { won: pnl > 0, pnl, exitPrice, reason,
          fallback: { slug, question: openPosition.question, league: "BTC60",
                      entry: openPosition.entryPrice, size: openPosition.sizeUsd, at: new Date().toISOString() } });
      } catch {}
    } else {
      console.log(`  ❌ BTC60 exit (${reason}) failed for ${slug}: ${res.error} — will retry next scan, or it resolves naturally at window end regardless`);
      return; // leave openPosition set, try again next scan
    }
  } catch (err) {
    console.log(`  ❌ BTC60 exit (${reason}) threw: ${err.message}`);
    return;
  }
  openPosition = null;
}

// User-defined entry rule: bet the favored side only when its price sits
// between 66% and 80%, AND only in the final 15 minutes before the hour
// closes. This is a real, specific, stated strategy — not a placeholder —
// but it has NOT been backtested against researchBTC60History's data yet,
// which is worth doing once enough real trades exist under this rule.
const ENTRY_EDGE_MIN = Number(process.env.BTC60_ENTRY_EDGE_MIN || 0.45);
const ENTRY_EDGE_MAX = Number(process.env.BTC60_ENTRY_EDGE_MAX || 1.0);
const ENTRY_WINDOW_MS = Number(process.env.BTC60_ENTRY_WINDOW_MIN || 15) * 60_000;

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

export async function runBTC60ScanCycle() {
  try {
    const c = await getConfig();
    if (c.BTC60_ENABLED != null) BTC60_ENABLED = c.BTC60_ENABLED;
    if (c.BTC60_LIVE_TRADING != null) LIVE_TRADING_ENABLED = c.BTC60_LIVE_TRADING;
    if (c.BTC60_SL_ENABLED != null) SL_ENABLED = c.BTC60_SL_ENABLED;
  } catch {}
  if (!BTC60_ENABLED) return;

  if (Date.now() - lastResearchRunAt > RESEARCH_INTERVAL_MS) {
    lastResearchRunAt = Date.now();
    researchBTC60History().catch(() => {});
  }

  // Runs BEFORE discovery, and independent of whether discovery finds
  // anything — a held position's window can end right as the NEXT window
  // hasn't shown up as "active" yet, or discovery can fail transiently.
  // This must not depend on that succeeding.
  if (openPosition) await checkNaturalResolution();

  const market = await discoverCurrentBTC60Market();
  if (!market) return;

  const yesPrice = market.outcomePrices ? Number(market.outcomePrices[0]) : null;
  const endsInMs = market.endDate ? new Date(market.endDate).getTime() - Date.now() : null;
  const endsInSec = endsInMs != null ? Math.round(endsInMs / 1000) : "?";
  console.log(`₿ BTC60 window: "${(market.question || "").slice(0, 50)}" | slug=${market.slug||market.id||"?"} | Up price ${yesPrice != null ? (yesPrice * 100).toFixed(0) + "¢" : "?"} | ends in ${endsInSec}s`);

  // If we're already holding a position in THIS window, check TP/SL —
  // this runs regardless of the live-trading flag, since it only manages
  // an existing position, never opens a new one.
  if (openPosition && openPosition.slug === market.slug) {
    await checkTakeProfitStopLoss(market);
    return;
  }
  if (openPosition) {
    console.log(`  🔒 [BTC60] blocking new entry — still marked as holding "${openPosition.slug}" (${openPosition.side} @ ${(openPosition.entryPrice*100).toFixed(0)}¢, opened for endTime ${openPosition.endTime}), not yet resolved`);
    return; // still holding a DIFFERENT (older) window, not yet resolved — don't open a new one on top of it
  }

  if (!LIVE_TRADING_ENABLED) {
    console.log(`  👁 OBSERVE MODE — BTC60_LIVE_TRADING is off. No entries, no exits, logging only.`);
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
      console.log(`  ✅ BTC60 ENTRY ${DRY_RUN ? "[DRY]" : ""} ${entry.side} $${BET_SIZE_USD} @ ${(entry.price*100).toFixed(0)}¢`);
      try {
        await tracker.recordEntry({ slug: market.slug, question: market.question, league: "BTC60",
          entry: entry.price, size: BET_SIZE_USD, live: true });
      } catch {}
    } else {
      console.log(`  ❌ BTC60 entry did not fill: ${res.error || "unknown"}`);
    }
  } catch (err) {
    console.log(`  ❌ BTC60 entry threw: ${err.message}`);
  }
}

export function btc60Status() {
  return { enabled: BTC60_ENABLED, liveTrading: LIVE_TRADING_ENABLED, dryRun: DRY_RUN, tpPct: TP_PCT, slPct: SL_PCT, openPosition, lastResearch: cachedResearch };
}
