#!/usr/bin/env node
/**
 * arena/run.js — score every strategy against the tape and print a leaderboard.
 *
 *   node arena/run.js                     # tape from Redis (or data/tape/*.jsonl)
 *   node arena/run.js --file a.jsonl      # a downloaded tape file (repeatable)
 *   node arena/run.js --synth 300         # SYNTHETIC demo data, for testing only
 *   node arena/run.js --json out.json     # also write the full results
 */
import fs from "fs";
import { loadStrategies } from "./strategies/index.js";
import { scoreAll } from "./sim.js";
import { loadWindows, loadFile, FAMILIES } from "./tape.js";
import { synthTape } from "./synth.js";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const files = args.flatMap((a, i) => a === "--file" ? [args[i + 1]] : []);

let windows = [];
let synthetic = false;
if (opt("--synth")) {
  const n = Number(opt("--synth")) || 200;
  windows = [...synthTape({ windows: n, family: "btc15", seed: 7 }), ...synthTape({ windows: Math.ceil(n / 4), family: "btc60", seed: 11 })];
  synthetic = true;
} else if (files.length) {
  for (const f of files) windows.push(...loadFile(f));
} else {
  for (const fam of FAMILIES) windows.push(...await loadWindows(fam));
}

const { strategies, errors } = await loadStrategies();
for (const e of errors) console.log(`⚠️  skipped ${e.file}: ${e.error}`);
if (!windows.length) { console.log("No recorded windows yet. Turn on the recorder (ARENA_RECORD=true) and let it run."); process.exit(0); }

const res = scoreAll(strategies, windows);
const money = v => v == null ? "—" : (v >= 0 ? "+" : "−") + "$" + Math.abs(v).toFixed(2);
const pct = v => v == null ? "—" : (v * 100).toFixed(1) + "%";
console.log(`\n${synthetic ? "SYNTHETIC DATA (simulator test only, not market results)\n" : ""}Windows: ${JSON.stringify(res.windows)} · stake $${res.stake}/trade · ${new Date(res.from).toISOString()} → ${new Date(res.to).toISOString()}\n`);
const head = ["strategy", "family", "trades", "win%", "P&L", "per trade", "95% range per trade", "max DD", "fwd trades", "verdict"];
const rows = res.rows.map(r => [r.name, r.family, r.all.n, pct(r.all.winRate), money(r.all.pnl), money(r.all.mean),
  r.all.lcb == null ? "—" : `${money(r.all.lcb)} to ${money(r.all.ucb)}`, money(-r.all.maxDD), r.forward.n, r.verdict.label]);
const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
const line = r => r.map((c, i) => String(c).padEnd(w[i])).join("  ");
console.log(line(head)); console.log(w.map(n => "-".repeat(n)).join("  ")); rows.forEach(r => console.log(line(r)));
console.log(`\n${res.strategies} strategies tested. With many strategies, one will look good by luck; trust forward results, not the top row.`);
if (opt("--json")) { fs.writeFileSync(opt("--json"), JSON.stringify({ synthetic, ...res }, null, 2)); console.log(`Wrote ${opt("--json")}`); }
