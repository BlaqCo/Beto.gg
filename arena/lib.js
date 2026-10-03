/** arena/lib.js — small helpers strategies can share. */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(x) {
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

/** Per-second volatility of log spot returns from quotes seen so far (null if too few). */
export function spotVolPerSec(history, minPoints = 12) {
  const pts = history.filter(q => q.spot != null);
  if (pts.length < minPoints) return null;
  let sum = 0, sumSq = 0, dtSum = 0, n = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0 || pts[i].spot === pts[i - 1].spot && dt < 1) continue;
    const r = Math.log(pts[i].spot / pts[i - 1].spot);
    sum += r; sumSq += r * r; dtSum += dt; n++;
  }
  if (n < minPoints - 1 || dtSum <= 0) return null;
  return Math.sqrt(sumSq / dtSum);
}

/** Taker fee per contract, in price terms (mirrors fees.js). */
export const takerFeePer = px => Math.min(0.06 * px * (1 - px), 0.015);

/** Deterministic pseudo-random number in [0,1) from a string (for controls). */
export function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}
