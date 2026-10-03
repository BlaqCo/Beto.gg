// CONTROL. Picks a side and a moment at random (fixed per window) and holds.
// It should lose roughly the spread plus fees every trade. If it ever looks
// profitable over a large sample, the simulator or the tape has a bug.
import { hash01 } from "../lib.js";

export default {
  name: "control-coinflip",
  author: "colony",
  created: "2026-10-02",
  family: "both",
  control: true,
  description: "Random side at a random time, held to settlement. Sanity check.",
  decide(ctx) {
    if (ctx.position) return null;
    const key = String(ctx.history[0]?.t ?? 0) + ctx.family;
    if (ctx.msIn < hash01(key) * ctx.windowMs * 0.9) return null;
    return { buy: hash01(key + "side") < 0.5 ? "Up" : "Down" };
  },
};
