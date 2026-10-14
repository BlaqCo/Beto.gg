/**
 * arena/pair-trader.js — PAIR: practice scalping of BTC15 Up and Down. Paper only.
 *
 * One side pays $1 at the close, so Up + Down shares bought for less than $1 a pair lock in
 * the difference whichever way BTC goes. On Polymarket US both sides are one book (Down's ask
 * = 1 − Up's bid), so the pair has to be bought at two different moments: one side when BTC
 * swings against it, the other when BTC swings back.
 *
 * Each window, every second (arena/fast-book.js):
 *   1. Open: rest a bid on both sides `offset` under each side's mid (maker orders, earning
 *      the maker rebate). Only in the first `openMin` minutes, only while that side is
 *      between minLeg and maxLeg, at most `maxPairs` pairs a window.
 *   2. A bid fills when that side's ask comes down to it (the book reaches our price).
 *      Bids are placed from the previous tick's book, so there's a 1-tick reaction delay.
 *   3. Complete: rest a bid on the other side at target − first price (e.g. 94¢ − 44¢ = 50¢).
 *      When it fills, the pair is locked: + (1 − both prices) per share, plus rebates.
 *   4. Cutoff (`cutoffMin`): an unpaired leg is held to the close if its bid is at least
 *      holdAbove (it's winning), else sold at the bid (taker fee).
 *
 * Several settings run side by side so the best one shows up in the results. Nothing here
 * places real orders. Off with PAIR=false.
 */
import { takerFee, MAKER_THETA } from "../fees.js";
import { saveJSON, loadJSON } from "./state.js";
import { sides } from "./fast-book.js";

const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== "" ? v : d; };
const BASE = {
  shares: env("PAIR_SHARES", 10),             // shares per leg
  openMin: env("PAIR_OPEN_MIN", 8),           // new first legs only in the first N minutes
  cutoffMin: env("PAIR_CUTOFF_MIN", 11),      // unpaired leg decision at this minute
  maxPairs: env("PAIR_MAX_PAIRS", 3),         // pairs per window
  minLeg: env("PAIR_MIN_LEG", 0.25), maxLeg: env("PAIR_MAX_LEG", 0.75),   // first-leg price range
  holdAbove: env("PAIR_HOLD_ABOVE", 0.5),     // at the cutoff, hold a leg whose bid is at least this
};
export const VARIANTS = [
  { id: "tight", name: "PAIR 4¢", offset: 0.04, target: 0.96 },
  { id: "main", name: "PAIR 6¢", offset: 0.06, target: 0.94 },
  { id: "wide", name: "PAIR 8¢", offset: 0.08, target: 0.92 },
].map(v => ({ ...BASE, ...v }));

const KEY = "arena:pair:book:v1", DUR = 15 * 60_000, KEEP = 300;
const r2 = x => Math.round(x * 100) / 100;
const down2 = x => Math.floor(x * 100 + 1e-9) / 100;
const rebate = (qty, px) => MAKER_THETA * qty * px * (1 - px);
const other = s => (s === "Up" ? "Down" : "Up");

export function newWindow(book) {
  return { slug: book.slug, start: book.start ?? book.end - DUR, end: book.end, bids: { Up: null, Down: null }, open: null, pairs: [], legs: [], held: [], sold: [], lastSides: null };
}

/**
 * One tick for one variant. Fills are checked against bids placed on an earlier tick, then
 * bids are re-placed from this tick's book. Returns a list of event strings.
 */
