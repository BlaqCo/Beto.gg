/**
 * arena/copy-trader.js — SHADOW, the copy trader. PAPER ONLY: it never places orders.
 *
 * Polymarket US doesn't show anyone else's trades, but global Polymarket runs the
 * same BTC Up/Down windows on-chain, where every wallet's trades are public. So:
 *
 *   1. Scoring. After each global BTC15/BTC60 window resolves, SHADOW reads every
 *      trade in it and works out each wallet's profit on that window. Over many
 *      windows that builds its own track record per wallet, on exactly these markets.
 *   2. Smart wallets. A wallet counts as "smart" only with enough settled windows,
 *      recent activity, a real profit and win rate, profit not from one lucky window,
 *      and not trading both sides of the same window (market makers / arbitrage bots).
 *   3. Voting. During a live window it polls the newest trades. Every smart wallet's buy
 *      is a vote for that side, weighted by the wallet's recent win rate and its edge on
 *      late 70¢+ bets (the kind SHADOW makes).
 *   4. Entering. In the last 4 minutes, if 2+ smart wallets back a side with 65%+ of the
 *      vote weight, that side costs 72-95¢ on Polymarket US, and the price isn't above
 *      fair value (BTC spot vs strike with time left, averaged with the global Polymarket
 *      price; only a fresh global price can veto, the BTC math alone just shrinks the bet),
 *      it makes a $5 / $10 / $15 paper bet sized by signal strength, adds 2x that once
 *      on a dip to 53-63¢, stops out at 22¢, and otherwise settles on the US result.
 *      Brakes: no new bets after -$40 in a day, and a 30-minute pause after 2 losses
 *      in a row.
 *   5. Side by side. A few other rules (the plain 72¢ and 80¢ rules, no DCA, other stops)
 *      trade the same windows on paper with their own books, for comparison.
 *
 * Everything it does goes to an event feed, streamed to the /copy page.
 * On by default (paper only); set COPY_TRADER=false to turn it off.
 */
import { EventEmitter } from "events";
import { takerFee } from "../fees.js";
import { saveJSON, loadJSON } from "./state.js";

const GAMMA = process.env.COPY_GAMMA_URL || "https://gamma-api.polymarket.com";
const DATA = process.env.COPY_DATA_URL || "https://data-api.polymarket.com";
const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);

export const CFG = {
  stake: env("COPY_STAKE", 10),                 // paper dollars per copy
  pollMs: env("COPY_POLL_MS", 10_000),          // live trade polling
  minWindows: env("COPY_MIN_WINDOWS", 20),      // settled windows before a wallet can be trusted
  minWinRate: env("COPY_MIN_WIN_RATE", 0.55),
  minRoi: env("COPY_MIN_ROI", 0.05),            // profit / money put in
  maxBothSides: env("COPY_MAX_BOTH_SIDES", 0.3),// share of windows where it bought Up AND Down
  maxBestShare: env("COPY_MAX_BEST_SHARE", 0.5),// biggest single window as a share of total profit
  activeMs: env("COPY_ACTIVE_HOURS", 24) * 3600_000,
  minSignalUsd: env("COPY_MIN_SIGNAL_USD", 20), // plain rules: one smart buy at least this big
  // Smart rule: votes, fair value, sizing, brakes.
  minVoteUsd: env("COPY_MIN_VOTE_USD", 2),      // smart buys this big count as votes
  minAgree: env("COPY_MIN_AGREE", 2),           // smart wallets needed on our side
  soloLateN: 0,                                 // >0: one wallet is enough if it has this many late bets...
  soloLateWin: 0.9,                             // ...with at least this win rate (the "1 strong wallet" rule)
  minShare: env("COPY_MIN_SHARE", 0.65),        // share of smart vote weight on our side
  minEdge: env("COPY_MIN_EDGE", 0),             // fair value minus price minus fee, per share
  defaultVol: env("COPY_DEFAULT_VOL", 0.5),     // BTC yearly volatility when spot ticks are thin
  basisUsd: env("COPY_BASIS_USD", 25),          // Coinbase spot vs settlement index slack
  globalFreshMs: env("COPY_GLOBAL_FRESH_SECONDS", 90) * 1000,
  sizeWeak: env("COPY_SIZE_WEAK", 5), sizeStrong: env("COPY_SIZE_STRONG", 15),
  dailyLossLimit: env("COPY_DAILY_LOSS_LIMIT", 40),
  lossStreak: env("COPY_LOSS_STREAK", 2),
  pauseMs: env("COPY_PAUSE_MINUTES", 30) * 60_000,
  variants: process.env.COPY_VARIANTS !== "false",  // run the comparison rules too
  // Wallet scoring.
  lateMs: env("COPY_LATE_SECONDS", 300) * 1000, // a "late" buy: this close to the end...
  latePrice: env("COPY_LATE_PRICE", 0.70),      // ...at this price or more
  decay: env("COPY_DECAY", 0.97),               // each older window counts this much as the next
  // Entry: only in the last few minutes, only on a strong favorite that smart money backed.
  entryWindowMs: env("COPY_ENTRY_SECONDS", 240) * 1000,  // enter only with this much time left or less
  minPrice: env("COPY_MIN_PRICE", 0.72),        // our side must cost at least this on US...
  maxPrice: env("COPY_MAX_PRICE", 0.95),        // ...and at most this
  minMsLeft: env("COPY_MIN_SECONDS_LEFT", 30) * 1000,
  // Position management: add once on a dip, cut the whole position at the stop.
  dcaUsd: env("COPY_DCA_USD", 20),              // paper dollars added on the dip (0 turns DCA off)
  dcaLow: env("COPY_DCA_LOW", 0.53),            // our side's bid must be inside this band...
  dcaHigh: env("COPY_DCA_HIGH", 0.63),          // ...to add (a gap straight past it doesn't)
  stopPrice: env("COPY_STOP_PRICE", 0.22),      // sell everything when our side's bid hits this (0 = off)
  manageMs: env("COPY_MANAGE_MS", 5000),
  backfill15: env("COPY_BACKFILL_BTC15", 192),  // windows to score on startup (192 = two days)
  backfill60: env("COPY_BACKFILL_BTC60", 48),
  maxTradesPerWindow: env("COPY_MAX_TRADES_PER_WINDOW", 5000),
};

const DUR = { btc15: 15 * 60_000, btc60: 60 * 60_000 };
// wallets v3 adds recency-weighted and late-bet stats (v2 lacked them; v1 had year-old hourly markets).
// Books: one per rule at arena:copy:book:v4:<rule>. v2 = last 3 min / 80¢+ results, kept in Redis.
const KEY_WALLETS = "arena:copy:wallets:v3", KEY_BOOK = "arena:copy:book:v4", KEY_EVENTS = "arena:copy:events";
const MAX_EVENTS = 300, MAX_WALLETS = 3000;   // keeps the saved wallet list well under Redis's 1 MB request limit

// ── State ───────────────────────────────────────────────────────────
const bus = new EventEmitter(); bus.setMaxListeners(100);
let events = [];                         // newest last
let wallets = new Map();                 // address -> stats
const books = new Map();                 // rule id -> { open, closed } paper positions
const scored = new Set();                // "family:start" windows already scored
const marketCache = new Map();           // "family:start" -> market | { missUntil }
const live = { btc15: null, btc60: null };  // current window: { key, market, seen:Set, flow:{Up,Down} }
const toScore = [];                      // queue of { family, start }
const stats = { enabled: false, startedAt: 0, polls: 0, apiErrors: 0, lastError: null, lastApiOkAt: 0, windowsScored: 0, backfillTotal: 0, backfillDone: 0, backfillMissing: 0 };
let fetchImpl = (...a) => fetch(...a);
let recorder = null;
let timers = [];

