/**
 * arena/synth.js — SYNTHETIC tape for testing the simulator. Not market data.
 * BTC follows a random walk; the book quotes the true fair value plus noise
 * with a fixed spread. In this world nothing should beat spread + fees by much.
 */
import { normCdf } from "./lib.js";

function rng(seed) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

export function synthTape({ windows = 200, family = "btc15", seed = 42, tickMs = 5000, volPerSec = 0.00012,
                            halfSpread = 0.01, quoteNoise = 0.02, startAt = Date.UTC(2026, 9, 1) } = {}) {
  const r = rng(seed);
  const len = family === "btc60" ? 3_600_000 : 900_000;
  let spot = 62_000;
  const out = [];
  for (let w = 0; w < windows; w++) {
    const start = startAt + w * len, end = start + len, strike = spot;
    const ticks = [];
    for (let t = start; t < end; t += tickMs) {
      spot *= Math.exp(volPerSec * Math.sqrt(tickMs / 1000) * gauss(r));
      const tau = (end - t) / 1000;
      const fair = normCdf(Math.log(spot / strike) / (volPerSec * Math.sqrt(Math.max(tau, 1))));
      const mid = Math.min(0.98, Math.max(0.02, fair + quoteNoise * gauss(r)));
      ticks.push([t, +(mid - halfSpread).toFixed(3), +(mid + halfSpread).toFixed(3), null, +spot.toFixed(2)]);
    }
    out.push({ v: 1, family, slug: `synthetic-${family}-${w}`, start, end, strike, outcome: spot >= strike ? 1 : 0, ticks, synthetic: true });
  }
  return out;
}
