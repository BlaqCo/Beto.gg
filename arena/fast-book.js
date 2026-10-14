/**
 * arena/fast-book.js — the live BTC15 order book, once a second.
 *
 * The recorder samples every 5s from the market list, which can be minutes stale. This reads
 * the current BTC15 window's real book (best bid / best ask) as often as Polymarket allows
 * and hands each tick to listeners: SHADOW's fast entry check and the PAIR practice bot.
 * One market, one request at a time. The gap between requests adapts: it starts at
 * FAST_BOOK_MS (default 1000ms), doubles on every 429 (up to 15s, with a 5s+ pause), and
 * shrinks 15% after every 20 requests in a row that go through. So it settles just under
 * Polymarket's real limit (first deploy: 1/s was refused within seconds).
 *
 * Read-only: never places orders. Off with FAST_BOOK=false.
 */

const TICK_MS = Math.max(500, Number(process.env.FAST_BOOK_MS || 1000));   // fastest gap allowed
const MAX_GAP = 15_000, PAUSE_MS = 5000, SPEEDUP_AFTER = 20, HISTORY = 1200;  // keep ~20 min of ticks
const DUR = 15 * 60_000;

let pm = null, recorder = null, timer = null, busy = false, nextAt = 0, gap = TICK_MS, streak = 0, lastLog = 0;
let book = null;                       // { slug, start, end, bid, ask, t, ms } latest good tick
let ticks = [];                        // [{ t, bid, ask }] for the current window
const listeners = new Set();
const stats = { enabled: false, tickMs: TICK_MS, gapMs: TICK_MS, ok: 0, errors: 0, rateLimited: 0, noWindow: 0, avgMs: null, lastError: null };

/** Up/Down prices from one Up-side book: Down's ask is 1 − Up's bid, Down's bid is 1 − Up's ask. */
export function sides(q) {
  if (!q || q.bid == null || q.ask == null) return null;
  const r = x => +x.toFixed(4);
  return { Up: { bid: q.bid, ask: q.ask }, Down: { bid: r(1 - q.ask), ask: r(1 - q.bid) } };
}

/** The newest book for slug if it's at most maxAgeMs old, else null. */
export function fastQuote(slug, maxAgeMs = 2500, now = Date.now()) {
  return book && book.slug === slug && now - book.t <= maxAgeMs ? book : null;
}
export function onTick(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function windowTicks() { return ticks; }
export function fastBookStatus() { return { ...stats, gapMs: gap, slow: gap > TICK_MS, book, ticks: ticks.length }; }
/** Milliseconds between book reads right now (callers size their "fresh enough" by it). */
export const currentGap = () => gap;

async function tick() {
  const now = Date.now();
  if (now < nextAt) return;
  nextAt = now + gap;
  const end = Math.ceil(now / DUR) * DUR;
  const q = recorder?.liveQuote?.("btc15", end);
  if (!q?.slug) { stats.noWindow++; return; }
  const t0 = Date.now();
  let b;
  try { b = await pm.getBBO(q.slug); }
  catch (err) {
    if (/429/.test(err.message || "") || err.response?.status === 429) {
      stats.rateLimited++; streak = 0;
      gap = Math.min(MAX_GAP, Math.max(gap * 2, 2000));
      nextAt = Date.now() + Math.max(gap, PAUSE_MS);
      if (Date.now() - lastLog > 60_000) { lastLog = Date.now(); console.log(`  ⚡ [fast-book] rate-limited (${stats.rateLimited} so far): now every ${(gap / 1000).toFixed(1)}s`); }
    } else stats.errors++;
    stats.lastError = err.message; return;
  }
  const ms = Date.now() - t0;
  if (!(b && b.bid > 0 && b.ask > 0 && b.ask < 1 && b.ask >= b.bid)) { stats.errors++; return; }
  stats.ok++;
  if (++streak >= SPEEDUP_AFTER && gap > TICK_MS) { streak = 0; gap = Math.max(TICK_MS, Math.round(gap * 0.85)); }
  stats.avgMs = stats.avgMs == null ? ms : Math.round(stats.avgMs * 0.9 + ms * 0.1);
  if (!book || book.slug !== q.slug) ticks = [];
  book = { slug: q.slug, start: q.start, end: q.end, bid: b.bid, ask: b.ask, t: Date.now(), ms };
  ticks.push({ t: book.t, bid: b.bid, ask: b.ask });
  if (ticks.length > HISTORY) ticks.shift();
  for (const fn of listeners) { try { await fn(book); } catch (err) { stats.lastError = `listener: ${err.message}`; } }
}

export async function startFastBook() {
  if (process.env.FAST_BOOK === "false") { console.log("⚡ Fast book off (FAST_BOOK=false)"); return; }
  if (timer) return;
  pm = await import("../polymarket-us.js");
  recorder = await import("./recorder.js");
  stats.enabled = true;
  timer = setInterval(async () => {
    if (busy) return;           // never overlap: a slow reply just skips a tick
    busy = true;
    try { await tick(); } catch (err) { stats.lastError = err.message; } finally { busy = false; }
  }, 250);
  console.log(`⚡ Fast book on: BTC15 order book every ${TICK_MS}ms or as fast as Polymarket allows (read-only)`);
}

// Tests.
export function _set({ pmMod, rec } = {}) { if (pmMod) pm = pmMod; if (rec) recorder = rec; }
export function _reset() { book = null; ticks = []; nextAt = 0; gap = TICK_MS; streak = 0; }
export const _tick = tick;
export function _ready() { nextAt = 0; }
