/**
 * arena/sim.js — replays recorded windows through strategies and scores them.
 *
 * Fill model (deliberately conservative, so a strategy has to beat the
 * spread AND the fee to look good):
 *   - A decision made on tick i fills on tick i+1's quotes (models latency
 *     and stops look-ahead). No next tick before the window closes = no fill.
 *   - Buying pays the ASK of the chosen side, selling receives the BID.
 *       Up ask = YES ask         Up bid = YES bid
 *       Down ask = 1 − YES bid   Down bid = 1 − YES ask
 *   - Every fill pays the Polymarket US taker fee (fees.js).
 *   - Fixed stake per trade (ARENA_STAKE, default $10) so strategies compare
 *     on the same footing. At most one entry per window.
 *   - Winning contracts settle at $1. Windows with an unknown outcome are
 *     skipped and counted as "unresolved".
 */

import * as fees from "../fees.js";

export const STAKE = Number(process.env.ARENA_STAKE || 10);
const FALLBACK_HALF_SPREAD = 0.01;   // used only when a tick has a listing price but no book

/** Turn a raw tape tick into quotes a strategy can trade on, or null. */
export function quote(tick) {
  const [t, bid, ask, listYes, spot] = tick;
  let b = bid, a = ask, synthetic = false;
  if ((b == null || a == null) && listYes != null) {
    b = listYes - FALLBACK_HALF_SPREAD; a = listYes + FALLBACK_HALF_SPREAD; synthetic = true;
  }
  if (b == null || a == null || !(b > 0) || !(a < 1) || a < b) return null;
  return {
    t, spot: spot ?? null, synthetic,
    mid: (a + b) / 2,
    up:   { bid: b,     ask: a },
    down: { bid: 1 - a, ask: 1 - b },
  };
}

/** Replay one window through one strategy. Returns a trade or null. */
export function runWindow(strategy, win, { stake = STAKE } = {}) {
  const windowMs = win.end - win.start;
  const history = [];
  const state = {};
  let position = null;      // { side, entry, contracts, cost, t }
  let pendingOrder = null;  // decision waiting for the next tick
  let exit = null;          // { price, proceeds, t, reason }

  for (const raw of win.ticks) {
    const q = quote(raw);
    if (!q || q.t >= win.end) continue;

    // 1) fill whatever was decided on the previous tick
    if (pendingOrder) {
      if (pendingOrder.buy && !position) {
        const px = q[pendingOrder.buy === "Up" ? "up" : "down"].ask;
        if (px > 0 && px < 1) {
          const contracts = stake / px;
          const fee = fees.takerFee(contracts, px);
          position = { side: pendingOrder.buy, entry: px, contracts, cost: stake + fee, t: q.t, synthetic: q.synthetic };
        }
      } else if (pendingOrder.sell && position && !exit) {
        const px = q[position.side === "Up" ? "up" : "down"].bid;
        const fee = fees.takerFee(position.contracts, px);
        exit = { price: px, proceeds: position.contracts * px - fee, t: q.t, reason: pendingOrder.reason || "sell" };
      }
      pendingOrder = null;
    }
    if (exit) break;

    history.push(q);
    const ctx = {
      family: win.family, strike: win.strike ?? null, spot: q.spot,
      msLeft: win.end - q.t, msIn: q.t - win.start, windowMs,
      up: q.up, down: q.down, mid: q.mid,
      position: position ? { side: position.side, entry: position.entry, contracts: position.contracts, t: position.t } : null,
      history, state,
    };
    let d = null;
    try { d = strategy.decide(ctx) || null; } catch { d = null; }
    if (d?.buy && !position && (d.buy === "Up" || d.buy === "Down")) pendingOrder = { buy: d.buy };
    else if (d?.sell && position) pendingOrder = { sell: true, reason: d.reason };
  }

  if (!position) return null;
  if (exit) {
    const pnl = exit.proceeds - position.cost;
    return { slug: win.slug, family: win.family, start: win.start, side: position.side, entry: position.entry,
             exit: exit.price, how: exit.reason, pnl, won: pnl > 0, cost: position.cost, synthetic: position.synthetic };
  }
  if (win.outcome !== 0 && win.outcome !== 1) return { slug: win.slug, family: win.family, start: win.start, unresolved: true };
  const won = (win.outcome === 1) === (position.side === "Up");
  const pnl = (won ? position.contracts : 0) - position.cost;
  return { slug: win.slug, family: win.family, start: win.start, side: position.side, entry: position.entry,
           exit: won ? 1 : 0, how: "expiry", pnl, won, cost: position.cost, synthetic: position.synthetic };
}

