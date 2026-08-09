/**
 * brain.js — BetoBot's answers
 *
 * Turns the bot's own data into plain answers: which sport is profitable,
 * why nothing has been bet lately, how the current settings are performing.
 *
 * Everything here is computed from data the bot already has — settled bets,
 * the last scan's gate counts, and the live config. If ANTHROPIC_API_KEY is
 * set, anything the rules don't cover is handed to Claude along with the
 * same computed facts, so its answer is grounded rather than invented.
 */

import { getConfig, getFunnel } from "./config.js";

// ── league inference ─────────────────────────────────────────────
// Slugs look like aec-atp-foo-bar-2026-08-09 / aec-itfwo-… / aec-mlb-…
const LEAGUE_MAP = [
  [/\b(atp|wta|itfme|itfwo|itf|challenger)\b/i, "Tennis"],
  [/\b(setka|tt|table)\b/i,                      "Table tennis"],
  [/\b(mlb|npb|kbo)\b/i,                         "Baseball"],
  [/\b(nba|nbasl|ncaamb)\b/i,                    "Basketball"],
  [/\b(nfl|ncaafb)\b/i,                          "Football"],
  [/\b(nhl)\b/i,                                 "Hockey"],
  [/\b(cs2|valorant|lol|dota|esport)\b/i,        "Esports"],
  [/\b(epl|laliga|seriea|bundesliga|ligue1|mls|ucl|soccer)\b/i, "Soccer"],
  [/\b(ufc|mma|boxing)\b/i,                      "Combat"],
  [/\b(cricket|odi|t20)\b/i,                     "Cricket"],
];
export function leagueOf(bet) {
  const hay = `${bet.marketSlug || bet.slug || ""} ${bet.question || ""}`;
  for (const [re, name] of LEAGUE_MAP) if (re.test(hay)) return name;
  return "Other";
}

const money = n => (n >= 0 ? "+$" : "−$") + Math.abs(n).toFixed(2);

/** Roll settled bets up by league. */
export function bySport(history) {
  const g = {};
  for (const b of history) {
    if (b._type !== "resolution" && !(b.realizedPnl || b.pnl)) continue;
    const k = leagueOf(b);
    const pnl = Number(b.realizedPnl ?? b.pnl ?? 0);
    const won = b.won === true || pnl > 0;
    (g[k] ||= { league: k, n: 0, w: 0, l: 0, pnl: 0, staked: 0 });
    g[k].n++; g[k][won ? "w" : "l"]++;
    g[k].pnl += pnl;
    g[k].staked += Number(b.costBasis ?? b.betSize ?? 0);
  }
  return Object.values(g).sort((a, b) => b.pnl - a.pnl);
}

/** The facts BetoBot reasons from. */
export async function snapshot(history = []) {
  const cfg = await getConfig();
  const f = getFunnel();
  const sports = bySport(history);
  const settled = sports.reduce((a, s) => a + s.n, 0);
  const wins = sports.reduce((a, s) => a + s.w, 0);
  const pnl = sports.reduce((a, s) => a + s.pnl, 0);
  return {
    cfg, funnel: f, sports, settled, wins,
    losses: settled - wins,
    pnl,
    winRate: settled ? (wins / settled) * 100 : null,
    lastScanAgeMs: f.ts ? Date.now() - f.ts : null,
  };
}

// ── answers ──────────────────────────────────────────────────────
function answerSport(s, worst = false) {
  if (!s.sports.length) return "No settled bets yet, so there's nothing to compare by sport. Once a few close out I can break it down.";
  const ranked = worst ? [...s.sports].reverse() : s.sports;
  const top = ranked[0];
  const lines = s.sports.slice(0, 6).map(x =>
    `${x.league}: ${money(x.pnl)} over ${x.n} bets (${x.w}W/${x.l}L)`);
  const verb = worst ? "worst" : "best";
  return `Your ${verb} category is ${top.league} at ${money(top.pnl)} across ${top.n} settled bets (${top.w}W/${top.l}L).\n\n${lines.join("\n")}`;
}