export function step(w, book, now, cfg) {
  const s = sides(book);
  if (!s) return [];
  w.lastSides = s;
  const ev = [], el = now - w.start;
  // 1. Fills on resting bids.
  for (const side of ["Up", "Down"]) {
    const b = w.bids[side];
    if (!b || s[side].ask > b.px) continue;
    w.bids[side] = null;
    if (b.kind === "open") {
      w.open = { side, px: b.px, qty: cfg.shares, t: now, rebate: rebate(cfg.shares, b.px) };
      w.legs.push({ side, px: b.px, t: now });
      w.bids[other(side)] = null;          // the other first-leg bid is cancelled
      ev.push(`first leg: ${side} ${cfg.shares} @ ${Math.round(b.px * 100)}¢`);
    } else if (b.kind === "close" && w.open) {
      const o = w.open, qty = o.qty;
      // A bid placed at or above the ask is really a taker buy at that ask: fee, no rebate.
      const px = b.crossAsk ?? b.px, fee = b.crossAsk != null ? -takerFee(qty, px) : rebate(qty, px);
      const up = o.side === "Up" ? o.px : px, dn = o.side === "Up" ? px : o.px;
      const pnl = +(qty * (1 - up - dn) + o.rebate + fee).toFixed(4);
      w.pairs.push({ up, down: dn, qty, pnl, secs: Math.round((now - o.t) / 1000), t: now });
      w.open = null;
      ev.push(`pair done: Up ${Math.round(up * 100)}¢ + Down ${Math.round(dn * 100)}¢ = ${Math.round((up + dn) * 100)}¢ → locked +$${pnl.toFixed(2)}`);
    }
  }
  // 2. Unpaired leg at the cutoff: hold a winner, sell a loser.
  if (w.open && el >= cfg.cutoffMin * 60_000) {
    const o = w.open, bid = s[o.side].bid;
    w.bids = { Up: null, Down: null };
    if (bid >= cfg.holdAbove) { w.held.push({ ...o }); ev.push(`unpaired ${o.side} @ ${Math.round(o.px * 100)}¢ held to the close (bid ${Math.round(bid * 100)}¢)`); }
    else {
      const pnl = +(o.qty * (bid - o.px) - takerFee(o.qty, bid) + o.rebate).toFixed(4);
      w.sold.push({ ...o, exit: bid, pnl });
      ev.push(`unpaired ${o.side} @ ${Math.round(o.px * 100)}¢ sold at ${Math.round(bid * 100)}¢: ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`);
    }
    w.open = null;
  }
  // 3. Re-place bids from this tick's book.
  if (w.open) {
    const o = w.open, px = down2(cfg.target - o.px);
    const ask = s[other(o.side)].ask;
    w.bids[other(o.side)] = px > 0.01 ? { kind: "close", px, crossAsk: ask <= px ? ask : null } : null;
  } else if (el < cfg.openMin * 60_000 && w.pairs.length + w.held.length + w.sold.length < cfg.maxPairs) {
    const midUp = (s.Up.bid + s.Up.ask) / 2;
    for (const side of ["Up", "Down"]) {
      const mid = side === "Up" ? midUp : 1 - midUp, px = r2(mid - cfg.offset);
      w.bids[side] = mid >= cfg.minLeg && mid <= cfg.maxLeg && px > 0.01 ? { kind: "open", px } : null;
    }
  } else w.bids = { Up: null, Down: null };
  return ev;
}

/** The window's result once it has settled (outcome 1 = Up, 0 = Down, null = unknown). */
export function settleWindow(w, outcome) {
  // An unpaired leg still open at the close (the cutoff never ran) settles like a held one.
  if (w.open) { w.held.push(w.open); w.open = null; }
  const lockedPnl = w.pairs.reduce((a, p) => a + p.pnl, 0);
  const soldPnl = w.sold.reduce((a, p) => a + p.pnl, 0);
  const heldPnl = w.held.reduce((a, h) => {
    if (outcome == null) return a;   // unknown result: count nothing rather than guess
    const won = (outcome === 1) === (h.side === "Up");
    return a + h.qty * ((won ? 1 : 0) - h.px) + h.rebate;
  }, 0);
  return { start: w.start, slug: w.slug, outcome, legs: w.legs.length, pairs: w.pairs, held: w.held.map(h => ({ side: h.side, px: h.px })), sold: w.sold.map(x => ({ side: x.side, px: x.px, exit: x.exit, pnl: x.pnl })),
    lockedPnl: +lockedPnl.toFixed(2), unpairedPnl: +(soldPnl + heldPnl).toFixed(2), pnl: +(lockedPnl + soldPnl + heldPnl).toFixed(2) };
}

