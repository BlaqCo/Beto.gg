/**
 * model.js — in-play win probability from live game state
 *
 * WHAT THIS CAN AND CANNOT DO — read this before trusting it.
 *
 * Polymarket's API gives us price, order book, score and period. The price
 * is already the market's best estimate of who wins, so building a "who is
 * better" model out of price data is circular — you end up predicting the
 * price from the price. That is the gimmick this file deliberately avoids.
 *
 * The one genuinely independent signal in that API is GAME STATE. A team
 * leading by two runs in the 8th has a win probability implied by baseball
 * itself, not by the market. When the market price disagrees with what the
 * scoreboard implies, that is a real, non-circular edge — and the latency
 * lab already measured it: prices took a median 17.1s to reprice after a
 * score change, moving ~7¢ when they did.
 *
 * So: this estimates win probability from the scoreboard, compares it to
 * the price, and only signals when the gap is bigger than the fee.
 *
 * The models are standard parametric approximations, calibrated against
 * well-known reference points, not fitted to our own trades.
 */

const clamp = (x, lo = 0.02, hi = 0.98) => Math.max(lo, Math.min(hi, x));

// How much of the model-vs-market gap we are willing to claim, and the most
// edge we will ever act on. Both exist to keep model error cheap.
export const SHRINK   = 0.5;
export const MAX_EDGE = 0.12;

/** Normal CDF — used for the baseball lead model. */
function Phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * BASEBALL — win probability for the leading side.
 * P(win) = Φ( lead / (k · √innings_remaining) ), k ≈ 1.2.
 * Reference points this reproduces: up 1 in the 9th ≈ 80%,
 * up 1 in the 5th ≈ 65%, up 3 in the 9th ≈ 97%.
 */
export function baseballWinProb(lead, inning) {
  const rem = Math.max(0.5, 9 - Math.min(inning, 9) + 1);
  if (lead === 0) return 0.5;
  const z = Math.abs(lead) / (1.2 * Math.sqrt(rem));
  const p = clamp(Phi(z), 0.5, 0.985);
  return lead > 0 ? p : 1 - p;
}

/**
 * TENNIS (best of 3) — win probability for the side ahead.
 * Sets dominate; games inside the current set adjust it.
 * Reference points: a set up ≈ 78%, level ≈ 50%, a set down ≈ 22%.
 */
export function tennisWinProb(setDiff, gameDiff) {
  // Deliberately conservative. Polymarket's score pair for tennis does not
  // reliably distinguish games from sets, so we treat it as games in the
  // current set and claim only a modest effect. Being roughly right beats
  // being precisely wrong when the input is ambiguous.
  let p = 0.5 + 0.045 * Math.max(-5, Math.min(5, gameDiff || 0));
  if (setDiff) p += 0.12 * Math.sign(setDiff);
  return clamp(p, 0.25, 0.75);
}

/** Parse "5-6" / "13-9" into a numeric pair. */
function parsePair(score) {
  const m = String(score || "").match(/^\s*(\d{1,3})\s*[-:]\s*(\d{1,3})\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Innings from "Bot 9th" / "Top 5th". */
function parseInning(period) {
  const m = String(period || "").match(/(\d{1,2})(?:st|nd|rd|th)/i);
  return m ? Number(m[1]) : null;
}

/** Set number from "2nd Set". */
function parseSet(period) {
  const m = String(period || "").match(/(\d)(?:st|nd|rd|th)?\s*set/i);
  return m ? Number(m[1]) : null;
}

/**
 * Estimate the win probability of the side the MARKET is quoting.
 *
 * We cannot always tell which team the YES outcome refers to, so we assign
 * it to whichever side the price is closer to — and refuse the trade when
 * that assignment is ambiguous, rather than guessing.
 *
 * Returns { p, edge, side, reason } or null when the state is unreadable.
 */
export function stateEdge(market, price) {
  const league = String(market.league || "").toUpperCase();
  const period = market.evPeriod || "";
  const pair = parsePair(market.evScore);
  if (!pair || price == null) return null;
  const [a, b] = pair;

  let leaderProb = null;
  if (/MLB|BASEBALL|NPB|KBO/.test(league)) {
    const inn = parseInning(period);
    if (inn == null) return null;
    leaderProb = baseballWinProb(Math.abs(a - b) || 0, inn);
    if (a === b) leaderProb = 0.5;
  } else if (/TENNIS|ATP|WTA|ITF/.test(league)) {
    const set = parseSet(period);
    if (set == null) return null;
    leaderProb = tennisWinProb(0, a - b);          // games only — no set inference
  } else {
    return null;                                    // no model for this sport
  }
  if (leaderProb == null) return null;

  // Which side is the quoted price on? Pick the closer one, refuse if unclear.
  const dLead = Math.abs(price - leaderProb);
  const dTrail = Math.abs(price - (1 - leaderProb));
  if (Math.abs(dLead - dTrail) < 0.08) {
    return { p: null, edge: null, side: "ambiguous",
             reason: `state unclear (model ${Math.round(leaderProb * 100)}% vs price ${Math.round(price * 100)}¢)` };
  }
  const rawP = dLead < dTrail ? leaderProb : 1 - leaderProb;
  // SHRINKAGE — claim only part of the apparent gap. The model is a rough
  // approximation; the market is a well-informed estimate. Taking half the
  // difference means model error costs us far less when we are wrong.
  const p = price + SHRINK * (rawP - price);
  return {
    p, rawP, edge: Math.max(-MAX_EDGE, Math.min(MAX_EDGE, p - price)),
    side: dLead < dTrail ? "leader" : "trailer",
    reason: `${league} ${a}-${b} ${period} → model ${Math.round(rawP * 100)}% (shrunk ${Math.round(p * 100)}%) vs price ${Math.round(price * 100)}¢`,
  };
}

export const MODELLED_LEAGUES = ["MLB", "TENNIS"];
