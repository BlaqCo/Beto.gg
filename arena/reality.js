/**
 * arena/reality.js — checks the arena's fill model against the bots' own trades.
 *
 * For every BTC15/BTC60 trade the bots recorded (paper or real) whose window is
 * also on the tape, replay the same trade through the arena: same window, same
 * side, entering when the bot entered and selling when the bot sold (or holding
 * to expiry if the bot did). Then compare the bot's price and P&L with the
 * arena's, both scaled to a $10 stake.
 *
 * If the bot consistently does worse than the arena on the same trades, the
 * arena's numbers are too optimistic and no strategy's arena result should be
 * trusted for real money until that gap is understood.
 *
 * "Too optimistic" means the bot's average is more than $0.25 per $10 trade
 * below the arena's and that gap is clearly below zero (95% range).
 *
 * READ-ONLY: reads the tracker's trade list and the tape, writes nothing.
 */
import { runWindow } from "./sim.js";

const STAKE = 10;
const FAMILY = { BTC15: "btc15", BTC60: "btc60" };
const MIN_N = 20;           // trades needed before saying anything
const TOLERANCE = 0.25;     // $ per $10 trade: a gap smaller than this counts as a match

/** A strategy that copies one recorded bot trade. */
function mimic(trade) {
  const entryT = Date.parse(trade.at);
  const sells = trade.reason && !["expiry", "resolution"].includes(trade.reason);
  const exitT = sells ? Date.parse(trade.settledAt) : null;
  return {
    name: "mimic",
    decide(ctx) {
      const t = ctx.history.at(-1)?.t;
      if (t == null) return null;
      if (!ctx.position) return t >= entryT && (exitT == null || t < exitT) ? { buy: trade.side } : null;
      return exitT != null && t >= exitT ? { sell: true, reason: trade.reason } : null;
    },
  };
}

/** Compare recorded bot trades with the arena's replay of the same trades. */
export function compareTrades(trades, windows) {
  const bySlug = new Map(windows.map(w => [w.slug, w]));
  const rows = [];
  let skipped = 0;
  for (const t of trades) {
    const family = FAMILY[String(t.league || "").toUpperCase()];
    const win = family && bySlug.get(t.slug);
    if (!win || (t.side !== "Up" && t.side !== "Down") || !(t.entry > 0) || !(t.size > 0) || !t.at) { skipped++; continue; }
    const r = runWindow(mimic(t), win, { stake: STAKE });
    if (!r || r.unresolved) { skipped++; continue; }
    const botPnl = t.pnl * STAKE / t.size;
    rows.push({
      slug: t.slug, family, side: t.side, paper: !!t.isPaper, reason: t.reason || null,
      botEntry: t.entry, arenaEntry: +r.entry.toFixed(4),
      botPnl: +botPnl.toFixed(2), arenaPnl: +r.pnl.toFixed(2), gap: +(botPnl - r.pnl).toFixed(2),
      synthetic: !!r.synthetic,
    });
  }
  return { rows, skipped, summary: summarizeGap(rows) };
}

export function summarizeGap(rows) {
  const n = rows.length;
  if (!n) return { n: 0, label: "no data", msg: "no bot trades on recorded windows yet" };
  const mean = rows.reduce((s, r) => s + r.gap, 0) / n;
  const entryGap = rows.reduce((s, r) => s + (r.botEntry - r.arenaEntry), 0) / n;
  const sd = n > 1 ? Math.sqrt(rows.reduce((s, r) => s + (r.gap - mean) ** 2, 0) / (n - 1)) : null;
  const se = sd != null ? sd / Math.sqrt(n) : null;
  const lo = se != null ? mean - 1.96 * se : null, hi = se != null ? mean + 1.96 * se : null;
  const base = { n, meanGap: +mean.toFixed(3), range95: [lo == null ? null : +lo.toFixed(3), hi == null ? null : +hi.toFixed(3)],
                 entryGapCents: +(entryGap * 100).toFixed(2) };
  const money = v => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
  if (n < MIN_N) return { ...base, label: "too early", msg: `${n} bot trades matched to the tape; needs ${MIN_N} to compare` };
  if (mean < -TOLERANCE && hi != null && hi < 0)
    return { ...base, label: "arena too optimistic", msg: `bot does ${money(mean)} per $10 trade vs the arena on the same ${n} trades; arena results overstate profit` };
  if (mean > TOLERANCE && lo != null && lo > 0)
    return { ...base, label: "arena too strict", msg: `bot does ${money(mean)} per $10 trade vs the arena on the same ${n} trades; arena is conservative` };
  if (Math.abs(mean) <= TOLERANCE)
    return { ...base, label: "matches", msg: `bot and arena agree within $${TOLERANCE.toFixed(2)} per $10 trade over ${n} trades (gap ${money(mean)})` };
  return { ...base, label: "unclear", msg: `bot vs arena gap ${money(mean)} per $10 trade over ${n} trades, not yet clear; needs more trades` };
}
