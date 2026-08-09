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


// ── deeper analytics ─────────────────────────────────────────────
const sortByTime = h => [...h].sort((a, b) =>
  String(a.createTime || "").localeCompare(String(b.createTime || "")));

export function streaks(history) {
  const seq = sortByTime(history)
    .filter(b => b._type === "resolution" || b.won != null || b.realizedPnl != null)
    .map(b => (b.won === true || Number(b.realizedPnl ?? b.pnl ?? 0) > 0));
  let bestW = 0, bestL = 0, curW = 0, curL = 0, cur = 0, curIsWin = null;
  for (const win of seq) {
    if (win) { curW++; curL = 0; bestW = Math.max(bestW, curW); }
    else     { curL++; curW = 0; bestL = Math.max(bestL, curL); }
  }
  const last = seq[seq.length - 1];
  cur = last === undefined ? 0 : (last ? curW : curL);
  curIsWin = last;
  return { longestWin: bestW, longestLoss: bestL, current: cur, currentIsWin: curIsWin, n: seq.length };
}

/** Win rate by entry-price bucket, measured against real break-even. */
export function byPriceBucket(history) {
  const B = {};
  for (const b of history) {
    const px = Number(b.price ?? b.entryPrice ?? 0);
    if (!(px > 0.3 && px < 0.99)) continue;
    const lo = Math.floor(px * 100 / 4) * 4;
    const key = `${lo}-${lo + 3}`;
    const won = b.won === true || Number(b.realizedPnl ?? b.pnl ?? 0) > 0;
    (B[key] ||= { bucket: key, mid: (lo + 2) / 100, n: 0, w: 0, pnl: 0 });
    B[key].n++; if (won) B[key].w++;
    B[key].pnl += Number(b.realizedPnl ?? b.pnl ?? 0);
  }
  return Object.values(B).map(x => {
    const c = 1 / x.mid, fee = 0.03 * c * Math.min(x.mid, 1 - x.mid);
    return { ...x, rate: x.w / x.n, breakEven: (1 + fee) / c, edge: x.w / x.n - (1 + fee) / c };
  }).sort((a, b) => a.mid - b.mid);
}

function answerSuggestEdge(s, history) {
  const buckets = byPriceBucket(history).filter(b => b.n >= 3);
  if (!buckets.length) {
    return `Not enough settled bets yet to recommend a band — I need at least a few per price bucket. Right now you have ${s.settled} settled. Keep the current ${Math.round(s.cfg.FAV_MIN*100)}–${Math.round(s.cfg.FAV_MAX*100)}¢ band running and ask me again once ~30 have closed.`;
  }
  const green = buckets.filter(b => b.edge > 0);
  const lines = buckets.map(b =>
    `${b.bucket}¢: ${(b.rate*100).toFixed(0)}% over ${b.n} (need ${(b.breakEven*100).toFixed(0)}%) ${b.edge>0?"✓":"✗"}`);
  if (!green.length) {
    const best = buckets.reduce((a, b) => b.edge > a.edge ? b : a);
    return `No price bucket is beating its break-even yet.\n\n${lines.join("\n")}\n\nClosest is ${best.bucket}¢, still ${Math.abs(best.edge*100).toFixed(1)} points short. On this data I'd keep stakes small rather than widen the band.`;
  }
  const lo = Math.min(...green.map(b => b.mid)) - 0.02;
  const hi = Math.max(...green.map(b => b.mid)) + 0.02;
  return `Based on ${s.settled} settled bets, the buckets clearing break-even are ${green.map(b=>b.bucket+"¢").join(", ")}.\n\n${lines.join("\n")}\n\nI'd suggest a band of ${Math.round(lo*100)}–${Math.round(hi*100)}¢. Say "edge ${Math.round(lo*100)}-${Math.round(hi*100)}" and I'll set it.`;
}

function answerProjection(s, history, days = 2) {
  if (s.settled < 5) return `Only ${s.settled} settled bets — too thin to project from. Ask again after ~20.`;
  const times = history.map(b => b.createTime).filter(Boolean).sort();
  let perDay = s.settled;
  if (times.length > 1) {
    const spanDays = Math.max(0.5, (new Date(times[times.length-1]) - new Date(times[0])) / 86400000);
    perDay = s.settled / spanDays;
  }
  const avgStake = history.reduce((a, b) => a + Number(b.costBasis ?? b.betSize ?? 0), 0) / Math.max(1, s.settled) || s.cfg.BET_SIZE;
  const evPerBet = s.pnl / s.settled;
  const proj = evPerBet * perDay * days;
  const dir = proj >= 0 ? "gain" : "loss";
  return `At your current ${s.winRate.toFixed(1)}% win rate you're averaging ${evPerBet >= 0 ? "+" : "−"}$${Math.abs(evPerBet).toFixed(2)} per settled bet, across roughly ${perDay.toFixed(1)} bets/day at $${avgStake.toFixed(2)} average stake.\n\nOver ${days} days that projects to a ${dir} of about ${proj >= 0 ? "+$" : "−$"}${Math.abs(proj).toFixed(2)}.\n\nThat's a straight-line estimate from a ${s.settled}-bet sample — real swings will be much wider in both directions.`;
}