function answerWhyNoBets(s) {
  const c = s.cfg, f = s.funnel;
  const reasons = [];

  if (c.PAUSED) reasons.push("You have the bot paused — that alone stops all new bets.");
  if (c.KILL_ENABLED && f.balance != null && f.balance < c.KILL_FLOOR)
    reasons.push(`The circuit breaker tripped: balance is under your $${c.KILL_FLOOR} floor.`);
  if (f.slots && f.slots.max < 9999 && f.slots.used >= f.slots.max)
    reasons.push(`All ${f.slots.max} slots are full — nothing new until a position settles.`);
  if (f.balance != null && f.balance < c.BET_SIZE)
    reasons.push(`Buying power is $${Number(f.balance).toFixed(2)}, below the $${c.BET_SIZE} bet size.`);

  const st = Object.fromEntries((f.stages || []).map(x => [x.name, x.count]));
  if (!reasons.length && st.candidates === 0) {
    const band = `${Math.round(c.FAV_MIN * 100)}–${Math.round(c.FAV_MAX * 100)}¢`;
    const LABEL = {
      notLive:    "not live yet",
      tooEarly:   `less than ${c.MIN_LIVE_MIN}m into play`,
      badBook:    "stub or one-sided book",
      quoteHold:  "price hadn't held steady",
      noDiscount: "not discounted past the fee",
      notNearLow: "above their trailing low",
      thinBook:   "not enough depth",
    };
    const g = Object.entries(f.gates || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (g.length) {
      const top = g.slice(0, 3).map(([k, v]) => `${v} ${LABEL[k] || k}`).join(", ");
      reasons.push(`Everything got filtered out. On the last scan: ${top}. Those are the gates doing their job — the board just isn't offering the shape you're asking for (${band}, live, discounted, near its low).`);
    } else {
      reasons.push(`Nothing is clearing the filters. Last scan priced ${st.priced ?? "?"} markets and none passed the ${band} band plus the discount and near-low tests.`);
    }
  }
  if (!reasons.length && st.entries > 0)
    reasons.push(`It has been betting — ${st.entries} entries on the last scan.`);

  const age = s.lastScanAgeMs == null ? "never" :
    s.lastScanAgeMs < 60000 ? `${Math.round(s.lastScanAgeMs / 1000)}s ago` :
    `${Math.round(s.lastScanAgeMs / 60000)}m ago`;
  if (s.lastScanAgeMs != null && s.lastScanAgeMs > 120000)
    reasons.push(`Heads up: the last scan was ${age} — the bot may not be running.`);

  return (reasons.join(" ") || "Nothing is blocking it — the board just hasn't offered a qualifying price.") +
         `\n\nLast scan ${age}: ${(f.stages || []).map(x => `${x.name} ${x.count}`).join(" → ")}`;
}

function answerPerformance(s) {
  if (!s.settled) return "Nothing has settled yet, so there's no win rate to report.";
  const be = ((s.cfg.FAV_MIN + s.cfg.FAV_MAX) / 2 + 0.011) * 100;
  const verdict = s.winRate >= be
    ? `That's above the ~${be.toFixed(0)}% you need to break even at these prices.`
    : `Break-even at these prices is about ${be.toFixed(0)}%, so this is running short.`;
  return `${s.wins}W / ${s.losses}L over ${s.settled} settled bets — ${s.winRate.toFixed(1)}%, ${money(s.pnl)}. ${verdict}`;
}

function answerSettings(s) {
  const c = s.cfg;
  return [
    `Bet size $${c.BET_SIZE}`,
    `band ${Math.round(c.FAV_MIN * 100)}–${Math.round(c.FAV_MAX * 100)}¢`,
    c.MAX_CONC >= 9999 ? "unlimited slots" : `${c.MAX_CONC} slots`,
    c.MIN_LIVE_MIN > 0 ? `waits ${c.MIN_LIVE_MIN}m after tip-off` : "enters as soon as live",
    c.DCA_ENABLED ? `second buy at −${Math.round(c.DCA_DROP_PCT * 100)}%` : "no second buy",
    c.TP_ENABLED ? `takes profit at ${Math.round(c.TP_PRICE * 100)}¢` : "no take profit",
    c.MAKER_MODE ? "posts maker orders" : "takes the ask",
    c.PAUSED ? "PAUSED" : "running",
  ].join(" · ");
}

const QUESTIONS = [
  { re: /\b(worst|losing|lose most|bad(?:est)?)\b.*\b(sport|categor|league)\b|\b(sport|categor|league)\b.*\b(worst|losing)\b/i,
    fn: s => answerSport(s, true) },
  { re: /\b(best|most|which|what)\b.*\b(sport|categor|league)\b|\b(sport|categor|league)\b.*\b(best|most profit|winning)\b/i,
    fn: s => answerSport(s, false) },
  { re: /\bwhy\b.*\b(no|not|haven'?t|hasn'?t|zero)\b.*\b(bet|bets|betting|entr|trade)\b|\bwhy.*(quiet|idle|nothing)\b/i,
    fn: answerWhyNoBets },
  { re: /\b(win rate|winrate|how (?:am i|are we) doing|performance|profitable|am i (?:up|down)|p&?l|pnl)\b/i,
    fn: answerPerformance },
  { re: /\b(settings|config|current setup|what are you running|how are you set)\b/i,
    fn: answerSettings },
  { re: /\b(what|which)\b.*\b(open|positions|holding)\b/i,
    fn: s => {
      const f = s.funnel;
      return f.slots ? `Holding ${f.slots.used} position${f.slots.used === 1 ? "" : "s"}${f.slots.max < 9999 ? ` of ${f.slots.max}` : ""}. Open positions are listed below.`
                     : "I don't have a position count from the last scan yet.";
    } },
];

/** Is this a question rather than a settings change? */
export function looksLikeQuestion(text) {
  return /\?|^\s*(what|why|which|how|who|when|is|are|am|do|does|should|tell me|explain|show)\b/i.test(text || "");
}

async function askClaude(text, s) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const facts = {
    settings: s.cfg,
    performance: { settled: s.settled, wins: s.wins, losses: s.losses, pnl: +s.pnl.toFixed(2), winRatePct: s.winRate },
    bySport: s.sports.map(x => ({ league: x.league, bets: x.n, w: x.w, l: x.l, pnl: +x.pnl.toFixed(2) })),
    lastScan: s.funnel,
    lastScanSecondsAgo: s.lastScanAgeMs == null ? null : Math.round(s.lastScanAgeMs / 1000),
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 400,
        system: "You are BetoBot, the assistant inside a sports prediction-market trading bot. Answer the operator's question using ONLY the JSON facts provided. Be direct and concrete, use the real numbers, and keep it under 90 words. Plain text, no markdown. If the facts don't contain the answer, say so plainly rather than guessing.",
        messages: [{ role: "user", content: `FACTS:\n${JSON.stringify(facts)}\n\nQUESTION: ${text}` }],
      }),
    });
    const data = await res.json();
    const out = (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    return out || null;
  } catch { return null; }
}

/** Answer a question. Returns { answer, source }. */
export async function answer(text, history = []) {
  const s = await snapshot(history);
  for (const q of QUESTIONS) {
    if (q.re.test(text)) return { answer: q.fn(s), source: "data" };
  }
  const ai = await askClaude(text, s);
  if (ai) return { answer: ai, source: "model" };
  return {
    answer: "I can answer questions about which sports are profitable, why bets aren't happening, your win rate, and current settings. Or tell me a change like \"bet size 5\".",
    source: "none",
  };
}