export function _setFetch(fn) { fetchImpl = fn; }               // tests
export function _reset() { events = []; wallets = new Map(); books.clear(); scored.clear(); marketCache.clear(); live.btc15 = live.btc60 = null; toScore.length = 0; }

const short = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");
const usd = n => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const cents = p => `${Math.round(p * 100)}¢`;

export function emit(type, msg, data = {}) {
  const e = { t: Date.now(), type, msg, ...data };
  if (type === "poll") { bus.emit("event", e); return e; }   // heartbeats go to the live feed only
  events.push(e);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  bus.emit("event", e);
  console.log(`  👥 [copy] ${msg}`);
  return e;
}
export function subscribe(fn) { bus.on("event", fn); return () => bus.off("event", fn); }

// ── Global Polymarket reads ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/^https:\/\//, "").slice(0, 80)}`);
  stats.lastApiOkAt = Date.now();
  return res.json();
}
const parseArr = v => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } };

/** Slugs global Polymarket uses for the BTC window starting at startMs. */
export function globalSlugs(family, startMs) {
  const sec = Math.round(startMs / 1000);
  if (family === "btc15") return [`btc-updown-15m-${sec}`];
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", hour: "numeric", hour12: true })
    .formatToParts(new Date(startMs)).map(x => [x.type, x.value]));
  const y = new Date(startMs).getUTCFullYear(), md = `${p.month.toLowerCase()}-${p.day}`, h = `${p.hour}${(p.dayPeriod || "").toLowerCase()}`;
  // Exact-timestamp slug first; the month-day slug has no year, so findMarket checks its dates.
  return [`btc-updown-1h-${sec}`, `bitcoin-up-or-down-${md}-${y}-${h}-et`, `bitcoin-up-or-down-${md}-${h}-et`];
}

/**
 * Does a global market belong to the window ending at endMs? Slugs without a year can
 * match the same date in another year, so an hourly market's end date must be within
 * 6 hours of ours. BTC15 slugs are the exact start timestamp, so they always match.
 */
export function marketMatchesWindow(family, ev, m, endMs) {
  if (family === "btc15") return true;   // its slug is the exact start timestamp
  const d = Date.parse(m?.endDate || ev?.endDate || "");
  if (!Number.isFinite(d)) return false;
  return Math.abs(d - endMs) <= 6 * 3600_000;
}

export function windowStart(family, now) { return Math.floor(now / DUR[family]) * DUR[family]; }

/** Find the global market for a window (cached; misses are retried after a minute). */
async function findMarket(family, start) {
  const key = `${family}:${start}`;
  const c = marketCache.get(key);
  if (c && !c.missUntil) return c;
  if (c?.missUntil > Date.now()) return null;
  for (const slug of globalSlugs(family, start)) {
    try {
      const evs = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
      const ev = Array.isArray(evs) ? evs[0] : evs, m = ev?.markets?.[0];
      if (!m?.conditionId) continue;
      if (!marketMatchesWindow(family, ev, m, start + DUR[family])) {
        stats.lastError = `${slug} is a different window (ends ${m.endDate || ev.endDate}), skipped`;
        continue;
      }
      const mk = { family, start, end: start + DUR[family], slug, conditionId: m.conditionId, outcomes: parseArr(m.outcomes) };
      marketCache.set(key, mk);
      if (marketCache.size > 400) marketCache.delete(marketCache.keys().next().value);
      return mk;
    } catch (err) { stats.apiErrors++; stats.lastError = err.message; }
  }
  marketCache.set(key, { missUntil: Date.now() + 60_000 });
  return null;
}

