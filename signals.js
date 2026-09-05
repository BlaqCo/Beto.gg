/**
 * signal.js — market quality scoring
 *
 * WHAT THIS DOES, PLAINLY:
 *   It does NOT predict who wins. Polymarket's API exposes price, order book,
 *   volume and live score — nothing about form, injuries or matchups. The
 *   price already aggregates everyone who holds that information, so no model
 *   built on price alone can out-forecast it. Anything claiming otherwise is
 *   re-deriving the price and calling it a prediction.
 *
 *   What the API CAN tell you is which prices deserve trust. A 65¢ quote
 *   backed by $40k of 24h volume, 5,000 contracts of depth and a 1¢ spread is
 *   a real consensus. The same 65¢ on $200 of volume with a 6¢ spread is one
 *   person's guess. Betting only the first kind removes a large class of
 *   losing entries — bad fills, stale quotes and phantom prices — without
 *   pretending to forecast anything.
 *
 * Score is 0-100 across four components, each independently defensible:
 *   depth      — can the book actually absorb our order at this price?
 *   spread     — how much does crossing cost, and is the quote competitive?
 *   volume     — how much real money has priced this market?
 *   agreement  — does the quote agree with where trading actually happened?
 */

export const SIGNAL = {
  MIN_SCORE: 55,          // below this we don't bet, however good the price looks
  VOL_STRONG: 25_000,     // 24h volume that marks a heavily-traded market
  VOL_OK: 3_000,
  VOL_THIN: 400,
};

/** Score one candidate. Returns { score, grade, parts, reasons }. */
export function scoreMarket(m, book = null, stakeUsd = 9) {
  const parts = {};
  const reasons = [];

  // ── depth (0-30) — the book must cover our order with room to spare ──
  const need = stakeUsd / Math.max(m.ask || 0.5, 0.01);
  const qty = (book && book.askQty > 0) ? book.askQty : null;
  if (qty == null) { parts.depth = 15; reasons.push("depth unknown"); }
  else {
    const cover = qty / Math.max(need, 1);
    parts.depth = cover >= 20 ? 30 : cover >= 8 ? 24 : cover >= 3 ? 16 : cover >= 1 ? 8 : 0;
    if (parts.depth <= 8) reasons.push(`thin book (${Math.round(qty)} vs ${Math.round(need)} needed)`);
  }

  // ── spread (0-25) — the cost of crossing, and a proxy for competition ──
  const spread = (m.ask != null && m.bid != null) ? m.ask - m.bid : null;
  if (spread == null) { parts.spread = 10; reasons.push("no two-sided quote"); }
  else {
    parts.spread = spread <= 0.01 ? 25 : spread <= 0.02 ? 20 : spread <= 0.03 ? 13 : spread <= 0.04 ? 6 : 0;
    if (spread > 0.03) reasons.push(`wide spread ${Math.round(spread * 100)}¢`);
  }

  // ── volume (0-30) — how much real money has already priced this ──
  const vol = Number(m.volume24h || 0);
  parts.volume = vol >= SIGNAL.VOL_STRONG ? 30
               : vol >= SIGNAL.VOL_OK     ? 22
               : vol >= SIGNAL.VOL_THIN   ? 12
               : vol > 0                  ? 4 : 0;
  if (parts.volume <= 4) reasons.push(`low volume ($${Math.round(vol)} 24h)`);

  // ── agreement (0-15) — does the quote match where trades happened? ──
  const last = Number(m.lastTradePx || 0);
  if (!last) { parts.agree = 8; }
  else {
    const mid = (m.ask + m.bid) / 2;
    const gap = Math.abs(mid - last);
    parts.agree = gap <= 0.01 ? 15 : gap <= 0.03 ? 10 : gap <= 0.06 ? 5 : 0;
    if (gap > 0.06) reasons.push(`quote ${Math.round(gap * 100)}¢ off last trade`);
  }

  const score = Math.round(parts.depth + parts.spread + parts.volume + parts.agree);
  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";
  return { score, grade, parts, reasons };
}

/** Rank candidates best-quality first. */
export function rankBySignal(list) {
  return [...list].sort((a, b) => (b._signal?.score || 0) - (a._signal?.score || 0));
}