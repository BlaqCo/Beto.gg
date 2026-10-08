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
 *   3. Entering. During a live window it polls the newest trades and adds up what smart
 *      wallets buy on each side. In the last 4 minutes, if smart money backed a side and
 *      that side costs 72-95¢ on Polymarket US, it makes a $10 paper bet at the US ask
 *      (after the taker fee), adds $20 once on a dip to 53-63¢, stops out at 22¢, and
 *      otherwise settles on the US result.
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
  minSignalUsd: env("COPY_MIN_SIGNAL_USD", 20), // ignore their dust trades
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
  backfill15: env("COPY_BACKFILL_BTC15", 96),   // windows to score on startup (96 = one day)
  backfill60: env("COPY_BACKFILL_BTC60", 24),
  maxTradesPerWindow: env("COPY_MAX_TRADES_PER_WINDOW", 5000),
};

const DUR = { btc15: 15 * 60_000, btc60: 60 * 60_000 };
// v2: v1 held hourly scores from year-old markets (a slug without a year matched 2025).
// book v3: results under the last-4-minutes / 72¢+ entry rule (v2 = last 3 min / 80¢+, kept in Redis).
const KEY_WALLETS = "arena:copy:wallets:v2", KEY_BOOK = "arena:copy:book:v3", KEY_EVENTS = "arena:copy:events";
const MAX_EVENTS = 300, MAX_WALLETS = 3000;   // keeps the saved wallet list well under Redis's 1 MB request limit

// ── State ───────────────────────────────────────────────────────────
const bus = new EventEmitter(); bus.setMaxListeners(100);
let events = [];                         // newest last
let wallets = new Map();                 // address -> stats
let book = { open: [], closed: [] };     // paper positions
const scored = new Set();                // "family:start" windows already scored
const marketCache = new Map();           // "family:start" -> market | { missUntil }
const live = { btc15: null, btc60: null };  // current window: { key, market, seen:Set, flow:{Up,Down} }
const toScore = [];                      // queue of { family, start }
const stats = { enabled: false, startedAt: 0, polls: 0, apiErrors: 0, lastError: null, lastApiOkAt: 0, windowsScored: 0, backfillTotal: 0, backfillDone: 0, backfillMissing: 0 };
let fetchImpl = (...a) => fetch(...a);
let recorder = null;
let timers = [];

export function _setFetch(fn) { fetchImpl = fn; }               // tests
export function _reset() { events = []; wallets = new Map(); book = { open: [], closed: [] }; scored.clear(); marketCache.clear(); live.btc15 = live.btc60 = null; toScore.length = 0; }

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
/** Each wallet's result on one settled window: cash from trades plus $1 per winning share. */
export function scoreTrades(trades, outcome) {
  const per = new Map();
  for (const t of trades) {
    const w = per.get(t.wallet) || { up: 0, down: 0, cash: 0, cost: 0, boughtUp: false, boughtDown: false, name: t.name };
    const n = t.size, amt = t.size * t.price;
    if (t.side === "BUY") { w.cash -= amt; w.cost += amt; if (t.outcome === "Up") { w.up += n; w.boughtUp = true; } else { w.down += n; w.boughtDown = true; } }
    else { w.cash += amt; if (t.outcome === "Up") w.up -= n; else w.down -= n; }
    per.set(t.wallet, w);
  }
  const out = [];
  for (const [wallet, w] of per) {
    if (w.cost <= 0) continue;   // sold only: shares bought before this window's trades we saw
    out.push({ wallet, name: w.name, cost: w.cost, pnl: w.cash + (outcome ? w.up : w.down), both: w.boughtUp && w.boughtDown });
  }
  return out;
}

export function addResult(map, r, t) {
  const s = map.get(r.wallet) || { windows: 0, wins: 0, pnl: 0, cost: 0, both: 0, best: 0, lastSeen: 0, name: null };
  s.windows++; if (r.pnl > 0) s.wins++; s.pnl += r.pnl; s.cost += r.cost; if (r.both) s.both++;
  s.best = Math.max(s.best, r.pnl); s.lastSeen = Math.max(s.lastSeen, t); if (r.name) s.name = r.name;
  map.set(r.wallet, s);
}