/** 1 = Up won, 0 = Down won, null = not resolved yet. */
async function globalOutcome(mk) {
  const evs = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(mk.slug)}`);
  const m = (Array.isArray(evs) ? evs[0] : evs)?.markets?.[0];
  const prices = parseArr(m?.outcomePrices).map(Number);
  const outs = parseArr(m?.outcomes);
  const win = prices.findIndex(p => p >= 0.99);
  if (win < 0 || !outs[win]) return null;
  return /^up$/i.test(outs[win]) ? 1 : /^down$/i.test(outs[win]) ? 0 : null;
}

export function normTrade(t, outcomes = []) {
  const ts = Number(t.timestamp);
  const outcome = t.outcome || outcomes[Number(t.outcomeIndex)];
  return {
    wallet: String(t.proxyWallet || "").toLowerCase(), side: String(t.side || "").toUpperCase(),
    outcome: /^up$/i.test(outcome) ? "Up" : /^down$/i.test(outcome) ? "Down" : null,
    size: Number(t.size) || 0, price: Number(t.price) || 0, t: ts < 1e12 ? ts * 1000 : ts,
    name: t.name || t.pseudonym || null,
    id: `${t.transactionHash || ""}:${t.proxyWallet}:${t.outcomeIndex}:${t.size}:${t.price}`,
  };
}

async function fetchTrades(mk, { limit = 500, offset = 0 } = {}) {
  const rows = await getJSON(`${DATA}/trades?market=${mk.conditionId}&limit=${limit}&offset=${offset}`);
  return (Array.isArray(rows) ? rows : []).map(t => normTrade(t, mk.outcomes)).filter(t => t.wallet && t.outcome && (t.side === "BUY" || t.side === "SELL"));
}

// ── Scoring ─────────────────────────────────────────────────────────
/**
 * Each wallet's result on one settled window: cash from trades plus $1 per winning share.
 * With endMs it also records the wallet's "late" bet: buys in the last few minutes at
 * 70¢+ (the same kind of bet SHADOW makes), the price it paid and whether that side won.
 */
export function scoreTrades(trades, outcome, endMs = null, cfg = CFG) {
  const per = new Map();
  for (const t of trades) {
    const w = per.get(t.wallet) || { up: 0, down: 0, cash: 0, cost: 0, boughtUp: false, boughtDown: false, name: t.name, lUp: 0, lDown: 0, lCost: 0 };
    const n = t.size, amt = t.size * t.price;
    if (t.side === "BUY") {
      w.cash -= amt; w.cost += amt;
      if (t.outcome === "Up") { w.up += n; w.boughtUp = true; } else { w.down += n; w.boughtDown = true; }
      if (endMs && t.t >= endMs - cfg.lateMs && t.price >= cfg.latePrice) { w.lCost += amt; if (t.outcome === "Up") w.lUp += n; else w.lDown += n; }
    }
    else { w.cash += amt; if (t.outcome === "Up") w.up -= n; else w.down -= n; }
    per.set(t.wallet, w);
  }
  const out = [];
  for (const [wallet, w] of per) {
    if (w.cost <= 0) continue;   // sold only: shares bought before this window's trades we saw
    const lShares = w.lUp + w.lDown;
    const late = lShares > 0 ? { won: outcome ? w.lUp > w.lDown : w.lDown > w.lUp, price: +(w.lCost / lShares).toFixed(4) } : null;
    out.push({ wallet, name: w.name, cost: w.cost, pnl: w.cash + (outcome ? w.up : w.down), both: w.boughtUp && w.boughtDown, late });
  }
  return out;
}

/**
 * Add one window's result to a wallet. Besides plain totals it keeps recency-weighted
 * counts (each earlier window counts `decay` as much as the next one), so a wallet that
 * has gone cold drops out. Windows are scored oldest first, so the weighting is in time order.
 */
export function addResult(map, r, t, cfg = CFG) {
  const s = map.get(r.wallet) || { windows: 0, wins: 0, pnl: 0, cost: 0, both: 0, best: 0, lastSeen: 0, name: null };
  const d = cfg.decay;
  s.windows++; if (r.pnl > 0) s.wins++; s.pnl += r.pnl; s.cost += r.cost; if (r.both) s.both++;
  s.best = Math.max(s.best, r.pnl); s.lastSeen = Math.max(s.lastSeen, t); if (r.name) s.name = r.name;
  s.rn = (s.rn || 0) * d + 1; s.rw = (s.rw || 0) * d + (r.pnl > 0 ? 1 : 0);
  if (r.late) { s.lN = (s.lN || 0) * d + 1; s.lW = (s.lW || 0) * d + (r.late.won ? 1 : 0); s.lP = (s.lP || 0) * d + r.late.price; }
  map.set(r.wallet, s);
}

/**
 * A wallet's late 70¢+ bets: how often they won, and its edge = wins minus prices paid,
 * per bet (what beating the price is worth), shrunk toward 0 when there are few bets.
 */
export function lateStats(s) {
  const n = s?.lN || 0;
  return { n, winRate: n ? s.lW / n : null, edge: n ? (s.lW - s.lP) / (n + 3) : 0 };
}

/** Why a wallet is (or isn't) worth copying. Win rate is the recency-weighted one. */
export function judge(s, now, cfg = CFG) {
  if (!s) return { smart: false, why: "never seen on a settled window" };
  if (s.windows < cfg.minWindows) return { smart: false, why: `only ${s.windows}/${cfg.minWindows} settled windows` };
  if (now - s.lastSeen > cfg.activeMs) return { smart: false, why: "not active recently" };
  const winRate = s.rn ? s.rw / s.rn : s.wins / s.windows, roi = s.cost > 0 ? s.pnl / s.cost : 0;
  if (s.both / s.windows > cfg.maxBothSides) return { smart: false, why: "trades both sides (market maker / arb bot)" };
  if (roi < cfg.minRoi) return { smart: false, why: `ROI ${(roi * 100).toFixed(1)}% below ${(cfg.minRoi * 100).toFixed(0)}%` };
  if (winRate < cfg.minWinRate) return { smart: false, why: `win rate ${(winRate * 100).toFixed(0)}% below ${(cfg.minWinRate * 100).toFixed(0)}%` };
  if (s.pnl > 0 && s.best / s.pnl > cfg.maxBestShare) return { smart: false, why: "most profit came from one window" };
  const late = lateStats(s);
  const lateTxt = late.n >= 3 ? `, late 70¢+ bets ${(late.winRate * 100).toFixed(0)}% won` : "";
  return { smart: true, why: `${s.windows} windows, ${(winRate * 100).toFixed(0)}% wins, ROI ${(roi * 100).toFixed(1)}%${lateTxt}`, winRate, roi, late };
}

/**
 * How much a smart wallet's vote counts: how far its recent win rate is above 50%, plus
 * a bonus (or penalty) for its edge on late 70¢+ bets once it has at least 3 of them.
 */
export function walletWeight(s, j) {
  const base = Math.max(0.05, (j?.winRate ?? 0.5) - 0.5);
  const late = lateStats(s);
  const bonus = late.n >= 3 ? Math.max(-base, Math.min(1, late.edge * 5)) : 0;
  return +Math.max(0, base + bonus).toFixed(4);
}

async function scoreWindow(family, start, { quiet = false } = {}) {
  const key = `${family}:${start}`;
  if (scored.has(key)) return "done";
  const mk = await findMarket(family, start);
  if (!mk) return "no-market";
  const outcome = await globalOutcome(mk);
  if (outcome == null) return "unresolved";
  const trades = [];
  for (let offset = 0; offset < CFG.maxTradesPerWindow; offset += 500) {
    const page = await fetchTrades(mk, { limit: 500, offset });
    trades.push(...page);
    if (page.length < 500) break;
  }
  const results = scoreTrades(trades, outcome, mk.end);
  for (const r of results) addResult(wallets, r, mk.end);
  scored.add(key); stats.windowsScored++;
  if (scored.size > 2000) scored.delete(scored.values().next().value);
  if (!quiet) {
    const smartNow = [...wallets.entries()].filter(([, s]) => judge(s, Date.now()).smart).length;
    emit("score", `scored ${family.toUpperCase()} ${new Date(start).toISOString().slice(11, 16)}Z (${outcome ? "Up" : "Down"} won): ${results.length} wallets, ${trades.length} trades. ${smartNow} smart wallets now`, { family, wallets: results.length });
  }
  return "done";
}

function pruneWallets(now) {
  if (wallets.size <= MAX_WALLETS) return;
  const ranked = [...wallets.entries()].sort((a, b) => (b[1].windows - a[1].windows) || (b[1].lastSeen - a[1].lastSeen));
  wallets = new Map(ranked.slice(0, MAX_WALLETS).filter(([, s]) => s.windows >= 2 || now - s.lastSeen < 2 * 86400_000));
}

// ── Copying ─────────────────────────────────────────────────────────
/** The side smart money backed this window: more smart dollars, and only one side if tied. */
export function smartSide(smartFlow) {
  const up = smartFlow?.Up || 0, down = smartFlow?.Down || 0;
  if (up === down) return null;
  return up > down ? "Up" : "Down";
}

/** What buying `side` costs on US right now (Down is the complement of the Up bid). */
function sidePrice(side, us) {
  const price = side === "Up" ? us?.ask : (us?.bid != null ? +(1 - us.bid).toFixed(4) : null);
  return price != null && price >= 0.01 && price <= 0.99 ? price : null;
}

/** Time checks shared by both entry rules. */
function timeGate(us, now, cfg) {
  if (!us) return { enter: false, code: "no-us", why: "no matching Polymarket US window live" };
  const left = us.end - now;
  if (left > cfg.entryWindowMs) return { enter: false, wait: true, code: "early", why: `waiting for the last ${Math.round(cfg.entryWindowMs / 60000)} minutes` };
  if (left < cfg.minMsLeft) return { enter: false, code: "late", why: "too close to the close" };
  return null;
}

/**
 * The plain rule: in the last few minutes of the window (cfg.entryWindowMs), buy the side
 * smart wallets put the most $20+ buys on, if it costs minPrice-maxPrice on US.
 * `wait: true` means "not yet" (too early), which isn't worth a feed line.
 */
export function decideEntry({ smartFlow, us, holding, now, cfg = CFG }) {
  if (holding) return { enter: false, code: "holding", why: "already holding this window" };
  const g = timeGate(us, now, cfg); if (g) return g;
  const side = smartSide(smartFlow);
  if (!side) return { enter: false, code: "no-side", why: "no smart-wallet side this window" };
  const price = sidePrice(side, us);
  if (price == null) return { enter: false, code: "no-price", why: "no valid US price" };
  if (price < cfg.minPrice) return { enter: false, code: "cheap", why: `US ${side} is ${cents(price)}, under the ${cents(cfg.minPrice)} minimum` };
  if (price > cfg.maxPrice) return { enter: false, code: "dear", why: `US ${side} is ${cents(price)}, over the ${cents(cfg.maxPrice)} cap` };
  return { enter: true, side, price };
}

/**
 * Smart-money consensus from votes = { Up: Map(wallet -> {weight}), Down: ... }: the side
 * with more vote weight, how many smart wallets back it and against it, and its share.
 */
export function consensus(votes) {
  const sum = side => [...(votes?.[side]?.values() || [])].reduce((a, v) => a + v.weight, 0);
  const count = side => [...(votes?.[side]?.values() || [])].filter(v => v.weight > 0).length;
  const wUp = sum("Up"), wDown = sum("Down"), nUp = count("Up"), nDown = count("Down");
  if (wUp === wDown) return { side: null, agree: 0, against: 0, share: 0, wUp, wDown, nUp, nDown };
  const side = wUp > wDown ? "Up" : "Down";
  return { side, agree: side === "Up" ? nUp : nDown, against: side === "Up" ? nDown : nUp, share: +(Math.max(wUp, wDown) / (wUp + wDown)).toFixed(4), wUp, wDown, nUp, nDown };
}

/** Add a smart wallet's buy to the votes. Its weight grows a little with size, up to 2x. */
export function addVote(votes, { wallet, name, outcome, usd: amt, price, lateN = 0, lateWinRate = null }, weight) {
  const v = votes[outcome].get(wallet) || { usd: 0, weight: 0, name, price };
  v.usd += amt; v.price = price; v.lateN = lateN; v.lateWinRate = lateWinRate;
  v.weight = +(weight * Math.min(2, 1 + v.usd / 100)).toFixed(4);
  votes[outcome].set(wallet, v);
}

const normCdf = x => {   // Abramowitz-Stegun 26.2.17, error < 1e-7
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

/** Realized BTC volatility per √ms from recent [t, price] spot ticks; the default when there are too few. */
export function spotVol(pxs, cfg = CFG) {
  let ss = 0, dt = 0, n = 0;
  for (let i = 1; i < (pxs?.length || 0); i++) {
    const [t0, a] = pxs[i - 1], [t1, b] = pxs[i];
    if (!(a > 0 && b > 0) || t1 <= t0) continue;
    const r = Math.log(b / a); ss += r * r; dt += t1 - t0; n++;
  }
  const def = cfg.defaultVol / Math.sqrt(365 * 86400_000);
  if (n < 20 || dt <= 0) return def;
  return Math.max(def * 0.3, Math.sqrt(ss / dt));   // a stale, flat feed can't claim certainty
}

/**
 * What our side is worth: the average of (a) the chance BTC finishes on our side of the
 * strike, from spot, strike, time left and volatility (plus a little slack because our
 * spot is Coinbase, not the BRTI the window settles on), and (b) the latest global
 * Polymarket price for our side. Either can be missing; fair is null if both are.
 */
export function fairValue({ side, us, globalPx, now, cfg = CFG }) {
  let model = null;
  if (us?.spot > 0 && us?.strike > 0 && us.end > now) {
    const sig = spotVol(us.pxs, cfg), tau = us.end - now;
    const sd = Math.sqrt(sig * sig * tau + (cfg.basisUsd / us.spot) ** 2);
    const pUp = normCdf(Math.log(us.spot / us.strike) / sd);
    model = +(side === "Up" ? pUp : 1 - pUp).toFixed(4);
  }
  const g = globalPx && now - globalPx.t <= cfg.globalFreshMs ? globalPx.px : null;
  const parts = [model, g].filter(x => x != null);
  return { model, global: g, fair: parts.length ? +(parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(4) : null };
}

/**
 * Everything the smart rule knows about a window right now: consensus, our price, fair
 * value, edge (fair minus price minus the taker fee, per share) and the bet-size tier.
 * Tier points: +1 for 3+ agreeing wallets, +1 for 85%+ of the vote weight, +1 for 5¢+ edge,
 * -1 when the edge is under 2¢ or unknown. 2+ is strong, below 0 is weak.
 */
export function signalOf({ votes, us, globalPx, now, cfg = CFG }) {
  const c = consensus(votes);
  const out = { ...c, price: null, model: null, global: null, fair: null, edge: null, tier: null };
  if (!c.side || !us) return out;
  const price = sidePrice(c.side, us);
  if (price == null) return out;
  const fv = fairValue({ side: c.side, us, globalPx: globalPx?.[c.side], now, cfg });
  const edge = fv.fair == null ? null : +(fv.fair - price - takerFee(1, price)).toFixed(4);
  const pts = (c.agree >= 3) + (c.share >= 0.85) + (edge != null && edge >= 0.05) - (edge == null || edge < 0.02);
  return { ...out, price, ...fv, edge, tier: pts >= 2 ? "strong" : pts < 0 ? "weak" : "normal" };
}

/**
 * Safety brakes for one rule's book: no new bets after the day's losses reach the limit
 * (UTC day), and a pause after `lossStreak` losses in a row.
 */
export function safetyCheck(bk, now, cfg = CFG) {
  const day = new Date(now).toISOString().slice(0, 10);
  const settled = bk.closed.filter(p => p.won != null && Number.isFinite(p.pnl)).sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  const today = +settled.filter(p => new Date(p.closedAt || 0).toISOString().slice(0, 10) === day).reduce((a, p) => a + p.pnl, 0).toFixed(2);
  if (cfg.dailyLossLimit > 0 && today <= -cfg.dailyLossLimit) return { ok: false, code: "limit", why: `daily loss limit hit (${usd(today)} today, limit -$${cfg.dailyLossLimit})`, today };
  const k = cfg.lossStreak;
  if (k > 0 && settled.length >= k) {
    const lastK = settled.slice(-k);
    const until = (lastK[k - 1].closedAt || 0) + cfg.pauseMs;
    if (lastK.every(p => p.pnl < 0) && now < until) return { ok: false, code: "pause", why: `paused after ${k} losses in a row, back at ${new Date(until).toISOString().slice(11, 16)}Z`, today, until };
  }
  return { ok: true, today };
}

/**
 * The smart rule: same time window and price band as the plain rule, but it needs at
 * least minAgree smart wallets on the side with minShare of the vote weight, the US price
 * must not be above fair value, the safety brakes must be off, and the bet is sized
 * $5 / $10 / $15 by the signal's tier.
 */
export function decideSmart({ votes, us, holding, now, cfg = CFG, globalPx, safety }) {
  if (holding) return { enter: false, code: "holding", why: "already holding this window" };
  const g = timeGate(us, now, cfg); if (g) return g;
  if (safety && !safety.ok) return { enter: false, code: safety.code, why: safety.why };
  const s = signalOf({ votes, us, globalPx, now, cfg });
  if (!s.side) return { enter: false, code: "no-side", why: "no smart-wallet side this window" };
  const strongSolo = cfg.soloLateN > 0 && [...(votes?.[s.side]?.values() || [])]
    .some(v => v.weight > 0 && v.lateN >= cfg.soloLateN && v.lateWinRate >= cfg.soloLateWin);
  if (s.agree < cfg.minAgree && !strongSolo) return { enter: false, code: "agree", why: `only ${s.agree} smart wallet${s.agree === 1 ? "" : "s"} on ${s.side}, need ${cfg.minAgree}` };
  if (s.share < cfg.minShare) return { enter: false, code: "split", why: `smart money split: ${Math.round(s.share * 100)}% on ${s.side}, need ${Math.round(cfg.minShare * 100)}%` };
  if (s.price == null) return { enter: false, code: "no-price", why: "no valid US price" };
  if (s.price < cfg.minPrice) return { enter: false, code: "cheap", why: `US ${s.side} is ${cents(s.price)}, under the ${cents(cfg.minPrice)} minimum` };
  if (s.price > cfg.maxPrice) return { enter: false, code: "dear", why: `US ${s.side} is ${cents(s.price)}, over the ${cents(cfg.maxPrice)} cap` };
  // Only the global Polymarket price can veto a bet. The BTC math alone runs on Coinbase spot
  // and an estimated strike, and in live use it called two winners overpriced, so on its own
  // it can only shrink the bet to the weak size.
  if (s.edge != null && s.edge < cfg.minEdge && s.global != null) return { enter: false, code: "edge", why: `US ${s.side} at ${cents(s.price)} costs more than it's worth (fair ${cents(s.fair)}${fairParts(s)})` };
  const tier = s.edge != null && s.edge < cfg.minEdge ? "weak" : s.tier;
  const stake = tier === "strong" ? cfg.sizeStrong : tier === "weak" ? cfg.sizeWeak : cfg.stake;
  return { enter: true, side: s.side, price: s.price, stake, tier, signal: s };
}
const fairParts = s => { const p = [s.model != null && `BTC math ${cents(s.model)}`, s.global != null && `global ${cents(s.global)}`].filter(Boolean); return p.length ? `: ${p.join(", ")}` : ""; };