/** Summary statistics for a list of resolved trades. */
export function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wins: 0, winRate: null, pnl: 0, roi: null, mean: null, sd: null, lcb: null, ucb: null, maxDD: 0 };
  let pnl = 0, staked = 0, wins = 0, peak = 0, eq = 0, maxDD = 0;
  for (const t of trades) {
    pnl += t.pnl; staked += t.cost; if (t.won) wins++;
    eq += t.pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
  }
  const mean = pnl / n;
  const sd = n > 1 ? Math.sqrt(trades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / (n - 1)) : null;
  const se = sd != null ? sd / Math.sqrt(n) : null;
  return {
    n, wins, winRate: wins / n, pnl, roi: pnl / staked, mean, sd,
    lcb: se != null ? mean - 1.96 * se : null,     // 95% bounds on average P&L per trade
    ucb: se != null ? mean + 1.96 * se : null,
    maxDD,
  };
}

const DAY = 86_400_000;

/**
 * Score every strategy over a set of windows.
 * "forward" = only windows that started after the strategy's `created`
 * date, i.e. data the strategy's author could not have seen.
 */
export function scoreAll(strategies, windows, opts = {}) {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const rows = [];
  for (const s of strategies) {
    const fams = s.family === "both" ? ["btc15", "btc60"] : [s.family];
    for (const family of fams) {
      const wins = sorted.filter(w => w.family === family);
      if (!wins.length) continue;
      const trades = [], unresolved = [];
      for (const w of wins) {
        const r = runWindow(s, w, opts);
        if (!r) continue;
        (r.unresolved ? unresolved : trades).push(r);
      }
      const created = Date.parse(s.created || "1970-01-01");
      const half = wins.length ? wins[Math.floor(wins.length / 2)].start : 0;
      const all = summarize(trades);
      const forward = summarize(trades.filter(t => t.start >= created));
      const firstHalf = summarize(trades.filter(t => t.start < half));
      const secondHalf = summarize(trades.filter(t => t.start >= half));
      rows.push({
        id: `${s.name}:${family}`, name: s.name, family, author: s.author || "unknown", created: s.created || null,
        description: s.description || "", control: !!s.control,
        windows: wins.length, unresolved: unresolved.length,
        synthetic: trades.filter(t => t.synthetic).length,
        all, forward, firstHalf, secondHalf,
        exits: countBy(trades, t => t.how),
        verdict: null,
      });
    }
  }
  // Verdicts, judged per family against that family's baseline.
  for (const r of rows) {
    const base = rows.find(x => x.family === r.family && x.name.startsWith("baseline"));
    r.verdict = verdict(r, base);
  }
  rows.sort((a, b) => (b.all.lcb ?? -Infinity) - (a.all.lcb ?? -Infinity));
  return { generatedAt: Date.now(), stake: opts.stake ?? STAKE, strategies: strategies.length,
           windows: countBy(sorted, w => w.family), from: sorted[0]?.start ?? null, to: sorted.at(-1)?.end ?? null, rows };
}

export const PROMOTE_MIN_FORWARD = Number(process.env.ARENA_PROMOTE_MIN || 200);

function verdict(r, base) {
  const f = r.forward, a = r.all;
  if (r.control) return { label: "control", why: "a deliberately dumb strategy; it should lose about the spread plus fees. If it wins over a big sample, suspect a bug." };
  if (a.n < 30) return { label: "too early", why: `${a.n} trades so far; needs 30 to say anything` };
  if (a.ucb != null && a.ucb < 0) return { label: "losing", why: "even the optimistic estimate loses money per trade" };
  const halvesAgree = r.firstHalf.n >= 15 && r.secondHalf.n >= 15 && r.firstHalf.mean > 0 && r.secondHalf.mean > 0;
  const beatsBase = !base || base === r || (f.mean ?? -Infinity) > (base.forward.mean ?? -Infinity);
  if (f.n >= PROMOTE_MIN_FORWARD && f.lcb > 0 && halvesAgree && beatsBase)
    return { label: "ready for review", why: `${f.n} forward trades, profitable with 95% confidence, both halves positive, beats baseline. Still needs your sign-off.` };
  if (a.lcb != null && a.lcb > 0) return { label: "promising", why: `profitable on the tape so far; needs ${Math.max(0, PROMOTE_MIN_FORWARD - f.n)} more forward trades` };
  return { label: "unproven", why: "no clear edge yet; the range still includes losing" };
}

function countBy(arr, fn) { const o = {}; for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; } return o; }
export { DAY };