/** Why a wallet is (or isn't) worth copying. */
export function judge(s, now, cfg = CFG) {
  if (!s) return { smart: false, why: "never seen on a settled window" };
  if (s.windows < cfg.minWindows) return { smart: false, why: `only ${s.windows}/${cfg.minWindows} settled windows` };
  if (now - s.lastSeen > cfg.activeMs) return { smart: false, why: "not active recently" };
  const winRate = s.wins / s.windows, roi = s.cost > 0 ? s.pnl / s.cost : 0;
  if (s.both / s.windows > cfg.maxBothSides) return { smart: false, why: "trades both sides (market maker / arb bot)" };
  if (roi < cfg.minRoi) return { smart: false, why: `ROI ${(roi * 100).toFixed(1)}% below ${(cfg.minRoi * 100).toFixed(0)}%` };
  if (winRate < cfg.minWinRate) return { smart: false, why: `win rate ${(winRate * 100).toFixed(0)}% below ${(cfg.minWinRate * 100).toFixed(0)}%` };
  if (s.pnl > 0 && s.best / s.pnl > cfg.maxBestShare) return { smart: false, why: "most profit came from one window" };
  return { smart: true, why: `${s.windows} windows, ${(winRate * 100).toFixed(0)}% wins, ROI ${(roi * 100).toFixed(1)}%`, winRate, roi };
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
  const results = scoreTrades(trades, outcome);
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

/**
 * Should SHADOW enter now? Rule: in the last few minutes of the window (cfg.entryWindowMs),
 * buy the side smart wallets backed this window, only if that side costs minPrice-maxPrice on US.
 * `wait: true` means "not yet" (too early), which isn't worth a feed line.
 */
export function decideEntry({ smartFlow, us, holding, now, cfg = CFG }) {
  if (holding) return { enter: false, why: "already holding this window" };
  if (!us) return { enter: false, why: "no matching Polymarket US window live" };
  const left = us.end - now;
  if (left > cfg.entryWindowMs) return { enter: false, wait: true, why: `waiting for the last ${Math.round(cfg.entryWindowMs / 60000)} minutes` };
  if (left < cfg.minMsLeft) return { enter: false, why: "too close to the close" };
  const side = smartSide(smartFlow);
  if (!side) return { enter: false, why: "no smart-wallet side this window" };
  const price = side === "Up" ? us.ask : (us.bid != null ? +(1 - us.bid).toFixed(4) : null);
  if (price == null || !(price >= 0.01 && price <= 0.99)) return { enter: false, why: "no valid US price" };
  if (price < cfg.minPrice) return { enter: false, why: `US ${side} is ${cents(price)}, under the ${cents(cfg.minPrice)} minimum` };
  if (price > cfg.maxPrice) return { enter: false, why: `US ${side} is ${cents(price)}, over the ${cents(cfg.maxPrice)} cap` };
  return { enter: true, side, price };
}

function openPaper({ family, trade, us, price, now, judged }) {
  if (!(price >= 0.01 && price <= 0.99)) { emit("error", `refused to open at an impossible price ${price}`, { family }); return; }
  const contracts = CFG.stake / price;
  const fee = takerFee(contracts, price);
  const pos = { id: `${us.slug}`, family, usSlug: us.slug, end: us.end, side: trade.outcome, price, contracts: +contracts.toFixed(4),
    fee: +fee.toFixed(4), cost: +(CFG.stake + fee).toFixed(4), staked: CFG.stake, avg: price, dca: null, openedAt: now, wallet: trade.wallet, walletName: trade.name,
    theirPrice: trade.price, theirUsd: +(trade.size * trade.price).toFixed(2), why: judged.why };
  book.open.push(pos);
  emit("copy", `COPIED ${short(trade.wallet)} → paper ${pos.side} on US ${family.toUpperCase()} @ ${cents(price)} ($${CFG.stake} + ${usd(fee)} fee). They paid ${cents(trade.price)} for ${usd(pos.theirUsd)}`, { family, pos });
  persistBook();
}

/** What the position should do at this quote: add on the dip, stop out, or nothing. */
export function decideManage({ pos, us, now, cfg = CFG }) {
  if (!us || us.bid == null || us.ask == null) return null;
  const bid = pos.side === "Up" ? us.bid : +(1 - us.ask).toFixed(4);   // what we could sell for
  const ask = pos.side === "Up" ? us.ask : +(1 - us.bid).toFixed(4);   // what adding would cost
  if (cfg.stopPrice > 0 && bid <= cfg.stopPrice) return { stop: true, price: bid };
  if (!pos.dca && cfg.dcaUsd > 0 && bid >= cfg.dcaLow && bid <= cfg.dcaHigh && pos.end - now >= cfg.minMsLeft)
    return { dca: true, price: ask, bid };
  return null;
}

/** Apply a decision to a paper position (mutates it). Returns the closed record on a stop. */
export function applyManage(pos, d, now, cfg = CFG) {
  if (d.dca) {
    const add = cfg.dcaUsd / d.price, fee = takerFee(add, d.price);
    pos.dca = { price: d.price, contracts: +add.toFixed(4), fee: +fee.toFixed(4), at: now, bid: d.bid };
    pos.contracts = +(pos.contracts + add).toFixed(4);
    pos.cost = +(pos.cost + cfg.dcaUsd + fee).toFixed(4);
    pos.staked = (pos.staked || cfg.stake) + cfg.dcaUsd;
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

function managePositions(now) {
  if (!recorder?.liveQuote || !book.open.length) return;
  for (const p of [...book.open]) {
    const d = decideManage({ pos: p, us: recorder.liveQuote(p.family, p.end), now });
    if (!d) continue;
    const closed = applyManage(p, d, now);
    const F = p.family.toUpperCase();
    if (d.dca) emit("dca", `DCA ${F} ${p.side}: our side dipped to ${cents(d.bid)}, added $${CFG.dcaUsd} @ ${cents(d.price)}. Now ${p.contracts.toFixed(2)} shares, avg ${cents(p.avg)}, $${p.staked} in`, { family: p.family, pos: p });
    if (closed) {
      book.open = book.open.filter(x => x !== p);
      book.closed.push(closed);
      if (book.closed.length > 500) book.closed = book.closed.slice(-500);
      emit("stop", `STOP ${F} ${p.side}: bid ${cents(d.price)} hit the ${cents(CFG.stopPrice)} stop, sold ${p.contracts.toFixed(2)} shares: ${usd(closed.pnl)}${p.dca ? " (after DCA)" : ""}`, { family: p.family, trade: closed });
    }
    persistBook();
  }
}

export function settlePaper(rec) {
  // Stopped-out copies: record what holding would have done, so the stop can be judged.
  for (const c of book.closed) {
    if (c.usSlug !== rec.slug || !c.exit || c.exit.reason !== "stop" || c.holdWouldWin !== undefined) continue;
    c.holdWouldWin = rec.outcome == null ? null : (rec.outcome === 1) === (c.side === "Up");
    if (c.holdWouldWin != null) emit("settle", `stop check ${c.family.toUpperCase()} ${c.side}: holding would have ${c.holdWouldWin ? `WON +${usd(c.contracts - c.cost)}` : `lost ${usd(-c.cost)}`}; the stop got ${usd(c.pnl)}`, { family: c.family });
    persistBook();
  }
  const hit = book.open.filter(p => p.usSlug === rec.slug);
  if (!hit.length) return;
  book.open = book.open.filter(p => p.usSlug !== rec.slug);
  for (const p of hit) {
    const won = rec.outcome == null ? null : (rec.outcome === 1) === (p.side === "Up");
    const pnl = won == null ? 0 : +((won ? p.contracts : 0) - p.cost).toFixed(2);
    const closed = { ...p, outcome: rec.outcome, won, pnl, closedAt: Date.now() };
    book.closed.push(closed);
    if (book.closed.length > 500) book.closed = book.closed.slice(-500);
    emit("settle", won == null ? `VOID ${p.family.toUpperCase()} ${p.side}: US result unknown, stake returned`
      : `${won ? "WON" : "LOST"} ${p.family.toUpperCase()} ${p.side} @ ${p.dca ? `avg ${cents(p.avg)} (DCA'd)` : cents(p.price)}: ${pnl >= 0 ? "+" : ""}${usd(pnl)} (copied ${short(p.wallet)})`, { family: p.family, trade: closed });
  }
  persistBook();
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
    `${d.smartBuys} buys by smart wallets${d.smartSmall ? ` (${d.smartSmall} under $${CFG.minSignalUsd}, ignored)` : ""}, ${d.copies} copied`, { family });
}

async function pollLive(family, now) {
  const start = windowStart(family, now);
  const key = `${family}:${start}`;
  let cur = live[family];
  if (!cur || cur.key !== key) {
    if (cur) { toScore.unshift({ family, start: cur.start, tries: 0 }); windowSummary(family, cur); }   // score the window that just closed first
    const market = await findMarket(family, start);
    cur = live[family] = { key, start, end: start + DUR[family], market, seen: new Set(), flow: { Up: 0, Down: 0 }, smartFlow: { Up: 0, Down: 0 }, smartBest: { Up: null, Down: null },
      skips: new Set(), order: null, nextOffset: 0, newest: 0, warned: false, diag: { trades: 0, smartBuys: 0, smartSmall: 0, copies: 0 } };
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
    if (t.side !== "BUY") continue;
    const amt = t.size * t.price;
    cur.flow[t.outcome] += amt;
    const s = wallets.get(t.wallet);
    const j = judge(s, now);
    if (!j.smart) continue;
    cur.diag.smartBuys++;
    if (amt < CFG.minSignalUsd) { cur.diag.smartSmall++; continue; }
    cur.smartFlow[t.outcome] += amt;
    const best = cur.smartBest[t.outcome];
    if (!best || amt > best.usd) cur.smartBest[t.outcome] = { wallet: t.wallet, name: t.name, usd: amt, price: t.price, size: t.size, outcome: t.outcome, why: j.why };
    emit("spot", `smart wallet ${short(t.wallet)}${t.name ? ` (${t.name})` : ""} bought ${t.outcome} ${usd(amt)} @ ${cents(t.price)} on global ${family.toUpperCase()} [${j.why}]`, { family, wallet: t.wallet, side: t.outcome, usd: +amt.toFixed(2), price: t.price });
  }
  // Entry check every poll: last few minutes, smart-money side, inside the US price band.
  const us = recorder?.liveQuote ? recorder.liveQuote(family, cur.end) : null;
  const holding = book.open.some(p => p.family === family && Math.abs(p.end - cur.end) < 60_000);
  const d = decideEntry({ smartFlow: cur.smartFlow, us, holding, now });
  if (d.enter) {
    const b = cur.smartBest[d.side];
    cur.diag.copies++;
    openPaper({ family, trade: { ...b, size: b.usd / Math.max(b.price, 0.01) }, us, price: d.price, now, judged: { why: b.why } });
  } else if (!d.wait && !holding && !cur.skips.has(d.why)) { cur.skips.add(d.why); emit("skip", `not entering: ${d.why}`, { family }); }
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
let bookDirty = false, walletsSavedAt = 0, walletsSavedScored = 0, eventsSavedAt = 0, eventsSavedLen = -1;
function persistBook() { bookDirty = true; }
const r2 = n => Math.round(n * 100) / 100;
// Keeps Redis writes low: the book when it changes, wallets at most every 10 min, events every 5 min.
async function persistAll() {
  const now = Date.now();
  if (bookDirty) { bookDirty = false; await saveJSON(KEY_BOOK, book); }
  if (stats.windowsScored !== walletsSavedScored && now - walletsSavedAt >= 10 * 60_000) {
    pruneWallets(now);
    walletsSavedAt = now; walletsSavedScored = stats.windowsScored;
    await saveJSON(KEY_WALLETS, { savedAt: now, scored: [...scored].slice(-1500),
      wallets: [...wallets.entries()].map(([a, w]) => [a, { ...w, pnl: r2(w.pnl), cost: r2(w.cost), best: r2(w.best) }]) });
  }
  if (events.length && events[events.length - 1].t !== eventsSavedLen && now - eventsSavedAt >= 5 * 60_000) {
    eventsSavedAt = now; eventsSavedLen = events[events.length - 1].t;
    await saveJSON(KEY_EVENTS, events.slice(-150));
  }
}

// ── Status / start ──────────────────────────────────────────────────
export function copyStatus(now = Date.now()) {
  const smartAll = [...wallets.entries()].map(([a, s]) => ({ a, s, j: judge(s, now) })).filter(x => x.j.smart);
  const smart = smartAll
    .sort((x, y) => y.j.roi * Math.sqrt(y.s.windows) - x.j.roi * Math.sqrt(x.s.windows))
    .slice(0, 20).map(({ a, s, j }) => ({ wallet: a, name: s.name, windows: s.windows, winRate: +j.winRate.toFixed(3), roi: +j.roi.toFixed(3), pnl: +s.pnl.toFixed(2), lastSeen: s.lastSeen }));
  const closed = book.closed;
  const settled = closed.filter(p => p.won != null && Number.isFinite(p.pnl));
  const pnl = settled.reduce((a, p) => a + p.pnl, 0);
  const cur = f => {
    const c = live[f]; if (!c) return null;
    const us = recorder?.liveQuote ? recorder.liveQuote(f, c.end) : null;
    return { start: c.start, end: c.end, globalSlug: c.market?.slug || null, flow: c.flow, smartFlow: c.smartFlow, us, position: book.open.find(p => p.family === f && Math.abs(p.end - c.end) < 60_000) || null };
  };
  return {
    enabled: stats.enabled, paper: true, now, cfg: CFG, stats: { ...stats, trackedWallets: wallets.size, walletCap: MAX_WALLETS, smartWallets: smartAll.length,
      // The tracked count sits at the cap once memory is full, so also show what's moving.
      activeWallets: [...wallets.values()].filter(w => now - w.lastSeen < 86400_000).length,
      provenWallets: [...wallets.values()].filter(w => w.windows >= CFG.minWindows).length,
      copies: closed.length + book.open.length, open: book.open.length, wins: settled.filter(p => p.won).length, losses: settled.filter(p => !p.won).length,
      pnl: +pnl.toFixed(2), recorderOn: !!recorder?.recorderStatus?.().enabled, queue: toScore.length },
    current: { btc15: cur("btc15"), btc60: cur("btc60") },
    smart, open: book.open, closed: closed.slice(-25).reverse(),
    // Every settled copy in order, for the P&L chart.
    curve: settled.slice().sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0)).map(p => ({ t: p.closedAt, family: p.family, side: p.side,
      price: p.price, avg: p.avg ?? p.price, staked: p.staked ?? CFG.stake, dca: !!p.dca, stop: p.exit?.reason === "stop", won: p.won, pnl: p.pnl })),
  };
}
export function recentEvents(n = 120) { return events.slice(-n); }

/**
 * SHADOW's settled paper copies as /colony leaderboard rows, one per family, in the
 * arena's units ($10 stake, P&L per trade after fees). Every copy is a live trade, so
 * all of them count as forward. Verdicts follow the arena's rules without the
 * tape-only checks (halves, baseline).
 */
export function leaderboardRows() {
  const out = [];
  for (const family of ["btc15", "btc60"]) {
    const trades = book.closed.filter(p => p.family === family && p.won != null && Number.isFinite(p.pnl));
    const n = trades.length;
    const pnl = trades.reduce((a, t) => a + t.pnl, 0), mean = n ? pnl / n : null;
    const sd = n > 1 ? Math.sqrt(trades.reduce((a, t) => a + (t.pnl - mean) ** 2, 0) / (n - 1)) : null;
    const se = sd != null ? sd / Math.sqrt(n) : null;
    const lcb = se != null ? mean - 1.96 * se : null, ucb = se != null ? mean + 1.96 * se : null;
    const verdict = n < 30 ? "too early" : ucb < 0 ? "losing" : lcb > 0 ? "promising" : "unproven";
    const why = n < 30 ? `${n} live paper copies so far; needs 30 to say anything`
      : verdict === "losing" ? "even the optimistic estimate loses money per copy"
      : verdict === "promising" ? "profitable so far with 95% confidence; keep watching before trusting it"
      : "no clear edge yet; the range still includes losing";
    out.push({ id: `shadow-copy-${family}`, name: "shadow-copy", family, author: "SHADOW", created: stats.startedAt ? new Date(stats.startedAt).toISOString().slice(0, 10) : null,
      n, mean, lcb, ucb, fwdN: n, fwdMean: mean, verdict, why: `Live paper copies of smart wallets: ${why}` });
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
  const savedBook = await loadJSON(KEY_BOOK);
  if (savedBook?.open) book = { open: savedBook.open, closed: savedBook.closed || [] };
  // Never let a bad number (e.g. a 0¢ quote) poison the totals.
  book.open = book.open.filter(p => Number.isFinite(p.contracts) && Number.isFinite(p.cost) && p.price > 0);
  for (const c of book.closed) if (!Number.isFinite(c.pnl)) { c.pnl = 0; c.won = null; }
  const savedEvents = await loadJSON(KEY_EVENTS);
  if (Array.isArray(savedEvents)) events = savedEvents;

  // Score recent history so there are wallets to judge from the start.
  const now = Date.now();
  for (const [family, n] of [["btc15", CFG.backfill15], ["btc60", CFG.backfill60]]) {
    const cur = windowStart(family, now);
    for (let i = 1; i <= n; i++) {
      const start = cur - i * DUR[family];
      if (!scored.has(`${family}:${start}`)) toScore.push({ family, start, backfill: true, tries: 0 });
    }
  }
  stats.backfillTotal = toScore.length;
  emit("start", `SHADOW on (paper only): ${wallets.size} wallets remembered, scoring ${toScore.length} past windows, entering $${CFG.stake} in the last ${Math.round(CFG.entryWindowMs / 60000)} min on the smart-money side at ${cents(CFG.minPrice)}-${cents(CFG.maxPrice)}, +$${CFG.dcaUsd} if it dips to ${cents(CFG.dcaLow)}-${cents(CFG.dcaHigh)}, stop at ${cents(CFG.stopPrice)}${recorder ? "" : ". Recorder unavailable: can't price US copies"}`, {});

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