// ── Rules run side by side ──────────────────────────────────────────
/**
 * Every rule trades the same windows on paper with its own book, so they can be compared
 * on the same markets. "main" is SHADOW itself. Plain rules skip the smart filters and the
 * safety brakes, so they show what the bare rule does.
 */
export const VARIANTS = [
  { id: "main", name: "SHADOW", smart: true, over: {} },
  { id: "rule72", name: "72¢ rule, plain", smart: false, over: { dailyLossLimit: 0, lossStreak: 0 } },
  { id: "rule80", name: "80¢ rule, plain", smart: false, over: { entryWindowMs: 180_000, minPrice: 0.80, dcaLow: 0.58, dcaHigh: 0.66, dailyLossLimit: 0, lossStreak: 0 } },
  { id: "nodca", name: "SHADOW, no DCA", smart: true, over: { dcaUsd: 0 } },
  { id: "stop15", name: "SHADOW, 15¢ stop", smart: true, over: { stopPrice: 0.15 } },
  { id: "nostop", name: "SHADOW, no stop", smart: true, over: { stopPrice: 0 } },
  { id: "solo", name: "SHADOW, 1 strong wallet", smart: true, over: { soloLateN: 10, soloLateWin: 0.9 } },
];
export const cfgOf = v => ({ ...CFG, ...v.over });
const activeVariants = () => VARIANTS.filter(v => v.id === "main" || CFG.variants);
const tagOf = v => (v.id === "main" ? "" : `[${v.name}] `);
export function ruleText(v) {
  const c = cfgOf(v);
  return [`last ${Math.round(c.entryWindowMs / 60000)} min`, `${cents(c.minPrice)}-${cents(c.maxPrice)}`,
    v.smart ? `${c.minAgree}+ smart wallets agree${c.soloLateN > 0 ? ` (or 1 with ${c.soloLateN}+ late bets, ${Math.round(c.soloLateWin * 100)}%+ won)` : ""}, not above fair value, $${c.sizeWeak}/$${c.stake}/$${c.sizeStrong} by signal` : `one $${c.minSignalUsd}+ smart buy, $${c.stake}`,
    c.dcaUsd > 0 ? `DCA at ${cents(c.dcaLow)}-${cents(c.dcaHigh)}` : "no DCA", c.stopPrice > 0 ? `stop ${cents(c.stopPrice)}` : "no stop",
    v.smart && c.dailyLossLimit > 0 ? `brakes: -$${c.dailyLossLimit}/day, pause after ${c.lossStreak} losses` : null].filter(Boolean).join(" · ");
}
function bookOf(id) {
  let b = books.get(id);
  if (!b) { b = { open: [], closed: [] }; books.set(id, b); }
  return b;
}

