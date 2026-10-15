/**
 * arena/agents.js — the colony's AI agents, running inside the server.
 *
 *   FORGE   writes BTC recipes from price patterns and timing
 *   VECTOR  writes BTC recipes from BTC spot vs strike (fair value)
 *   DUGOUT  writes sports recipes (pre-game)
 *   TUNER   studies SHADOW's signal log (SHADOW LAB) and proposes changes to SHADOW's rule
 *   PRISM   retires recipes and SHADOW proposals that are clearly losing (a rule, no AI call)
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
// Kept small on purpose: every extra strategy raises the odds that one looks good by luck.
const MAX_ACTIVE = Number(process.env.AGENTS_MAX_ACTIVE || 15);

const status = { enabled: false, model: MODEL, everyMin: EVERY_MIN, runs: 0, lastRunAt: 0, nextRunAt: 0, running: false,
                 calls: 0, lastResult: null, lastError: null };
let getLeaderboard = null, onChange = () => {}, getShadowRule = null;

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

// ── TUNER: SHADOW's edge ────────────────────────────────────────────
const RULE_SCHEMA = `{
  "name": "kebab-case-name",
  "rule": {
    "priceMin": 0.30-0.95, "priceMax": 0.35-0.97,        // price paid for the side bought (its ask)
    "minLeftSec": 15-600, "maxLeftSec": 30-600,          // enter only while time left is in this range
    "minShare": 0.5-1,                                    // share of smart-wallet vote weight on our side
    "minAgree": 0-15,                                     // smart wallets on our side (not needed when following the primary wallet)
    "maxAgainst": 0-50 or omit,                           // most smart wallets allowed on the other side
    "follow": "either" | "consensus" | "primary" | "both", // either = primary wallet if it bet, else smart money
    "side": "any" | "up" | "down",
    "hoursUtc": [start, end] or null                      // whole UTC hours the window must start in
  },
  "rationale": "1-2 sentences citing the numbers"
}`;
const MIN_LAB_WINDOWS = 48;   // half a day of BTC15 before the TUNER says anything

export async function tune(log, labMod = null) {
  const lab = labMod || await import("./shadow-lab.js");
  await lab.loadLab();
  const windows = lab.labWindows().filter(w => w.outcome != null);
  if (windows.length < MIN_LAB_WINDOWS) { log("TUNER", `waiting for data: ${windows.length} SHADOW LAB windows logged, need ${MIN_LAB_WINDOWS}`); return null; }
  await lab.pruneProposals(log);
  const cur = getShadowRule ? getShadowRule() : null;
  const v = lab.validateRule(cur || {});
  if (!v.ok) { log("TUNER", `can't read SHADOW's rule: ${v.error}`); return null; }
  const st = lab.labStatus(v.rule);
  const sens = lab.sensitivity(v.rule, windows);
  const system = `You are TUNER, the researcher who improves SHADOW, a bot that copies smart Polymarket wallets on 15-minute BTC Up/Down markets. You propose ONE change to SHADOW's entry rule at a time.
You get: SHADOW's current rule and its backtest over the signal log (every window, every 15s in the last 10 minutes: smart-money side and share, wallets for and against, the primary wallet's side, live prices), a sensitivity table (what moving each setting alone does), and the proposals already being tested with their backtest and FORWARD numbers (forward = windows after the proposal was made, the only numbers that can't be fitted).
Bets are $10, pay the ask plus a taker fee of 6% x p x (1-p) per share, and are held to the close. perBet is $ profit per $10 bet; lcb is the low end of its 95% range.
Rules: the goal is a rule that makes money on FUTURE windows, not one that fits the past. Prefer simple changes with a clear reason (one or two settings), backed by many bets (the sample shrinks as filters tighten; under 40 bets proves nothing). Don't repeat an existing proposal. Never claim certainty.
Reply with ONLY JSON: ${RULE_SCHEMA}`;
  const brief = p => ({ id: p.id, rule: p.text, author: p.author, status: p.status, backtest: { n: p.backtest.n, winRate: p.backtest.winRate, perBet: p.backtest.perBet, lcb: p.backtest.lcb }, forward: { n: p.forward.n, winRate: p.forward.winRate, perBet: p.forward.perBet } });
  const user = `Windows logged with a result: ${windows.length}.
SHADOW now: ${st.current.text}. Rule JSON: ${JSON.stringify(v.rule)}
Its backtest: ${JSON.stringify({ n: st.current.n, winRate: st.current.winRate, perBet: st.current.perBet, lcb: st.current.lcb, firstHalf: st.current.firstHalf, secondHalf: st.current.secondHalf })}
Sensitivity (each setting moved alone): ${JSON.stringify(sens)}
Proposals so far: ${JSON.stringify(st.proposals.slice(0, 12).map(brief))}
Propose one rule now.`;
  const out = await claude(system, user, 900);
  if (!out?.rule) { log("TUNER", "returned no usable proposal this round"); return null; }
  const res = await lab.addProposal({ name: out.name, rule: out.rule, rationale: out.rationale, author: "TUNER" });
  if (!res.ok) { log("TUNER", `proposal rejected: ${res.error}`); return null; }
  const sc = lab.scoreProposal(res.proposal);
  log("TUNER", `new SHADOW proposal ${sc.id}: ${sc.text}. Backtest ${sc.backtest.n} bets, ${sc.backtest.winRate == null ? "—" : Math.round(sc.backtest.winRate * 100) + "%"} won, ${sc.backtest.perBet == null ? "—" : (sc.backtest.perBet >= 0 ? "+" : "") + sc.backtest.perBet.toFixed(2)}/bet. Forward test starts now.${out.rationale ? " " + String(out.rationale).slice(0, 200) : ""}`);
  return res.proposal;
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
    try { if (await tune(log)) result.tuned = 1; } catch (err) { log("TUNER", `error: ${err.message}`); }
    try { result.ballots = await council(lb, log); } catch (err) { log("ORACLE", `vote error: ${err.message}`); }
  } catch (err) {
    status.lastError = err.message; log("WARDEN", `agent cycle failed: ${err.message}`);
  } finally {
    status.running = false; status.runs++; status.lastRunAt = Date.now(); status.lastResult = result;
  }
  return result;
}

export function startAgents(opts) {
  getLeaderboard = opts.getLeaderboard; onChange = opts.onChange || (() => {}); getShadowRule = opts.getShadowRule || null;
  if (process.env.AGENTS_ENABLED !== "true") { console.log("🤖 AI agents off (set AGENTS_ENABLED=true to let them write strategies and vote)"); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("🤖 AI agents can't start: ANTHROPIC_API_KEY is not set"); return; }
  status.enabled = true;
  status.nextRunAt = Date.now() + 3 * 60_000;
  setTimeout(() => runCycle().catch(() => {}), 3 * 60_000);
  setTimeout(() => { status.nextRunAt = Date.now() + EVERY_MIN * 60_000; }, 3 * 60_000 + 1000);
  setInterval(() => { status.nextRunAt = Date.now() + EVERY_MIN * 60_000; runCycle().catch(() => {}); }, EVERY_MIN * 60_000);
  console.log(`🤖 AI agents on — FORGE, VECTOR, DUGOUT, TUNER (SHADOW), PRISM and the Council run every ${EVERY_MIN} min (model ${MODEL}); they can add recipes and vote, nothing else`);
}

export function _setShadowRule(fn) { getShadowRule = fn; }   // tests
export function agentsStatus() { return { ...status, lastResult: status.lastResult && { ...status.lastResult, lines: status.lastResult.lines.slice(-12) } }; }
