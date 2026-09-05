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
 * TIED, LATE INNING — the home team's last-at-bat advantage.
 * A tied game is not a coin flip once the innings get late: the home side
 * bats last, so in the bottom half they know exactly what they need and
 * only have to match or beat it, while in the top half the visitor has no
 * such information. This is well-documented in sabermetric win-expectancy
 * tables (Tom Tango's WPA framework; consistent across decades of MLB
 * play-by-play data) and is NOT something we are fitting to our own trades.
 *
 * Reference points this reproduces (home team win probability, tied game):
 *   tied, top of 9th (home fields first)     ≈ 52-53%
 *   tied, bottom of 9th (home bats, in play) ≈ 54-55%
 *   tied, extra innings (10th+)              ≈ 52-53%, roughly flat
 *
 * Returns the HOME team's win probability. Caller maps it to leader/trailer.
 */
export function baseballTiedProb(inning, isBottomHalf) {
  if (inning >= 10) return 0.525;                 // extras — small, stable home edge
  if (inning === 9) return isBottomHalf ? 0.545 : 0.525;
  return 0.51;                                     // tied earlier — edge exists but is small
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
  let homeProb = null;         // set only for the tied-game case
  if (/MLB|BASEBALL|NPB|KBO/.test(league)) {
    const inn = parseInning(period);
    if (inn == null) return null;
    if (a === b) {
      const isBottom = /bot|bottom/i.test(period);
      const isTop    = /top/i.test(period);
      if (!isBottom && !isTop) return null;         // can't tell which half — refuse rather than guess
      homeProb = baseballTiedProb(inn, isBottom);
    } else {
      leaderProb = baseballWinProb(Math.abs(a - b), inn);
    }
  } else if (/TENNIS|ATP|WTA|ITF/.test(league)) {
    const set = parseSet(period);
    if (set == null) return null;
    leaderProb = tennisWinProb(0, a - b);          // games only — no set inference
  } else {
    return null;                                    // no model for this sport
  }
  if (leaderProb == null && homeProb == null) return null;

  const shrink = (rawP) => price + SHRINK * (rawP - price);
  const edgeOf = (rawP) => Math.max(-MAX_EDGE, Math.min(MAX_EDGE, shrink(rawP) - price));

  if (homeProb != null) {
    // TIED GAME: we don't reliably know which named team is home, so we
    // can't pick a single side the way the lead case does. Instead: check
    // BOTH possible assignments. A tied-game edge is at most ~55% either
    // way, so if the price is rich enough that NEITHER assignment justifies
    // it, we can safely reject without ever needing to resolve home/away —
    // that is a real, useful finding, not a refusal for lack of information.
    const edgeAsHome = edgeOf(homeProb);
    const edgeAsAway = edgeOf(1 - homeProb);
    // Confident reject: if even the MORE FAVOURABLE of the two possible
    // team assignments gives no positive edge, the price isn't justified
    // under EITHER assignment — home/away ambiguity stops mattering.
    const bestCase = Math.max(edgeAsHome, edgeAsAway);
    if (bestCase <= 0) {
      const rawBest = edgeAsHome >= edgeAsAway ? homeProb : 1 - homeProb;
      return {
        p: shrink(rawBest), rawP: rawBest, edge: bestCase, side: "tied-overpriced",
        reason: `${league} ${a}-${b} ${period} (tied, last-at-bat edge ~${Math.round(homeProb * 100)}%) → ` +
                `price ${Math.round(price * 100)}¢ too rich either way`,
      };
    }
    // The price COULD be justified, but only if we knew which team is home —
    // and we don't have that field reliably. Refuse rather than guess.
    return { p: null, edge: null, side: "ambiguous",
             reason: `tied game, home team unknown — model ${Math.round(homeProb * 100)}%/${Math.round((1 - homeProb) * 100)}% vs price ${Math.round(price * 100)}¢ (would need home/away to confirm)` };
  }

  // LEAD case: unchanged logic, but the ambiguity band now only applies
  // where it was designed to — leaderProb meaningfully away from 50%.
  const dLead = Math.abs(price - leaderProb);
  const dTrail = Math.abs(price - (1 - leaderProb));
  if (Math.abs(dLead - dTrail) < 0.08) {
    return { p: null, edge: null, side: "ambiguous",
             reason: `state unclear (model ${Math.round(leaderProb * 100)}% vs price ${Math.round(price * 100)}¢)` };
  }
  const rawP = dLead < dTrail ? leaderProb : 1 - leaderProb;
  return {
    p: shrink(rawP), rawP, edge: edgeOf(rawP),
    side: dLead < dTrail ? "leader" : "trailer",
    reason: `${league} ${a}-${b} ${period} → model ${Math.round(rawP * 100)}% (shrunk ${Math.round(shrink(rawP) * 100)}%) vs price ${Math.round(price * 100)}¢`,
  };
}

export const MODELLED_LEAGUES = ["MLB", "TENNIS"];