function openPaper({ v, family, trade, us, price, now, stake, extra = {} }) {
  const cfg = cfgOf(v), bk = bookOf(v.id);
  if (!(price >= 0.01 && price <= 0.99)) { emit("error", `${tagOf(v)}refused to open at an impossible price ${price}`, { family, variant: v.id }); return; }
  const contracts = stake / price;
  const fee = takerFee(contracts, price);
  const pos = { id: `${us.slug}`, variant: v.id, family, usSlug: us.slug, end: us.end, side: trade.outcome, price, contracts: +contracts.toFixed(4),
    fee: +fee.toFixed(4), cost: +(stake + fee).toFixed(4), staked: stake, dcaUsd: +(cfg.dcaUsd * stake / cfg.stake).toFixed(2), avg: price, dca: null, openedAt: now,
    wallet: trade.wallet, walletName: trade.name, theirPrice: trade.price, theirUsd: +(trade.usd ?? 0).toFixed(2), why: trade.why, ...extra };
  bk.open.push(pos);
  const sig = extra.signal;
  const head = sig ? `${sig.agree} smart wallet${sig.agree === 1 ? "" : "s"} (${Math.round(sig.share * 100)}% of smart weight)` : short(trade.wallet);
  const tail = sig ? ` · ${extra.tier} signal${sig.fair != null ? `, fair ${cents(sig.fair)}${fairParts(sig)}, edge ${sig.edge >= 0 ? "+" : ""}${Math.round(sig.edge * 100)}¢` : ", no fair value available"}`
    : `. They paid ${cents(trade.price)} for ${usd(pos.theirUsd)}`;
  emit("copy", `${tagOf(v)}COPIED ${head} → paper ${pos.side} on US ${family.toUpperCase()} @ ${cents(price)} ($${stake} + ${usd(fee)} fee)${tail}`, { family, variant: v.id, pos });
  persistBook(v.id);
}

/** What the position should do at this quote: add on the dip, stop out, or nothing. */
export function decideManage({ pos, us, now, cfg = CFG }) {
  if (!us || us.bid == null || us.ask == null) return null;
  const bid = pos.side === "Up" ? us.bid : +(1 - us.ask).toFixed(4);   // what we could sell for
  const ask = pos.side === "Up" ? us.ask : +(1 - us.bid).toFixed(4);   // what adding would cost
  if (cfg.stopPrice > 0 && bid <= cfg.stopPrice) return { stop: true, price: bid };
  if (!pos.dca && (pos.dcaUsd ?? cfg.dcaUsd) > 0 && bid >= cfg.dcaLow && bid <= cfg.dcaHigh && pos.end - now >= cfg.minMsLeft)
    return { dca: true, price: ask, bid };
  return null;
}

/** Apply a decision to a paper position (mutates it). Returns the closed record on a stop. */
export function applyManage(pos, d, now, cfg = CFG) {
  if (d.dca) {
    const amt = pos.dcaUsd ?? cfg.dcaUsd;
    const add = amt / d.price, fee = takerFee(add, d.price);
    pos.dca = { price: d.price, usd: amt, contracts: +add.toFixed(4), fee: +fee.toFixed(4), at: now, bid: d.bid };
    pos.contracts = +(pos.contracts + add).toFixed(4);
    pos.cost = +(pos.cost + amt + fee).toFixed(4);
    pos.staked = (pos.staked || cfg.stake) + amt;
    pos.avg = +((pos.staked) / pos.contracts).toFixed(4);
    return null;
  }
  if (d.stop) {
    const fee = takerFee(pos.contracts, d.price), proceeds = pos.contracts * d.price - fee;
    return { ...pos, exit: { reason: "stop", price: d.price, fee: +fee.toFixed(4), at: now }, won: false,
      pnl: +(proceeds - pos.cost).toFixed(2), closedAt: now };
  }
  return null;
}

function closeInto(bk, rec) {
  bk.closed.push(rec);
  if (bk.closed.length > 500) bk.closed = bk.closed.slice(-500);
}

function managePositions(now) {
  if (!recorder?.liveQuote) return;
  for (const v of activeVariants()) {
    const bk = bookOf(v.id), cfg = cfgOf(v);
    for (const p of [...bk.open]) {
      const d = decideManage({ pos: p, us: recorder.liveQuote(p.family, p.end), now, cfg });
      if (!d) continue;
      const closed = applyManage(p, d, now, cfg);
      const F = p.family.toUpperCase();
      if (d.dca) emit("dca", `${tagOf(v)}DCA ${F} ${p.side}: our side dipped to ${cents(d.bid)}, added $${p.dca.usd} @ ${cents(d.price)}. Now ${p.contracts.toFixed(2)} shares, avg ${cents(p.avg)}, $${p.staked} in`, { family: p.family, variant: v.id, pos: p });
      if (closed) {
        bk.open = bk.open.filter(x => x !== p);
        closeInto(bk, closed);
        emit("stop", `${tagOf(v)}STOP ${F} ${p.side}: bid ${cents(d.price)} hit the ${cents(cfg.stopPrice)} stop, sold ${p.contracts.toFixed(2)} shares: ${usd(closed.pnl)}${p.dca ? " (after DCA)" : ""}`, { family: p.family, variant: v.id, trade: closed });
      }
      persistBook(v.id);
    }
  }
}

