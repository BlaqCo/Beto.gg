/**
 * arena/spec.js — strategies as data ("recipes") instead of code.
 *
 * The AI agents write recipes, never JavaScript, so nothing an agent produces
 * is ever executed on the server that holds the trading keys. A recipe is
 * validated against tight bounds, then compiled into a normal arena strategy.
 *
 * Recipe shape:
 * {
 *   name: "late-favorite-70",          // kebab-case, unique
 *   family: "btc15" | "btc60" | "sports",
 *   side: "favorite" | "underdog" | "up" | "down" | "fair_value",
 *   entry: {
 *     minLeftSec, maxLeftSec,          // only enter while time-left is inside this range
 *                                      // (sports: time until the game starts)
 *     priceMin, priceMax,              // price of the side being bought (0.02–0.98)
 *     margin                           // fair_value only: required edge after fees (0–0.2)
 *   },
 *   exit: { takeProfit, stopLoss },    // cents of move from entry (0.01–0.6), or null = hold
 *   rationale: "one or two sentences"
 * }
 */
import { normCdf, spotVolPerSec, takerFeePer } from "./lib.js";

const SIDES = ["favorite", "underdog", "up", "down", "fair_value"];
const FAMILY_MAX_LEFT = { btc15: 900, btc60: 3600, sports: 48 * 3600 };

const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const clampOk = (v, lo, hi) => v != null && Number.isFinite(v) && v >= lo && v <= hi;

/** Returns { ok, spec, error }. Never throws. */
export function validateSpec(raw) {
  try {
    if (!raw || typeof raw !== "object") return { ok: false, error: "not an object" };
    const name = String(raw.name || "").toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(name)) return { ok: false, error: "name must be 3-41 chars of a-z, 0-9, -" };
    const family = String(raw.family || "");
    if (!FAMILY_MAX_LEFT[family]) return { ok: false, error: "family must be btc15, btc60 or sports" };
    const side = String(raw.side || "");
    if (!SIDES.includes(side)) return { ok: false, error: `side must be one of ${SIDES.join(", ")}` };
    if (side === "fair_value" && family === "sports") return { ok: false, error: "fair_value needs BTC spot; not available for sports" };
    if (family === "sports" && (side === "up" || side === "down")) return { ok: false, error: "sports uses favorite or underdog" };
    const e = raw.entry || {}, x = raw.exit || {};
    const maxLeft = FAMILY_MAX_LEFT[family];
    const entry = {
      minLeftSec: n(e.minLeftSec) ?? 0,
      maxLeftSec: n(e.maxLeftSec) ?? maxLeft,
      priceMin: n(e.priceMin) ?? 0.02,
      priceMax: n(e.priceMax) ?? 0.98,
      margin: side === "fair_value" ? (n(e.margin) ?? 0.03) : null,
    };
    if (!clampOk(entry.minLeftSec, 0, maxLeft) || !clampOk(entry.maxLeftSec, 1, maxLeft) || entry.minLeftSec >= entry.maxLeftSec)
      return { ok: false, error: `entry window must satisfy 0 <= minLeftSec < maxLeftSec <= ${maxLeft}` };
    if (!clampOk(entry.priceMin, 0.02, 0.98) || !clampOk(entry.priceMax, 0.02, 0.98) || entry.priceMin >= entry.priceMax)
      return { ok: false, error: "price band must satisfy 0.02 <= priceMin < priceMax <= 0.98" };
    if (side === "fair_value" && !clampOk(entry.margin, 0, 0.2)) return { ok: false, error: "margin must be 0-0.2" };
    const exit = { takeProfit: n(x.takeProfit), stopLoss: n(x.stopLoss) };
    for (const k of ["takeProfit", "stopLoss"]) if (exit[k] != null && !clampOk(exit[k], 0.01, 0.6)) return { ok: false, error: `${k} must be 0.01-0.6 or null` };
    const rationale = String(raw.rationale || "").slice(0, 400);
    return { ok: true, spec: { name, family, side, entry, exit, rationale } };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** A short human description of a recipe. */
export function describeSpec(s) {
  const mins = v => v >= 3600 ? `${+(v / 3600).toFixed(1)}h` : v >= 60 ? `${Math.round(v / 60)}m` : `${v}s`;
  const what = s.side === "fair_value" ? `the side ≥${Math.round(s.entry.margin * 100)}¢ under BTC fair value` : s.side === "up" ? "Up" : s.side === "down" ? "Down" : `the ${s.side}`;
  const ex = [s.exit.takeProfit ? `TP +${Math.round(s.exit.takeProfit * 100)}¢` : null, s.exit.stopLoss ? `SL −${Math.round(s.exit.stopLoss * 100)}¢` : null].filter(Boolean).join(", ") || "hold to settlement";
  return `Buy ${what} at ${Math.round(s.entry.priceMin * 100)}–${Math.round(s.entry.priceMax * 100)}¢ with ${mins(s.entry.minLeftSec)}–${mins(s.entry.maxLeftSec)} left; ${ex}.`;
}

/** Compile a validated recipe into an arena strategy. */
export function compileSpec(spec, meta = {}) {
  const s = spec;
  return {
    name: s.name,
    author: meta.author || "agent",
    created: meta.created || new Date().toISOString().slice(0, 10),
    family: s.family,
    description: describeSpec(s),
    spec: s,
    decide(ctx) {
      if (ctx.position) {
        const bid = ctx[ctx.position.side === "Up" ? "up" : "down"].bid;
        const move = bid - ctx.position.entry;
        if (s.exit.takeProfit && move >= s.exit.takeProfit) return { sell: true, reason: "take_profit" };
        if (s.exit.stopLoss && move <= -s.exit.stopLoss) return { sell: true, reason: "stop_loss" };
        return null;
      }
      const left = ctx.msLeft / 1000;
      if (left < s.entry.minLeftSec || left > s.entry.maxLeftSec) return null;
      let pick = null;
      if (s.side === "fair_value") {
        if (ctx.spot == null || ctx.strike == null) return null;
        const vol = spotVolPerSec(ctx.history);
        if (!vol) return null;
        const pUp = normCdf(Math.log(ctx.spot / ctx.strike) / (vol * Math.sqrt(Math.max(left, 1))));
        const upEdge = pUp - ctx.up.ask - takerFeePer(ctx.up.ask);
        const downEdge = (1 - pUp) - ctx.down.ask - takerFeePer(ctx.down.ask);
        if (upEdge >= downEdge && upEdge > s.entry.margin) pick = "Up";
        else if (downEdge > s.entry.margin) pick = "Down";
        if (!pick) return null;
      } else if (s.side === "up" || s.side === "down") {
        pick = s.side === "up" ? "Up" : "Down";
      } else {
        const favUp = ctx.mid >= 0.5;
        pick = (s.side === "favorite") === favUp ? "Up" : "Down";
      }
      const px = ctx[pick === "Up" ? "up" : "down"].ask;
      return px >= s.entry.priceMin && px <= s.entry.priceMax ? { buy: pick } : null;
    },
  };
}
