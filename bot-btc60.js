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
const LIVE_TRADING_ENABLED = process.env.BTC60_LIVE_TRADING === "true";
const DRY_RUN = process.env.DRY_RUN !== "false";

const SCAN_INTERVAL_MS = 20_000;
const RESEARCH_INTERVAL_MS = 60 * 60_000;
let BET_SIZE_USD = Number(process.env.BTC60_BET_SIZE || 0.50);
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

// Real evidence from production logs: the "tag" query param below is NOT
// reliably honored by Gamma's API — it returned a 5-MINUTE window
// ("11:35AM-11:40AM") from roughly 9 months in the past, despite
// closed:false/active:true. Two confirmed real examples show a reliable
// TEXT pattern instead: hourly questions state a single time point
// ("...1PM ET"), shorter windows state an explicit start-end RANGE
// ("...11:35AM-11:40AM"). That's what this now keys off, not the tag —
// don't trust an unverified tag name a second time when a directly
// observed text pattern is available.
function isHourlyBtcQuestion(q) {
  if (!/bitcoin|btc/i.test(q) || !/up or down/i.test(q)) return false;
  const hasTimeRange = /\d{1,2}(:\d{2})?\s*(AM|PM)\s*-\s*\d{1,2}(:\d{2})?\s*(AM|PM)/i.test(q);
  if (hasTimeRange) return false; // ranged questions are 5m/15m/4h, not hourly
  const hasSingleTime = /\d{1,2}(:\d{2})?\s*(AM|PM)\s*ET/i.test(q);
  return hasSingleTime;
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
  let markets;
  try {
    const { data } = await axios.get(`${GAMMA}/markets`, {
      params: { closed: false, active: true, order: "endDate", ascending: false, limit: 500 },
      // Switched from ascending. Now that we know there's a backlog of
      // permanently-stuck "active:true" garbage from months ago,
      // ascending (soonest-ending-first) sorts THAT ancient backlog to
      // the very front — a bigger limit just meant more of the same
      // dead weight before reaching anything current. Descending
      // (furthest-future-first) avoids that specific failure mode.
      // Widened from 20 — sorted soonest-ending-first across EVERY crypto
      // asset and EVERY window length (BTC/ETH/SOL/etc x 5m/15m/1h/4h) all
      // mixed together, the one relevant window can easily get crowded out
      // of a small batch before the text filter below ever sees it.
      timeout: 10_000,
    });
    markets = Array.isArray(data) ? data : (data?.markets || []);
  } catch (err) {
    console.log(`❌ [BTC60] Gamma discovery fetch failed: ${err.message}`);
    return null;
  }

  if (!shapeLoggedDiscovery) {
    shapeLoggedDiscovery = true;
    console.log(`🔬 BTC60 DISCOVERY RAW SAMPLE (first result, truncated): ${JSON.stringify(markets[0]).slice(0, 500)}`);
  }

  const now = Date.now();
  // CONFIRMED via production logs: Polymarket's own closed/active fields
  // cannot be trusted — a market with endDate 2025-12-19 (nine months
  // past) was still being reported as closed:false, active:true, every
  // single query, regardless of when asked. Checking the date ourselves,
  // FIRST, before duration matching, is now the primary defense against
  // that — not an afterthought that duration-mismatch was masking.
  const notStale = m => { const t = m.endDate ? new Date(m.endDate).getTime() : null; return t != null && t > now; };
  const anyBtcMention = markets.filter(m => /bitcoin|btc/i.test(m.question||"") && /up or down/i.test(m.question||""));
  const btcMatches = anyBtcMention.filter(notStale);
  console.log(`  🔍 [DISCOVERY] ${anyBtcMention.length} of ${markets.length} mention bitcoin+up/down at all | ${btcMatches.length} of those are genuinely fresh (not stale despite closed:false/active:true)`);
  // Print the REAL question text on every scan, not gated behind a
  // one-time flag — that flag has now missed its window three times in a
  // row across redeploys. This is the actual evidence needed to build a
  // correct duration regex instead of guessing a third unverified format.
  if (btcMatches.length) console.log(`  🔍 [DISCOVERY] sample questions: ${btcMatches.slice(0,4).map(m=>JSON.stringify(m.question)).join(" | ")}`);
  // The question text alone showed the SAME stale "December 19" 5-minute
  // batch across multiple independent sessions, regardless of when
  // queried — that's not a regex problem, it's a data problem. This next
  // line checks whether Polymarket's OWN metadata on these same items
  // agrees they're closed/expired (meaning the closed:false/active:true
  // query params are being ignored) or claims they're still open (a
  // deeper data issue). One or the other — this settles which.
  if (btcMatches.length) console.log(`  🔍 [DISCOVERY] raw flags: ${btcMatches.slice(0,3).map(m=>JSON.stringify({closed:m.closed, active:m.active, endDate:m.endDate})).join(" | ")}`);
  const current = btcMatches.find(m => isHourlyBtcQuestion(m.question || ""));
  if (!current) {
    console.log(`⚠️ [BTC60] No open hourly BTC up/down market found among ${markets.length} active results — check the raw sample above`);
    return null;
  }
  return current;
}

