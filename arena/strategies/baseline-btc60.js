// The live BTC60 rule as written in bot-btc60.js + config.js defaults:
// any time in the hour, buy the favorite if it's priced 55–75¢,
// take profit +15¢, stop-loss −10¢, hard stop at −40% of position value.
// The live Redis config may differ from these defaults; adjust if so.
export default {
  name: "baseline-btc60",
  author: "colony",
  created: "2026-10-02",
  family: "btc60",
  description: "Live BTC60 rule: favorite at 55–75¢ any time, TP +15¢, SL −10¢, hard stop −40%.",
  decide(ctx) {
    if (ctx.position) {
      const bid = ctx[ctx.position.side === "Up" ? "up" : "down"].bid;
      const move = bid - ctx.position.entry;
      if ((bid - ctx.position.entry) / ctx.position.entry <= -0.40) return { sell: true, reason: "hard_stop" };
      if (move >= 0.15) return { sell: true, reason: "take_profit" };
      if (move <= -0.10) return { sell: true, reason: "stop_loss" };
      return null;
    }
    const side = ctx.mid >= 0.5 ? "Up" : "Down";
    const fav = side === "Up" ? ctx.mid : 1 - ctx.mid;
    return fav >= 0.55 && fav <= 0.75 ? { buy: side } : null;
  },
};
