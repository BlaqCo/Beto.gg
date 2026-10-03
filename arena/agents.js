/**
 * arena/agents.js — the colony's AI agents, running inside the server.
 *
 *   FORGE   writes BTC recipes from price patterns and timing
 *   VECTOR  writes BTC recipes from BTC spot vs strike (fair value)
 *   DUGOUT  writes sports recipes (pre-game)
 *   PRISM   retires recipes that are clearly losing (a rule, no AI call)
 *   COUNCIL every agent casts a ballot for the strategy that deserves the
 *           next forward-test focus, with a reason grounded in the numbers
 *
 * What they can do: add recipes (data, validated, never code) and cast votes.
 * What they can't do: change any bot setting, place or cancel orders, turn on
 * real money, or touch keys. Nothing here imports the trading code.
 *
 * Off unless AGENTS_ENABLED=true. Runs every AGENTS_EVERY_MIN (default 180).
 * Uses ANTHROPIC_API_KEY; model AGENTS_MODEL (default claude-sonnet-4-6).
 */
import { addSpec, listSpecs, retireSpec } from "./specs-store.js";
import { addVote } from "./votes.js";
import { describeSpec } from "./spec.js";

const EVERY_MIN = Math.max(30, Number(process.env.AGENTS_EVERY_MIN || 180));
const MODEL = process.env.AGENTS_MODEL || "claude-sonnet-4-6";
const MAX_ACTIVE = Number(process.env.AGENTS_MAX_ACTIVE || 40);

const status = { enabled: false, model: MODEL, everyMin: EVERY_MIN, runs: 0, lastRunAt: 0, nextRunAt: 0, running: false,
                 calls: 0, lastResult: null, lastError: null };
let getLeaderboard = null, onChange = () => {};

const BUILDERS = [
  { name: "FORGE", families: ["btc15", "btc60"],
    focus: "price behaviour and timing: when in the window to enter, favorite vs underdog, which price bands, and whether take-profit or stop-loss exits help or hurt" },
  { name: "VECTOR", families: ["btc15", "btc60"],
    focus: "BTC spot vs the window's strike price: the fair_value side, the margin needed after fees, and when in the window the market misprices it" },
  { name: "DUGOUT", families: ["sports"],
    focus: "pre-game sports moneylines: how many hours before the start to enter, favorite vs underdog, and which price bands" },
];

const SCHEMA = `{
  "name": "kebab-case-name-3-to-41-chars",
  "family": "btc15" | "btc60" | "sports",
  "side": "favorite" | "underdog" | "up" | "down" | "fair_value",   // sports: favorite or underdog only; fair_value: btc only
  "entry": { "minLeftSec": number, "maxLeftSec": number,              // enter only while time left is in this range (sports: seconds until game start; btc15 max 900, btc60 max 3600, sports max 172800)
             "priceMin": 0.02-0.98, "priceMax": 0.02-0.98,            // price paid for the side bought
             "margin": 0-0.2 },                                        // fair_value only: edge required after fees
  "exit": { "takeProfit": 0.01-0.6 or null, "stopLoss": 0.01-0.6 or null },   // price move from entry; null = hold to settlement
  "rationale": "1-2 sentences citing the numbers that motivated it"
}`;

async function claude(system, user, maxTokens = 900) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  status.calls++;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${data?.error?.message || "error"}`);
  const text = (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return parseJson(text);
}

export function parseJson(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

const r2 = v => v == null ? null : Math.round(v * 100) / 100;
function boardFor(rows, families) {
  return rows.filter(r => families.includes(r.family)).slice(0, 25).map(r => ({
    strategy: r.name, family: r.family, author: r.author, trades: r.all?.n ?? 0,
    winRate: r.all?.winRate == null ? null : Math.round(r.all.winRate * 100) / 100,
    perTrade: r2(r.all?.mean), range95: [r2(r.all?.lcb), r2(r.all?.ucb)], forwardTrades: r.forward?.n ?? 0,
    exits: r.exits, verdict: r.verdict?.label, description: r.description,
  }));
}

async function build(builder, lb, specs, log) {
  const tape = lb.windows || {};
  const recorded = builder.families.reduce((s, f) => s + (tape[f] || 0), 0);
  if (recorded < 3) { log(builder.name, `waiting for data: only ${recorded} recorded ${builder.families.join("/")} windows`); return null; }
  const mine = specs.filter(r => r.author === builder.name);
  const system = `You are ${builder.name}, a strategy researcher in an automated prediction-market lab. You design ONE new trading recipe at a time for Polymarket US "${builder.families.join('" or "')}" markets. Your focus: ${builder.focus}.