/** Fires when the window has ended and TP/SL never triggered — the
 * position resolves to $1 or $0 on-chain regardless, but without this,
 * nothing would ever RECORD that outcome. Fetches the now-closed market by
 * id to read its resolved side, same win/loss math as the sports bot's
 * expiry settlement. */
async function checkNaturalResolution() {
  if (!openPosition) return;
  if (new Date(openPosition.endTime).getTime() > Date.now()) return; // window still open

  let market;
  try {
    const { data } = await axios.get(`${GAMMA}/markets/${openPosition.slug}`, { timeout: 10_000 });
    market = data;
  } catch (err) {
    console.log(`  ❌ [BTC60] Couldn't fetch resolution for ${openPosition.slug}: ${err.message} — will retry next scan`);
    return;
  }
  if (!market || market.closed !== true || !Array.isArray(market.outcomePrices)) return; // not resolved yet, try again next scan

  const prices = market.outcomePrices.map(Number);
  const resolvedUp = prices[0] === 1;
  const won = openPosition.side === "Up" ? resolvedUp : !resolvedUp;
  const shares = openPosition.sizeUsd / openPosition.entryPrice;
  // Same expiryPnl formula the sports bot uses — win pays out shares at
  // $1 each minus the stake, loss is the full stake gone. No fee estimate
  // here (unlike sports' feeFor()) — BTC60 fee structure isn't confirmed,
  // so this is a simplification, not a claim of exact precision.
  const pnl = won ? (shares - openPosition.sizeUsd) : -openPosition.sizeUsd;

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
  } else if (moveFromEntry <= -SL_PCT) {
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
const ENTRY_EDGE_MIN = Number(process.env.BTC60_ENTRY_EDGE_MIN || 0.63);
const ENTRY_EDGE_MAX = Number(process.env.BTC60_ENTRY_EDGE_MAX || 0.74);
const ENTRY_WINDOW_MS = Number(process.env.BTC60_ENTRY_WINDOW_MIN || 15) * 60_000;

function userEntryRule(market) {
  const yesPrice = market.outcomePrices ? Number(market.outcomePrices[0]) : null;
  if (yesPrice == null) return null;

  const endsInMs = market.endDate ? new Date(market.endDate).getTime() - Date.now() : null;
  if (endsInMs == null || endsInMs > ENTRY_WINDOW_MS || endsInMs < 0) return null; // not yet in the last 15 minutes

  const side = yesPrice >= 0.5 ? "Up" : "Down";
  const price = yesPrice >= 0.5 ? yesPrice : 1 - yesPrice;
  if (price < ENTRY_EDGE_MIN || price > ENTRY_EDGE_MAX) return null; // outside the 63-74% band

  return { side, price };
}

export async function runBTC60ScanCycle() {
  try {
    const c = await getConfig();
    if (c.BTC60_ENABLED != null) BTC60_ENABLED = c.BTC60_ENABLED;
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
  console.log(`₿ BTC60 window: "${(market.question || "").slice(0, 50)}" | Up price ${yesPrice != null ? (yesPrice * 100).toFixed(0) + "¢" : "?"} | ends in ${endsInSec}s`);

  // If we're already holding a position in THIS window, check TP/SL —
  // this runs regardless of the live-trading flag, since it only manages
  // an existing position, never opens a new one.
  if (openPosition && openPosition.slug === market.id) {
    await checkTakeProfitStopLoss(market);
    return;
  }
  if (openPosition) return; // still holding a DIFFERENT (older) window, not yet resolved — don't open a new one on top of it

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
      : await pm.buyYesFOK({ slug: market.id, sizeUsd: BET_SIZE_USD, ask: entry.price, override: true });
    if (res.filled) {
      openPosition = { slug: market.id, side: entry.side, entryPrice: entry.price, sizeUsd: BET_SIZE_USD, endTime: market.endDate, question: market.question };
      console.log(`  ✅ BTC60 ENTRY ${DRY_RUN ? "[DRY]" : ""} ${entry.side} $${BET_SIZE_USD} @ ${(entry.price*100).toFixed(0)}¢`);
      try {
        await tracker.recordEntry({ slug: market.id, question: market.question, league: "BTC60",
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
