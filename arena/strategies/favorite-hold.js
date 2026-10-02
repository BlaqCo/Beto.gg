// Same entry idea as the baselines (back the favorite late), but never sells
// early. Isolates whether the ENTRY has value, separate from exit timing.
export default {
  name: "favorite-hold",
  author: "colony",
  created: "2026-10-02",
  family: "both",
  description: "Buy the 55–85¢ favorite in the final 20% of the window and hold to settlement.",
  decide(ctx) {
    if (ctx.position) return null;
    if (ctx.msLeft > ctx.windowMs * 0.2) return null;
    const side = ctx.mid >= 0.5 ? "Up" : "Down";
    const fav = side === "Up" ? ctx.mid : 1 - ctx.mid;
    return fav >= 0.55 && fav <= 0.85 ? { buy: side } : null;
  },
};