export function settlePaper(rec) {
  for (const v of VARIANTS) {
    const bk = books.get(v.id);
    if (!bk) continue;
    // Stopped-out copies: record what holding would have done, so the stop can be judged.
    for (const c of bk.closed) {
      if (c.usSlug !== rec.slug || !c.exit || c.exit.reason !== "stop" || c.holdWouldWin !== undefined) continue;
      c.holdWouldWin = rec.outcome == null ? null : (rec.outcome === 1) === (c.side === "Up");
      if (c.holdWouldWin != null) emit("settle", `${tagOf(v)}stop check ${c.family.toUpperCase()} ${c.side}: holding would have ${c.holdWouldWin ? `WON +${usd(c.contracts - c.cost)}` : `lost ${usd(-c.cost)}`}; the stop got ${usd(c.pnl)}`, { family: c.family, variant: v.id });
      persistBook(v.id);
    }
    const hit = bk.open.filter(p => p.usSlug === rec.slug);
    if (!hit.length) continue;
    bk.open = bk.open.filter(p => p.usSlug !== rec.slug);
    for (const p of hit) {
      const won = rec.outcome == null ? null : (rec.outcome === 1) === (p.side === "Up");
      const pnl = won == null ? 0 : +((won ? p.contracts : 0) - p.cost).toFixed(2);
      const closed = { ...p, outcome: rec.outcome, won, pnl, closedAt: Date.now() };
      closeInto(bk, closed);
      emit("settle", won == null ? `${tagOf(v)}VOID ${p.family.toUpperCase()} ${p.side}: US result unknown, stake returned`
        : `${tagOf(v)}${won ? "WON" : "LOST"} ${p.family.toUpperCase()} ${p.side} @ ${p.dca ? `avg ${cents(p.avg)} (DCA'd)` : cents(p.price)}: ${pnl >= 0 ? "+" : ""}${usd(pnl)}`, { family: p.family, variant: v.id, trade: closed });
    }
    persistBook(v.id);
  }
}

/**
 * Trades in the live window we haven't seen yet. The public feed's sort order isn't
 * documented, so it's detected: newest-first pages forward until it reaches trades it
 * has seen; oldest-first keeps an offset and reads on from where it stopped.
 */
export async function newTrades(cur) {
  const PAGE = 500, MAX_PAGES = 8, out = [];
  if (cur.order === "asc") {
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await fetchTrades(cur.market, { limit: PAGE, offset: cur.nextOffset });
      cur.nextOffset += page.length;
      out.push(...page);
      if (page.length < PAGE) break;
    }
  } else {
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await fetchTrades(cur.market, { limit: PAGE, offset: i * PAGE });
      if (!cur.order && page.length > 1) {
        const a = page[0].t, b = page[page.length - 1].t;
        if (a !== b) cur.order = a < b ? "asc" : "desc";
        if (cur.order === "asc") { cur.nextOffset = page.length; out.push(...page); if (page.length === PAGE) return out.concat(await newTrades(cur)); return out; }
      }
      const unseen = page.filter(t => !cur.seen.has(t.id));
      out.push(...unseen);
      if (page.length < PAGE || unseen.length < page.length) break;   // reached what we already have
    }
  }
  return out.filter(t => !cur.seen.has(t.id));
}

function windowSummary(family, c) {
  const d = c.diag;
  const order = c.order === "asc" ? "oldest-first" : c.order === "desc" ? "newest-first" : "order unknown";
  emit("window", `${family.toUpperCase()} ${new Date(c.start).toISOString().slice(11, 16)}Z closed: ${d.trades} trades seen (feed ${order}), ` +
    `${d.smartBuys} buys by smart wallets (${d.voters} wallets voted${d.smartSmall ? `; ${d.smartSmall} buys under $${CFG.minVoteUsd} ignored` : ""}), ${d.copies} copied by SHADOW`, { family });
}

async function pollLive(family, now) {
  const start = windowStart(family, now);
  const key = `${family}:${start}`;
  let cur = live[family];
  if (!cur || cur.key !== key) {
    if (cur) { toScore.unshift({ family, start: cur.start, tries: 0 }); windowSummary(family, cur); }   // score the window that just closed first
    const market = await findMarket(family, start);
    cur = live[family] = { key, start, end: start + DUR[family], market, seen: new Set(), flow: { Up: 0, Down: 0 }, smartFlow: { Up: 0, Down: 0 }, smartBest: { Up: null, Down: null },
      votes: { Up: new Map(), Down: new Map() }, lastPx: { Up: null, Down: null },
      skips: new Set(), order: null, nextOffset: 0, newest: 0, warned: false, diag: { trades: 0, smartBuys: 0, smartSmall: 0, voters: 0, copies: 0 } };
    emit("window", market ? `new ${family.toUpperCase()} window ${new Date(start).toISOString().slice(11, 16)}Z: watching global market ${market.slug}`
      : `new ${family.toUpperCase()} window ${new Date(start).toISOString().slice(11, 16)}Z: global market not found yet (tried ${globalSlugs(family, start).join(", ")})`, { family });
  }
  if (!cur.market) {
    cur.market = await findMarket(family, start);
    if (!cur.market) { emit("poll", `${family.toUpperCase()}: global market not found yet${stats.lastError ? ` (${stats.lastError})` : ""}`, { family, n: 0 }); return; }
    emit("window", `found global ${family.toUpperCase()} market ${cur.market.slug}`, { family });
  }
  const fresh = (await newTrades(cur)).sort((a, b) => a.t - b.t);
  for (const t of fresh) { cur.seen.add(t.id); cur.newest = Math.max(cur.newest, t.t); }
  cur.diag.trades += fresh.length;
  // A busy window whose newest trade we see is minutes old means we're reading the wrong end of the feed.
  if (!cur.warned && now - start > 4 * 60_000 && cur.diag.trades > 50 && cur.newest > 0 && now - cur.newest > 3 * 60_000) {
    cur.warned = true;
    emit("error", `${family.toUpperCase()}: newest trade seen is ${Math.round((now - cur.newest) / 60_000)} min old, the live trade feed may be lagging`, { family });
  }
  for (const t of fresh) {
    // Latest global price of each side, for the fair-value check.
    if (t.price > 0 && t.price < 1 && (!cur.lastPx[t.outcome] || t.t >= cur.lastPx[t.outcome].t)) cur.lastPx[t.outcome] = { px: t.price, t: t.t };
    if (t.side !== "BUY") continue;
    const amt = t.size * t.price;
    cur.flow[t.outcome] += amt;
    const s = wallets.get(t.wallet);
    const j = judge(s, now);
    if (!j.smart) continue;
    cur.diag.smartBuys++;
    if (amt < CFG.minVoteUsd) { cur.diag.smartSmall++; continue; }
    // Every smart buy of $2+ is a vote, weighted by the wallet's record (the smart rule).
    const before = cur.votes[t.outcome].has(t.wallet);
    const late = lateStats(s);
    addVote(cur.votes, { wallet: t.wallet, name: t.name, outcome: t.outcome, usd: amt, price: t.price, lateN: late.n, lateWinRate: late.winRate }, walletWeight(s, j));
    if (!before) cur.diag.voters++;
    // The plain rules only count single buys of $20+.
    if (amt < CFG.minSignalUsd) continue;
    cur.smartFlow[t.outcome] += amt;
    const best = cur.smartBest[t.outcome];
    if (!best || amt > best.usd) cur.smartBest[t.outcome] = { wallet: t.wallet, name: t.name, usd: amt, price: t.price, outcome: t.outcome, why: j.why };
    emit("spot", `smart wallet ${short(t.wallet)}${t.name ? ` (${t.name})` : ""} bought ${t.outcome} ${usd(amt)} @ ${cents(t.price)} on global ${family.toUpperCase()} [${j.why}]`, { family, wallet: t.wallet, side: t.outcome, usd: +amt.toFixed(2), price: t.price });
  }
  // Entry check every poll, for every rule.
  const us = recorder?.liveQuote ? recorder.liveQuote(family, cur.end) : null;
  for (const v of activeVariants()) {
    const cfg = cfgOf(v), bk = bookOf(v.id);
    const holding = bk.open.some(p => p.family === family && Math.abs(p.end - cur.end) < 60_000);
    const d = v.smart
      ? decideSmart({ votes: cur.votes, us, holding, now, cfg, globalPx: cur.lastPx, safety: safetyCheck(bk, now, cfg) })
      : decideEntry({ smartFlow: cur.smartFlow, us, holding, now, cfg });
    if (d.enter) {
      if (v.id === "main") cur.diag.copies++;
      if (v.smart) {
        // Name the heaviest smart voter on our side as the wallet "copied".
        const [wallet, top] = [...cur.votes[d.side].entries()].sort((a, b) => b[1].weight - a[1].weight)[0];
        openPaper({ v, family, us, price: d.price, now, stake: d.stake,
          trade: { wallet, name: top.name, outcome: d.side, price: top.price, usd: top.usd, why: judge(wallets.get(wallet), now).why },
          extra: { tier: d.tier, signal: { agree: d.signal.agree, against: d.signal.against, share: d.signal.share, model: d.signal.model, global: d.signal.global, fair: d.signal.fair, edge: d.signal.edge } } });
      } else {
        openPaper({ v, family, us, price: d.price, now, stake: cfg.stake, trade: cur.smartBest[d.side] });
      }
    } else if (v.id === "main" && !d.wait && !holding && !cur.skips.has(d.code)) { cur.skips.add(d.code); emit("skip", `not entering: ${d.why}`, { family }); }
  }
  stats.lastPollAt = Date.now();
  emit("poll", `${family.toUpperCase()} poll: ${fresh.length} new trades`, { family, n: fresh.length });
}

