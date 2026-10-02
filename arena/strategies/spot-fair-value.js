// Prices the window from BTC spot itself: with spot S, strike K, time left τ
// and volatility σ measured inside this window, P(Up) ≈ Φ(ln(S/K) / (σ√τ)).
// Buys whichever side is cheaper than that fair value by more than the fee
// plus a 3¢ margin. Holds to settlement. This is the "divergence" the bots
// already log, turned into a testable strategy.
import { normCdf, spotVolPerSec, takerFeePer } from "../lib.js";

const MARGIN = 0.03;
export default {
  name: "spot-fair-value",
  author: "colony",
  created: "2026-10-02",
  family: "both",
  description: "Buy when the book is ≥3¢ (after fees) cheaper than a spot-vs-strike fair value.",
  decide(ctx) {
    if (ctx.position || ctx.spot == null || ctx.strike == null) return null;
    if (ctx.msLeft < 20_000) return null;                 // too close to the bell to fill sensibly
    const vol = spotVolPerSec(ctx.history);
    if (vol == null || vol <= 0) return null;
    const tau = ctx.msLeft / 1000;
    const pUp = normCdf(Math.log(ctx.spot / ctx.strike) / (vol * Math.sqrt(tau)));
    const upEdge = pUp - ctx.up.ask - takerFeePer(ctx.up.ask);
    const downEdge = (1 - pUp) - ctx.down.ask - takerFeePer(ctx.down.ask);
    if (upEdge > MARGIN && upEdge >= downEdge) return { buy: "Up" };
    if (downEdge > MARGIN) return { buy: "Down" };
    return null;
  },
};