export function totals(rows) {
  const legs = rows.reduce((a, r) => a + r.legs, 0), pairs = rows.reduce((a, r) => a + r.pairs.length, 0);
  const sum = k => +rows.reduce((a, r) => a + r[k], 0).toFixed(2);
  return { windows: rows.length, legs, pairs, completion: legs ? +(pairs / legs).toFixed(3) : null, lockedPnl: sum("lockedPnl"), unpairedPnl: sum("unpairedPnl"), pnl: sum("pnl"),
    avgEdge: pairs ? +(rows.flatMap(r => r.pairs).reduce((a, p) => a + (1 - p.up - p.down), 0) / pairs).toFixed(4) : null };
}

// ── Runtime ─────────────────────────────────────────────────────────
const state = { enabled: false, startedAt: null, cur: new Map(), done: new Map(VARIANTS.map(v => [v.id, []])), events: [] };
let dirty = false;

function emit(msg) {
  state.events.push({ t: Date.now(), msg });
  if (state.events.length > 200) state.events.shift();
  console.log(`  🔀 [pair] ${msg}`);
}

export function onBook(book, now = Date.now()) {
  for (const v of VARIANTS) {
    let w = state.cur.get(v.id);
    if (!w || w.slug !== book.slug) { w = newWindow(book); state.cur.set(v.id, w); }
    for (const e of step(w, book, now, v)) { emit(`${v.name} ${new Date(w.start).toISOString().slice(11, 16)}Z: ${e}`); dirty = true; }
  }
}

export function onSettled(rec) {
  if (rec.family !== "btc15") return;
  for (const v of VARIANTS) {
    const w = state.cur.get(v.id);
    if (!w || w.slug !== rec.slug) continue;
    state.cur.delete(v.id);
    if (!w.legs.length) continue;
    const row = settleWindow(w, rec.outcome);
    const list = state.done.get(v.id);
    list.push(row); if (list.length > KEEP) list.shift();
    dirty = true;
    emit(`${v.name} ${new Date(w.start).toISOString().slice(11, 16)}Z closed (${rec.outcome == null ? "result unknown" : rec.outcome ? "Up" : "Down"}): ${row.pairs.length} pair(s), ${row.pnl >= 0 ? "+" : "−"}$${Math.abs(row.pnl).toFixed(2)}`);
  }
}

export function pairStatus() {
  return { enabled: state.enabled, startedAt: state.startedAt,
    variants: VARIANTS.map(v => {
      const w = state.cur.get(v.id), rows = state.done.get(v.id);
      return { id: v.id, name: v.name, cfg: v, totals: totals(rows), recent: rows.slice(-15).reverse(),
        now: w ? { start: w.start, open: w.open, bids: w.bids, pairs: w.pairs.length, held: w.held.length, sold: w.sold.length } : null };
    }),
    events: state.events.slice(-60) };
}

export async function resetPair() {
  for (const v of VARIANTS) state.done.set(v.id, []);
  state.cur.clear(); state.events = []; state.startedAt = Date.now(); dirty = true;
  await saveJSON(KEY, { startedAt: state.startedAt, done: [...state.done] });
  return { ok: true };
}

export async function startPairTrader() {
  if (process.env.PAIR === "false") { console.log("🔀 PAIR practice off (PAIR=false)"); return; }
  if (state.enabled) return;
  const saved = await loadJSON(KEY);
  if (saved?.done) for (const [id, rows] of saved.done) if (state.done.has(id)) state.done.set(id, rows);
  state.startedAt = saved?.startedAt || Date.now();
  const fb = await import("./fast-book.js"), rec = await import("./recorder.js");
  fb.onTick(b => onBook(b));
  rec.onWindowSettled(onSettled);
  setInterval(async () => { if (dirty) { dirty = false; await saveJSON(KEY, { startedAt: state.startedAt, done: [...state.done] }); } }, 30_000);
  state.enabled = true;
  console.log(`🔀 PAIR practice on: ${VARIANTS.map(v => `${v.name} (bids ${Math.round(v.offset * 100)}¢ under mid, pair ≤ ${Math.round(v.target * 100)}¢)`).join(", ")} · ${BASE.shares} shares a leg · paper only`);
}