async function workScoreQueue(now) {
  // Live windows that just closed come first; backfill fills in the rest.
  const job = toScore[0];
  if (!job) return;
  if (job.start + DUR[job.family] > now) return;
  try {
    const r = await scoreWindow(job.family, job.start, { quiet: !!job.backfill });
    if ((r === "unresolved" || r === "no-market") && ++job.tries < 40 && !job.backfill) { toScore.push(toScore.shift()); return; }
    toScore.shift();
    if (job.backfill) {
      stats.backfillDone++;
      if (r !== "done") stats.backfillMissing++;
      if (stats.backfillDone % 10 === 0 || stats.backfillDone === stats.backfillTotal) {
        const smartNow = [...wallets.values()].filter(s => judge(s, now).smart).length;
        const miss = stats.backfillMissing ? `, ${stats.backfillMissing} couldn't be read${stats.lastError ? ` (last error: ${stats.lastError})` : ""}` : "";
        emit(stats.backfillMissing === stats.backfillDone ? "error" : "score", `history: went through ${stats.backfillDone}/${stats.backfillTotal} past windows${miss}. ${wallets.size} wallets tracked, ${smartNow} smart`, {});
      }
    }
  } catch (err) {
    stats.apiErrors++; stats.lastError = err.message;
    toScore.push(toScore.shift());
    emit("error", `scoring ${job.family} window failed: ${err.message}`, {});
  }
}

// ── Persistence ─────────────────────────────────────────────────────
let walletsSavedAt = 0, walletsSavedScored = 0, eventsSavedAt = 0, eventsSavedLen = -1;
const dirtyBooks = new Set();
function persistBook(id = "main") { dirtyBooks.add(id); }
const r2 = n => Math.round(n * 100) / 100;
// Keeps Redis writes low: books when they change, wallets at most every 10 min, events every 5 min.
async function persistAll() {
  const now = Date.now();
  for (const id of [...dirtyBooks]) { dirtyBooks.delete(id); await saveJSON(`${KEY_BOOK}:${id}`, bookOf(id)); }
  if (stats.windowsScored !== walletsSavedScored && now - walletsSavedAt >= 10 * 60_000) {
    pruneWallets(now);
    walletsSavedAt = now; walletsSavedScored = stats.windowsScored;
    const r4 = n => (n == null ? n : Math.round(n * 1e4) / 1e4);
    await saveJSON(KEY_WALLETS, { savedAt: now, scored: [...scored].slice(-1500),
      wallets: [...wallets.entries()].map(([a, w]) => [a, { ...w, pnl: r2(w.pnl), cost: r2(w.cost), best: r2(w.best), rn: r4(w.rn), rw: r4(w.rw), lN: r4(w.lN), lW: r4(w.lW), lP: r4(w.lP) }]) });
  }
  if (events.length && events[events.length - 1].t !== eventsSavedLen && now - eventsSavedAt >= 5 * 60_000) {
    eventsSavedAt = now; eventsSavedLen = events[events.length - 1].t;
    await saveJSON(KEY_EVENTS, events.slice(-150));
  }
}

// ── Status / start ──────────────────────────────────────────────────
function bookSummary(bk, now, cfg) {
  const settled = bk.closed.filter(p => p.won != null && Number.isFinite(p.pnl));
  const pnl = settled.reduce((a, p) => a + p.pnl, 0);
  const stops = settled.filter(p => p.exit?.reason === "stop");
  return { copies: bk.closed.length + bk.open.length, open: bk.open.length, settled: settled.length,
    wins: settled.filter(p => p.won).length, losses: settled.filter(p => !p.won).length, pnl: +pnl.toFixed(2),
    avg: settled.length ? +(pnl / settled.length).toFixed(2) : null, staked: +settled.reduce((a, p) => a + (p.staked ?? cfg.stake), 0).toFixed(2),
    dcas: settled.filter(p => p.dca).length, stops: stops.length, stopsThatWouldWin: stops.filter(p => p.holdWouldWin).length };
}
const curveOf = (bk, cfg) => bk.closed.filter(p => p.won != null && Number.isFinite(p.pnl)).sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))
  .map(p => ({ t: p.closedAt, family: p.family, side: p.side, price: p.price, avg: p.avg ?? p.price, staked: p.staked ?? cfg.stake, dca: !!p.dca,
    stop: p.exit?.reason === "stop", won: p.won, pnl: p.pnl, tier: p.tier || null }));

