/**
 * fees.js — Polymarket US fee model (authoritative)
 *
 * Source: https://docs.polymarket.us/fees — effective July 1, 2026,
 * re-verified in force as of August 2026.
 *
 *     Fee = Θ × C × p × (1 − p)
 *
 *     Taker   Θ = 0.06      max $1.50 per 100 contracts at p = 0.50
 *     Maker   Θ = −0.0125   i.e. a REBATE, credited at the moment of fill
 *
 * Two things this corrects in our earlier maths:
 *
 *  1. The old model used 0.03 × min(p, 1−p). That happens to match near
 *     p = 0.50 — which is why it agreed with the order ticket screenshot at
 *     48¢ — but it understates the fee everywhere else. At 65¢ the real fee
 *     is 1.37¢ per contract, not 1.05¢.
 *
 *  2. Makers do not merely avoid the fee, they are PAID. A resting limit
 *     order that gets filled earns 0.0125 × C × p × (1−p). Being a maker
 *     rather than a taker is worth roughly 1.7 points of win rate in the
 *     58-66¢ band — larger than most edges we have been chasing.
 */

export const TAKER_THETA = 0.06;
export const MAKER_THETA = 0.0125;
export const MAX_FEE_PER_CONTRACT = 0.015;   // $1.50 per 100 at p = 0.50

/** Taker fee in dollars for a given contract count and price. */
export function takerFee(contracts, px) {
  const per = Math.min(TAKER_THETA * px * (1 - px), MAX_FEE_PER_CONTRACT);
  return per * contracts;
}

/** Maker rebate in dollars (a positive number — you receive it). */
export function makerRebate(contracts, px) {
  return MAKER_THETA * px * (1 - px) * contracts;
}

/** Cost in PRICE terms per contract: positive = you pay, negative = you earn. */
export function costPerContract(px, isMaker = false) {
  return isMaker ? -MAKER_THETA * px * (1 - px)
                 : Math.min(TAKER_THETA * px * (1 - px), MAX_FEE_PER_CONTRACT);
}

/**
 * Win rate needed to break even on a buy-and-hold bet at this price.
 * Taker: you pay stake + fee and receive $1 per contract on a win.
 * Maker: the rebate reduces your effective cost.
 */
export function breakEven(px, isMaker = false) {
  return px + costPerContract(px, isMaker);
}

/** Break-even for a round trip (enter and exit), used by the scalp labs. */
export function breakEvenRoundTrip(px, take, stop, { entryMaker = false, exitMaker = false } = {}) {
  const inCost  = costPerContract(px, entryMaker);
  const outCost = costPerContract(px + take, exitMaker);
  const win  = take - inCost - outCost;
  const loss = stop + inCost + costPerContract(px - stop, exitMaker);
  return win + loss > 0 ? loss / (win + loss) : 1;
}

/** What being a maker instead of a taker is worth, in win-rate points. */
export function makerAdvantagePoints(px) {
  return (breakEven(px, false) - breakEven(px, true)) * 100;
}