Every trade is simulated with realistic costs: fills at the next price update, buys pay the ask, sells receive the bid, and every fill pays a taker fee of 6% x p x (1-p) per contract. Spread and fees make most ideas lose; propose something with a concrete reason to beat them.
Rules: propose an idea that is meaningfully DIFFERENT from every existing strategy listed (not a tiny parameter tweak). Small samples (under 30 trades) prove nothing, so don't chase them. Never claim certainty.
Reply with ONLY a JSON object: {"spec": <recipe>, "note": "one sentence for the station log"}. Recipe schema:\n${SCHEMA}`;
  const user = `Recorded windows: ${JSON.stringify(tape)}.
Current leaderboard (your families only, ranked by the low end of the 95% range of profit per $10 trade):
${JSON.stringify(boardFor(lb.rows || [], builder.families))}
Your existing recipes: ${JSON.stringify(mine.map(r => ({ name: r.spec.name, status: r.status, what: describeSpec(r.spec), note: r.note })))}
Propose one new recipe now.`;
  const out = await claude(system, user);
  if (!out?.spec) { log(builder.name, "returned no usable recipe this round"); return null; }
  const res = await addSpec(out.spec, { author: builder.name });
  if (!res.ok) { log(builder.name, `recipe rejected by validation: ${res.error}`); return null; }
  log(builder.name, `new strategy ${res.rec.spec.name} (${res.rec.spec.family}): ${describeSpec(res.rec.spec)} ${out.note ? "— " + String(out.note).slice(0, 160) : ""}`);
  return res.rec;
}

async function prune(lb, specs, log) {
  let retired = 0;
  for (const rec of specs.filter(r => r.status === "active")) {
    const row = (lb.rows || []).find(r => r.name === rec.spec.name && r.family === rec.spec.family);
    if (!row) continue;
    if (row.all?.n >= 60 && row.all?.ucb != null && row.all.ucb < 0) {
      if (await retireSpec(rec.spec.name, `losing: ${row.all.n} trades, best case ${r2(row.all.ucb)}/trade`)) {
        retired++; log("PRISM", `retired ${rec.spec.name}: ${row.all.n} trades and even the optimistic estimate loses money`);
      }
    }
  }
  return retired;
}

async function council(lb, log) {
  const cands = (lb.rows || []).filter(r => r.verdict?.label !== "control" && (r.all?.n ?? 0) >= 30)
    .sort((a, b) => (b.all.lcb ?? -9) - (a.all.lcb ?? -9)).slice(0, 5);
  if (cands.length < 2) { log("ORACLE", `no vote this round: ${cands.length} strategy(ies) have 30+ trades, need 2`); return 0; }
  const voters = ["FORGE", "VECTOR", "PRISM", "DUGOUT", "WARDEN"];
  const system = `You are the Council of an automated prediction-market lab. Each member casts ONE vote for which candidate strategy deserves the next forward-test focus. Members: FORGE (price patterns), VECTOR (spot vs strike), PRISM (skeptic: punishes small samples and overfitting), DUGOUT (sports), WARDEN (risk: prefers small drawdowns and stable results). Votes must be grounded in the numbers given; a vote never means a strategy is proven profitable. Reply with ONLY JSON: {"ballots":[{"voter":"FORGE","strategy":"<id>","reason":"one sentence citing numbers"}, ...]} with exactly one ballot per member.`;
  const user = `Candidates (id = name:family):\n${JSON.stringify(cands.map(r => ({ id: r.id, trades: r.all.n, winRate: r2(r.all.winRate), perTrade: r2(r.all.mean), range95: [r2(r.all.lcb), r2(r.all.ucb)], forwardTrades: r.forward?.n ?? 0, maxDrawdown: r2(r.all.maxDD), firstHalfPerTrade: r2(r.firstHalf?.mean), secondHalfPerTrade: r2(r.secondHalf?.mean), verdict: r.verdict?.label, description: r.description })))}`;
  const out = await claude(system, user, 700);
  const round = new Date().toISOString().slice(0, 13).replace("T", " ") + "h";
  const ids = new Set(cands.map(c => c.id));
  let cast = 0;
  for (const b of out?.ballots || []) {
    if (!voters.includes(b?.voter) || !ids.has(b?.strategy)) continue;
    const [name, family] = String(b.strategy).split(":");
    await addVote({ round, voter: b.voter, strategy: name, family, reason: String(b.reason || "") });
    cast++;
  }
  const tally = {};
  for (const b of out?.ballots || []) if (ids.has(b?.strategy)) tally[b.strategy] = (tally[b.strategy] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  log("ORACLE", top ? `vote ${round}: ${top[0]} leads with ${top[1]}/${cast} ballots (forward-test focus only; no money moves)` : "vote produced no valid ballots");
  return cast;
}

export async function runCycle() {
  if (status.running) return status.lastResult;
  status.running = true; status.lastError = null;
  const lines = [];
  const log = (who, msg) => { lines.push(`${who}: ${msg}`); console.log(`  🤖 [agents] ${who}: ${msg}`); };
  const result = { at: Date.now(), built: 0, retired: 0, ballots: 0, lines };
  try {
    let lb = await getLeaderboard();
    let specs = await listSpecs();
    result.retired = await prune(lb, specs, log);
    const active = specs.filter(r => r.status === "active").length - result.retired;
    if (active >= MAX_ACTIVE) log("PRISM", `holding: ${active} active recipes (limit ${MAX_ACTIVE}); no new ones until some are retired`);
    else for (const b of BUILDERS) {
      try { if (await build(b, lb, specs, log)) result.built++; }
      catch (err) { log(b.name, `error: ${err.message}`); }
      specs = await listSpecs();
    }
    if (result.built || result.retired) { onChange(); lb = await getLeaderboard(); }
    try { result.ballots = await council(lb, log); } catch (err) { log("ORACLE", `vote error: ${err.message}`); }
  } catch (err) {
    status.lastError = err.message; log("WARDEN", `agent cycle failed: ${err.message}`);
  } finally {
    status.running = false; status.runs++; status.lastRunAt = Date.now(); status.nextRunAt = Date.now() + EVERY_MIN * 60_000; status.lastResult = result;
  }
  return result;
}

export function startAgents(opts) {
  getLeaderboard = opts.getLeaderboard; onChange = opts.onChange || (() => {});
  if (process.env.AGENTS_ENABLED !== "true") { console.log("🤖 AI agents off (set AGENTS_ENABLED=true to let them write strategies and vote)"); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("🤖 AI agents can't start: ANTHROPIC_API_KEY is not set"); return; }
  status.enabled = true;
  status.nextRunAt = Date.now() + 3 * 60_000;
  setTimeout(() => runCycle().catch(() => {}), 3 * 60_000);
  setInterval(() => runCycle().catch(() => {}), EVERY_MIN * 60_000);
  console.log(`🤖 AI agents on — FORGE, VECTOR, DUGOUT, PRISM and the Council run every ${EVERY_MIN} min (model ${MODEL}); they can add recipes and vote, nothing else`);
}

export function agentsStatus() { return { ...status, lastResult: status.lastResult && { ...status.lastResult, lines: status.lastResult.lines.slice(-12) } }; }
