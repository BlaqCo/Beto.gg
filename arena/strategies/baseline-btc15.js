// The live BTC15 rule as written in bot-btc15.js (code defaults):
// from 12:30 in (last 2:30), buy whichever side is the favorite (price ≥ 50¢),
// take profit at +15¢, no stop-loss, no hard stop, otherwise hold to expiry.
// Note: the live bot sizes off the MID price; here it pays the real ask.
export default {
  name: "baseline-btc15",
  author: "colony",
  created: "2026-10-02",
  family: "btc15",
  description: "Live BTC15 rule: favorite from 12:30 in (last 2:30), TP +15¢, hold otherwise.",
  decide(ctx) {
    if (ctx.position) {
      const bid = ctx[ctx.position.side === "Up" ? "up" : "down"].bid;
      if (bid - ctx.position.entry >= 0.15) return { sell: true, reason: "take_profit" };
      return null;
    }
    if (ctx.msLeft > 150_000) return null;
    const side = ctx.mid >= 0.5 ? "Up" : "Down";
    const fav = side === "Up" ? ctx.mid : 1 - ctx.mid;
    return fav >= 0.5 && fav <= 1.0 ? { buy: side } : null;
  },
};
