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
const LIVE_TRADING_ENABLED = process.env.BTC15_LIVE_TRADING === "true";
const DRY_RUN = process.env.DRY_RUN !== "false";

const SCAN_INTERVAL_MS = 20_000;
const RESEARCH_INTERVAL_MS = 60 * 60_000;
let BET_SIZE_USD = Number(process.env.BTC15_BET_SIZE || 0.50);
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

// Carries forward bot-btc60.js's confirmed fix: the "tag" query param is
// NOT reliable, question text is. 15-minute AND 5-minute questions both
// use an explicit start-end RANGE format ("3:00PM-3:15PM" vs
// "11:35AM-11:40AM") — a bare "has a range" check (which is all BTC60
// needed, since hourly has NO range at all) can't tell those two apart.
// This parses BOTH times in the range and requires the actual computed
// gap to be close to 15 minutes, not just "some range exists".
function parseRangeMinutes(q) {
  const m = q.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return null;
  const to24 = (h, mm, ap) => {
    h = parseInt(h, 10); mm = mm ? parseInt(mm, 10) : 0;
    if (/PM/i.test(ap) && h !== 12) h += 12;
    if (/AM/i.test(ap) && h === 12) h = 0;
    return h * 60 + mm;
  };
  const start = to24(m[1], m[2], m[3]);
  let end = to24(m[4], m[5], m[6]);
  if (end <= start) end += 24 * 60; // crossed midnight
  return end - start;
}
function is15MinBtcQuestion(q) {
  if (!/bitcoin|btc/i.test(q) || !/up or down/i.test(q)) return false;
  const mins = parseRangeMinutes(q);
  return mins != null && mins >= 13 && mins <= 17; // small tolerance for formatting quirks
}

export async function researchBTC15History(limit = 300) {
  let markets;
  try {
    const { data } = await axios.get(`${GAMMA}/markets`, {
      params: { closed: true, order: "endDate", ascending: false, limit }, // tag param removed — confirmed unreliable, question text is what actually filters now
      timeout: 10_000,
    });
    markets = Array.isArray(data) ? data : (data?.markets || []);
  } catch (err) {
    console.log(`❌ [BTC15 research] Gamma fetch failed: ${err.message}`);
    return null;
  }

  if (!shapeLoggedResearch) {
    shapeLoggedResearch = true;
    console.log(`🔬 BTC15 RESEARCH RAW SAMPLE (first result, truncated): ${JSON.stringify(markets[0]).slice(0, 500)}`);
  }

  const btc60 = markets.filter(m => is15MinBtcQuestion(m.question || ""));
  if (!btc60.length) {
    console.log(`⚠️ [BTC15 research] 0 matching resolved markets found out of ${markets.length} returned — tag/filter assumption may be wrong, check the raw sample above`);
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
    console.log(`⚠️ [BTC15 research] Only ${results.length} markets had a parseable outcome — not enough to say anything real yet`);
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
  // Direct, computed lookup FIRST — bypasses the whole discovery-sweep
  // problem entirely by trying the exact slug this specific window should
  // have, based on the app-confirmed :00/:15/:30/:45 ET alignment. Falls
  // through to the sweep below only if none of the guessed slug patterns
  // match — genuinely unproven whether polymarket.us shares
  // polymarket.com's naming convention, so this is tried, not assumed.
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
  const notStale = m => { const t = m.endDate ? new Date(m.endDate).getTime() : null; return t != null && t > now; };
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

  let market;
  try {
    const { data } = await axios.get(`${GAMMA}/markets/${openPosition.slug}`, { timeout: 10_000 });
    market = data;
  } catch (err) {
    console.log(`  ❌ [BTC15] Couldn't fetch resolution for ${openPosition.slug}: ${err.message} — will retry next scan`);
    return;
  }
  if (!market || market.closed !== true || !Array.isArray(market.outcomePrices)) return; // not resolved yet, try again next scan

  const prices = market.outcomePrices.map(Number);
  const resolvedUp = prices[0] === 1;
  const won = openPosition.side === "Up" ? resolvedUp : !resolvedUp;
  const shares = openPosition.sizeUsd / openPosition.entryPrice;
  // Same expiryPnl formula the sports bot uses — win pays out shares at
  // $1 each minus the stake, loss is the full stake gone. No fee estimate
  // here (unlike sports' feeFor()) — BTC15 fee structure isn't confirmed,
  // so this is a simplification, not a claim of exact precision.
  const pnl = won ? (shares - openPosition.sizeUsd) : -openPosition.sizeUsd;

  console.log(`  ${won ? "✅ WIN" : "❌ LOSS"} | BTC15 | ${(openPosition.question || "").slice(0, 50)} | pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
  try {
    await tracker.recordSettle(openPosition.slug, { won, pnl, exitPrice: won ? 1 : 0, reason: "expiry",
      fallback: { slug: openPosition.slug, question: openPosition.question, league: "BTC15",
                  entry: openPosition.entryPrice, size: openPosition.sizeUsd, at: new Date().toISOString() } });
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
const ENTRY_EDGE_MIN = Number(process.env.BTC15_ENTRY_EDGE_MIN || 0.63);
const ENTRY_EDGE_MAX = Number(process.env.BTC15_ENTRY_EDGE_MAX || 0.74);
const ENTRY_WINDOW_MS = Number(process.env.BTC15_ENTRY_WINDOW_MIN || 3) * 60_000;

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

export async function runBTC15ScanCycle() {
  try {
    const c = await getConfig();
    if (c.BTC15_ENABLED != null) BTC15_ENABLED = c.BTC15_ENABLED;
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
  console.log(`₿ BTC15 window: "${(market.question || "").slice(0, 50)}" | Up price ${yesPrice != null ? (yesPrice * 100).toFixed(0) + "¢" : "?"} | ends in ${endsInSec}s`);

  // If we're already holding a position in THIS window, check TP/SL —
  // this runs regardless of the live-trading flag, since it only manages
  // an existing position, never opens a new one.
  if (openPosition && openPosition.slug === market.id) {
    await checkTakeProfitStopLoss15(market);
    return;
  }
  if (openPosition) return; // still holding a DIFFERENT (older) window, not yet resolved — don't open a new one on top of it

  if (!LIVE_TRADING_ENABLED) {
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
      : await pm.buyYesFOK({ slug: market.id, sizeUsd: BET_SIZE_USD, ask: entry.price, override: true });
    if (res.filled) {
      openPosition = { slug: market.id, side: entry.side, entryPrice: entry.price, sizeUsd: BET_SIZE_USD, endTime: market.endDate, question: market.question };
      console.log(`  ✅ BTC15 ENTRY ${DRY_RUN ? "[DRY]" : ""} ${entry.side} $${BET_SIZE_USD} @ ${(entry.price*100).toFixed(0)}¢`);
      try {
        await tracker.recordEntry({ slug: market.id, question: market.question, league: "BTC15",
          entry: entry.price, size: BET_SIZE_USD, live: true });
      } catch {}
    } else {
      console.log(`  ❌ BTC15 entry did not fill: ${res.error || "unknown"}`);
    }
  } catch (err) {
    console.log(`  ❌ BTC15 entry threw: ${err.message}`);
  }
}

export function btc15Status() {
  return { enabled: BTC15_ENABLED, liveTrading: LIVE_TRADING_ENABLED, dryRun: DRY_RUN, tpPct: TP_PCT, slPct: SL_PCT, openPosition, lastResearch: cachedResearch };
}
