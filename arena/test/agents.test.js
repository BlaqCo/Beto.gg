import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec, compileSpec } from "../spec.js";
import { runWindow, scoreAll } from "../sim.js";
import { synthTape } from "../synth.js";

const good = { name: "late-fav-60", family: "btc15", side: "favorite",
  entry: { minLeftSec: 30, maxLeftSec: 240, priceMin: 0.55, priceMax: 0.75 }, exit: { takeProfit: 0.1, stopLoss: null }, rationale: "x" };

test("valid recipe passes, bad ones are rejected with a reason", () => {
  assert.equal(validateSpec(good).ok, true);
  for (const bad of [
    { ...good, name: "Bad Name!" },
    { ...good, family: "eth15" },
    { ...good, side: "yolo" },
    { ...good, entry: { ...good.entry, minLeftSec: 300, maxLeftSec: 100 } },
    { ...good, entry: { ...good.entry, maxLeftSec: 5000 } },
    { ...good, entry: { ...good.entry, priceMin: 0.9, priceMax: 0.5 } },
    { ...good, exit: { takeProfit: 2 } },
    { ...good, family: "sports", side: "fair_value" },
    { ...good, family: "sports", side: "up" },
    null, "drop table",
  ]) { const v = validateSpec(bad); assert.equal(v.ok, false, JSON.stringify(bad)); assert.ok(v.error); }
});

test("a recipe is data: extra fields like code are ignored", () => {
  const v = validateSpec({ ...good, decide: "process.exit(1)", code: "require('fs')" });
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.spec).sort(), ["entry", "exit", "family", "name", "rationale", "side"]);
});

test("compiled recipe trades only inside its window and band", () => {
  const s = compileSpec(validateSpec(good).spec, { author: "FORGE" });
  const W = { family: "btc15", slug: "w", start: 0, end: 900_000, strike: 1, outcome: 1, ticks: [
    [0, 0.60, 0.62, null, 1],          // 900s left: outside window
    [700_000, 0.60, 0.62, null, 1],    // 200s left: inside, favorite Up at 62c -> decide
    [701_000, 0.60, 0.62, null, 1] ] };
  const r = runWindow(s, W, { stake: 10 });
  assert.equal(r.side, "Up"); assert.equal(r.entry, 0.62);
  const W2 = { ...W, ticks: W.ticks.map(t => [t[0], 0.80, 0.82, null, 1]) };   // favorite too expensive
  assert.equal(runWindow(s, W2), null);
});

test("sports recipes and baseline score on sports windows", async () => {
  const { loadStrategies } = await import("../strategies/index.js");
  const { strategies } = await loadStrategies({ filesOnly: true });
  const spec = compileSpec(validateSpec({ name: "dog-pregame", family: "sports", side: "underdog",
    entry: { minLeftSec: 3600, maxLeftSec: 86400, priceMin: 0.3, priceMax: 0.45 }, exit: {} }).spec);
  const tape = synthTape({ windows: 60, family: "btc60", seed: 5 }).map(w => ({ ...w, family: "sports" }));
  const res = scoreAll([...strategies.filter(s => s.family === "sports"), spec], tape);
  assert.ok(res.rows.some(r => r.name === "dog-pregame"));
  assert.ok(res.rows.some(r => r.name === "baseline-sports"));
});

test("agent cycle: builders add validated recipes, PRISM retires losers, Council votes", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body.system.slice(0, 20));
    let text;
    if (body.system.includes("Council")) text = JSON.stringify({ ballots: [
      { voter: "FORGE", strategy: "a:btc15", reason: "best range" }, { voter: "PRISM", strategy: "b:btc15", reason: "more trades" },
      { voter: "WARDEN", strategy: "a:btc15", reason: "small drawdown" }, { voter: "HACKER", strategy: "a:btc15", reason: "x" },
      { voter: "VECTOR", strategy: "not-a-candidate", reason: "x" } ] });
    else if (body.system.includes("You are FORGE")) text = "```json\n" + JSON.stringify({ spec: good, note: "late favorites" }) + "\n```";
    else if (body.system.includes("You are VECTOR")) text = JSON.stringify({ spec: { ...good, name: "bad", entry: { maxLeftSec: 99999 } } });
    else text = "no json here";
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  };
  try {
    const agents = await import("../agents.js");
    const store = await import("../specs-store.js");
    await store.addSpec({ ...good, name: "old-loser" }, { author: "FORGE" });
    const row = (name, n, mean, lcb, ucb) => ({ id: `${name}:btc15`, name, family: "btc15", author: "x", all: { n, mean, lcb, ucb, winRate: .5, maxDD: 5 },
      forward: { n }, firstHalf: {}, secondHalf: {}, verdict: { label: "unproven" }, description: "" });
    const lb = { windows: { btc15: 50, btc60: 10, sports: 0 }, rows: [row("a", 40, .05, -.1, .2), row("b", 80, .02, -.2, .2), row("old-loser", 90, -.5, -.9, -.1)] };
    let changed = 0;
    agents.startAgents({ getLeaderboard: async () => lb, onChange: () => changed++ });   // AGENTS_ENABLED unset: doesn't schedule
    const res = await agents.runCycle();
    const specs = await store.listSpecs();
    assert.equal(specs.find(r => r.spec.name === "old-loser").status, "retired");
    assert.equal(specs.find(r => r.spec.name === "late-fav-60")?.author, "FORGE");
    assert.equal(specs.some(r => r.spec.name === "bad"), false);
    assert.equal(res.built, 1); assert.equal(res.retired, 1); assert.equal(res.ballots, 3);
    assert.ok(changed >= 1);
    assert.ok(res.lines.some(l => l.startsWith("DUGOUT: waiting for data")));
    const { recentVotes } = await import("../votes.js");
    assert.equal((await recentVotes()).length, 3);
  } finally { globalThis.fetch = realFetch; }
});