export function copyStatus(now = Date.now()) {
  const smartAll = [...wallets.entries()].map(([a, s]) => ({ a, s, j: judge(s, now) })).filter(x => x.j.smart);
  const smart = smartAll.map(x => ({ ...x, w: walletWeight(x.s, x.j) }))
    .sort((x, y) => y.w - x.w)
    .slice(0, 20).map(({ a, s, j, w }) => {
      const late = lateStats(s);
      return { wallet: a, name: s.name, windows: s.windows, winRate: +j.winRate.toFixed(3), roi: +j.roi.toFixed(3), pnl: +s.pnl.toFixed(2), lastSeen: s.lastSeen,
        weight: w, lateN: +late.n.toFixed(1), lateWinRate: late.winRate == null ? null : +late.winRate.toFixed(3), lateEdge: +late.edge.toFixed(3) };
    });
  const main = VARIANTS[0], mcfg = cfgOf(main), bk = bookOf("main");
  const sum = bookSummary(bk, now, mcfg);
  const cur = f => {
    const c = live[f]; if (!c) return null;
    const us = recorder?.liveQuote ? recorder.liveQuote(f, c.end) : null;
    const sig = signalOf({ votes: c.votes, us, globalPx: c.lastPx, now, cfg: mcfg });
    const voters = side => [...c.votes[side].entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, 5)
      .map(([w, v]) => ({ wallet: w, name: v.name, usd: +v.usd.toFixed(2), weight: v.weight }));
    return { start: c.start, end: c.end, globalSlug: c.market?.slug || null, flow: c.flow, smartFlow: c.smartFlow,
      us: us ? { slug: us.slug, end: us.end, t: us.t, bid: us.bid, ask: us.ask, spot: us.spot, strike: us.strike } : null,
      signal: { ...sig, stake: sig.tier === "strong" ? mcfg.sizeStrong : sig.tier === "weak" ? mcfg.sizeWeak : mcfg.stake, voters: { Up: voters("Up"), Down: voters("Down") } },
      position: bk.open.find(p => p.family === f && Math.abs(p.end - c.end) < 60_000) || null };
  };
  return {
    enabled: stats.enabled, paper: true, now, cfg: mcfg, stats: { ...stats, trackedWallets: wallets.size, walletCap: MAX_WALLETS, smartWallets: smartAll.length,
      // The tracked count sits at the cap once memory is full, so also show what's moving.
      activeWallets: [...wallets.values()].filter(w => now - w.lastSeen < 86400_000).length,
      provenWallets: [...wallets.values()].filter(w => w.windows >= CFG.minWindows).length,
      ...sum, recorderOn: !!recorder?.recorderStatus?.().enabled, queue: toScore.length },
    safety: safetyCheck(bk, now, mcfg),
    current: { btc15: cur("btc15"), btc60: cur("btc60") },
    smart, open: bk.open, closed: bk.closed.slice(-25).reverse(),
    // Every settled copy in order, for the P&L chart.
    curve: curveOf(bk, mcfg),
    variants: activeVariants().map(v => {
      const c = cfgOf(v), b = bookOf(v.id);
      return { id: v.id, name: v.name, smart: v.smart, rule: ruleText(v), ...bookSummary(b, now, c),
        safety: v.smart ? safetyCheck(b, now, c) : null, curve: curveOf(b, c).map(p => [p.t, p.pnl]) };
    }),
  };
}
export function recentEvents(n = 120) { return events.slice(-n); }

/**
 * SHADOW's settled paper copies as /colony leaderboard rows, one per family, in the
 * arena's units ($10 stake, P&L per trade after fees). Every copy is a live trade, so
 * all of them count as forward. Verdicts follow the arena's rules without the
 * tape-only checks (halves, baseline). The side-by-side rules get rows once they've traded.
 */
export function leaderboardRows() {
  const out = [];
  for (const v of activeVariants()) {
    const bk = bookOf(v.id);
    for (const family of ["btc15", "btc60"]) {
      const trades = bk.closed.filter(p => p.family === family && p.won != null && Number.isFinite(p.pnl));
      const n = trades.length;
      if (v.id !== "main" && !n) continue;
      // P&L per $10 staked, so rules with bigger or smaller bets compare fairly.
      const per = trades.map(t => t.pnl * 10 / (t.staked || 10));
      const pnl = per.reduce((a, x) => a + x, 0), mean = n ? pnl / n : null;
      const sd = n > 1 ? Math.sqrt(per.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
      const se = sd != null ? sd / Math.sqrt(n) : null;
      const lcb = se != null ? mean - 1.96 * se : null, ucb = se != null ? mean + 1.96 * se : null;
      const verdict = n < 30 ? "too early" : ucb < 0 ? "losing" : lcb > 0 ? "promising" : "unproven";
      const why = n < 30 ? `${n} live paper copies so far; needs 30 to say anything`
        : verdict === "losing" ? "even the optimistic estimate loses money per copy"
        : verdict === "promising" ? "profitable so far with 95% confidence; keep watching before trusting it"
        : "no clear edge yet; the range still includes losing";
      out.push({ id: v.id === "main" ? `shadow-copy-${family}` : `shadow-${v.id}-${family}`, name: v.id === "main" ? "shadow-copy" : `shadow-${v.id}`, family, author: "SHADOW",
        created: stats.startedAt ? new Date(stats.startedAt).toISOString().slice(0, 10) : null,
        n, mean, lcb, ucb, fwdN: n, fwdMean: mean, verdict, why: `${v.name} (${ruleText(v)}): ${why}` });
    }
  }
  return out;
}

export async function startCopyTrader() {
  if (process.env.COPY_TRADER === "false") { console.log("👥 Copy trader (SHADOW) off (COPY_TRADER=false)"); return; }
  if (stats.enabled) return;
  stats.enabled = true; stats.startedAt = Date.now();
  try { recorder = await import("./recorder.js"); recorder.onWindowSettled(settlePaper); } catch (err) { recorder = null; stats.lastError = `recorder: ${err.message}`; }

  const saved = await loadJSON(KEY_WALLETS);
  if (saved?.wallets) { wallets = new Map(saved.wallets); for (const k of saved.scored || []) scored.add(k); }
  for (const v of activeVariants()) {
    const sb = await loadJSON(`${KEY_BOOK}:${v.id}`);
    const b = { open: sb?.open || [], closed: sb?.closed || [] };
    // Never let a bad number (e.g. a 0¢ quote) poison the totals.
    b.open = b.open.filter(p => Number.isFinite(p.contracts) && Number.isFinite(p.cost) && p.price > 0);
    for (const c of b.closed) if (!Number.isFinite(c.pnl)) { c.pnl = 0; c.won = null; }
    books.set(v.id, b);
  }
  const savedEvents = await loadJSON(KEY_EVENTS);
  if (Array.isArray(savedEvents)) events = savedEvents;

  // Score recent history so there are wallets to judge from the start. Oldest first, so
  // the recency weighting sees windows in time order.
  const now = Date.now();
  for (const [family, n] of [["btc15", CFG.backfill15], ["btc60", CFG.backfill60]]) {
    const cur = windowStart(family, now);
    for (let i = n; i >= 1; i--) {
      const start = cur - i * DUR[family];
      if (!scored.has(`${family}:${start}`)) toScore.push({ family, start, backfill: true, tries: 0 });
    }
  }
  toScore.sort((a, b) => a.start - b.start);
  stats.backfillTotal = toScore.length;
  emit("start", `SHADOW on (paper only): ${wallets.size} wallets remembered, scoring ${toScore.length} past windows. Rule: ${ruleText(VARIANTS[0])}.` +
    ` ${activeVariants().length - 1} other rules run side by side on paper${recorder ? "" : ". Recorder unavailable: can't price US copies"}`, {});

  let busyLive = false, busyScore = false;
  timers.push(setInterval(async () => {
    if (busyLive) return; busyLive = true; stats.polls++;
    for (const f of ["btc15", "btc60"]) {
      try { await pollLive(f, Date.now()); }
      catch (err) { stats.apiErrors++; stats.lastError = err.message; emit("error", `${f.toUpperCase()} live poll failed: ${err.message}`, { family: f }); }
    }
    busyLive = false;
  }, CFG.pollMs));
  timers.push(setInterval(async () => {
    if (busyScore) return; busyScore = true;
    try { await workScoreQueue(Date.now()); } finally { busyScore = false; }
  }, 2500));
  timers.push(setInterval(() => { try { managePositions(Date.now()); } catch (err) { stats.lastError = `manage: ${err.message}`; } }, CFG.manageMs));
  timers.push(setInterval(() => persistAll().catch(() => {}), 60_000));
  console.log(`👥 Copy trader (SHADOW) on — paper copies of smart global-Polymarket BTC wallets onto Polymarket US, every ${CFG.pollMs / 1000}s`);
}
