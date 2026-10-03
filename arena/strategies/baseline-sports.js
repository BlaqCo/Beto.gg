// The live sports rule as described for the bot: pre-game only, 4–12 hours
// before start, back the favorite priced 57–68¢, hold to settlement.
// The bot's live config may differ; adjust if so.
export default {
  name: "baseline-sports",
  author: "colony",
  created: "2026-10-03",
  family: "sports",
  description: "Live sports rule: favorite at 57–68¢, 4–12h before start, hold.",
  decide(ctx) {
    if (ctx.position) return null;
    const h = ctx.msLeft / 3_600_000;
    if (h < 4 || h > 12) return null;
    const side = ctx.mid >= 0.5 ? "Up" : "Down";
    const px = ctx[side === "Up" ? "up" : "down"].ask;
    return px >= 0.57 && px <= 0.68 ? { buy: side } : null;
  },
};