function answerWeakestSport(s) {
  const withN = s.sports.filter(x => x.n >= 2);
  if (!withN.length) return "Not enough settled bets per sport to rank win rates yet.";
  const worst = withN.reduce((a, b) => (b.w / b.n) < (a.w / a.n) ? b : a);
  const lines = withN.map(x => `${x.league}: ${((x.w/x.n)*100).toFixed(0)}% (${x.w}W/${x.l}L) ${money(x.pnl)}`);
  return `Weakest win rate is ${worst.league} at ${((worst.w/worst.n)*100).toFixed(0)}% (${worst.w}W/${worst.l}L, ${money(worst.pnl)}).\n\n${lines.join("\n")}`;
}

function answerPromising(s) {
  const w = s.funnel.watchlist || [];
  if (!w.length) return "No live markets on the board right now — nothing to watch. The bot only tracks games already in play.";
  const ready = w.filter(x => !x.blocker);
  const lines = w.slice(0, 6).map(x => {
    const move = x.high ? ` (high ${Math.round(x.high*100)}¢)` : "";
    return `${Math.round(x.px*100)}¢${move} ${x.q}${x.blocker ? ` — ${x.blocker}` : " — READY"}`;
  });
  const head = ready.length
    ? `${ready.length} market${ready.length===1?"":"s"} clearing every filter right now.`
    : `Nothing is clearing all the filters yet. Closest ones:`;
  return `${head}\n\n${lines.join("\n")}`;
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
  { re: /\b(promising|look good|worth betting|what.*(watch|tracking|board)|any (good )?(games|plays|bets))\b/i,
    fn: (s) => answerPromising(s) },
  { re: /\b(suggest|recommend|what).*(edge|band|range)\b|\bbest (edge|band|range)\b/i,
    fn: (s, h) => answerSuggestEdge(s, h) },
  { re: /\b(predict|project|forecast|how much.*(make|profit)|next (couple|few|\d+) days?)\b/i,
    fn: (s, h, t) => { const m = (t||"").match(/(\d+)\s*days?/i); return answerProjection(s, h, m ? +m[1] : 2); } },
  { re: /\b(streak|in a row|consecutive)\b/i,
    fn: (s, h) => {
      const k = streaks(h);
      if (!k.n) return "No settled bets yet, so no streaks to report.";
      const cur = k.currentIsWin == null ? "" : ` Currently on ${k.current} ${k.currentIsWin ? (k.current===1?"win":"wins") : (k.current===1?"loss":"losses")} in a row.`;
      return `Longest win streak: ${k.longestWin}. Longest losing streak: ${k.longestLoss}. Over ${k.n} settled bets.${cur}`;
    } },
  { re: /\b(lack|weakest|worst win rate|least wins|struggling)\b/i,
    fn: (s) => answerWeakestSport(s) },
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

let _aiWarned = false;
async function askClaude(text, s) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    if (!_aiWarned) { _aiWarned = true; console.log("🧠 BetoBot: no ANTHROPIC_API_KEY — built-in answers only"); }
    return null;
  }
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
    if (data?.error) {
      console.log(`🧠 BetoBot AI error: ${data.error.type || ""} ${data.error.message || ""}`.trim());
      return null;
    }
    const out = (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    if (!out) console.log(`🧠 BetoBot AI returned nothing (status ${res.status})`);
    return out || null;
  } catch (e) {
    console.log(`🧠 BetoBot AI call failed: ${e.message}`);
    return null;
  }
}

/** Answer a question. Returns { answer, source }. */
export async function answer(text, history = []) {
  const s = await snapshot(history);
  for (const q of QUESTIONS) {
    if (q.re.test(text)) return { answer: q.fn(s, history, text), source: "data" };
  }
  const ai = await askClaude(text, s);
  if (ai) return { answer: ai, source: "model" };
  const aiOff = !process.env.ANTHROPIC_API_KEY;
  return {
    answer: `I don't have a built-in answer for that one${aiOff ? " and no AI key is set, so I can only handle the questions I know" : " and the AI fallback didn't respond — check the logs"}.\n\nI can answer: which sports are profitable, why bets aren't happening, your win rate, longest streak, what edge to use, profit projections, and current settings. Or tell me a change like "bet size 5".`,
    source: "none",
  };
}
