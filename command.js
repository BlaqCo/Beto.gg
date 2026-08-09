/**
 * command.js — plain-English control for BETO.GG
 *
 * Turns "change flat bets to $5 and slots to 5" into a config patch.
 *
 * Deterministic first: a rules table covers the phrasings actually used to
 * run this bot. Nothing is sent anywhere and no API key is required.
 * If the text doesn't match any rule AND ANTHROPIC_API_KEY is set, it falls
 * back to Claude to map the sentence onto the same schema — the model can
 * only ever return keys that already exist, and every value is clamped by
 * config.js before it is applied.
 */

import { SCHEMA } from "./config.js";

// price-ish values may be written as 65, 65%, 65¢, or 0.65 — normalize to 0-1
const toPrice = raw => {
  let n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 1.5) n = n / 100;
  return Math.round(n * 1000) / 1000;
};
const toNum = raw => { const n = parseFloat(raw); return Number.isFinite(n) ? n : null; };
const onOff = txt => /\b(on|enable[d]?|turn on|start|resume|yes|true)\b/i.test(txt) ? true
              : /\b(off|disable[d]?|turn off|stop|no|false)\b/i.test(txt) ? false : null;

/** Each rule: a matcher over the phrase, and what config keys it sets. */
const RULES = [
  // ── band written as a range: "edge 60-70", "band 60 to 70", "57%-68%"
  { re: /\b(?:edge|band|range|odds|entry|price)\D{0,12}?(\d{1,3}(?:\.\d+)?)\s*(?:%|¢|c)?\s*(?:-|–|to|thru|through)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%|¢|c)?/i,
    apply: m => ({ FAV_MIN: toPrice(m[1]), FAV_MAX: toPrice(m[2]) }) },

  // ── stake
  { re: /\b(?:flat\s*bets?|bet\s*size|bet\s*amount|stake|wager|bets?)\b[^0-9$]{0,18}\$?\s*(\d+(?:\.\d+)?)/i,
    apply: m => ({ BET_SIZE: toNum(m[1]) }) },
  { re: /\$\s*(\d+(?:\.\d+)?)\s*(?:flat\s*)?bets?\b/i, apply: m => ({ BET_SIZE: toNum(m[1]) }) },

  // ── slots
  { re: /\b(?:bet\s*)?(?:slots?|concurrent|positions?|max\s*open)\b[^0-9]{0,18}(\d{1,4})/i,
    apply: m => ({ MAX_CONC: toNum(m[1]), ENTRIES_SCAN: toNum(m[1]) }) },
  { re: /\b(\d{1,4})\s*(?:bet\s*)?slots?\b/i, apply: m => ({ MAX_CONC: toNum(m[1]), ENTRIES_SCAN: toNum(m[1]) }) },
  { re: /\b(?:no|unlimited|remove(?:\s+the)?)\s*(?:bet\s*)?slots?\b/i, apply: () => ({ MAX_CONC: 9999, ENTRIES_SCAN: 9999 }) },

  // ── single-sided band edits
  { re: /\b(?:floor|min(?:imum)?|lowest|bottom)\b[^0-9]{0,18}(\d{1,3}(?:\.\d+)?)/i, apply: m => ({ FAV_MIN: toPrice(m[1]) }) },
  { re: /\b(?:cap|max(?:imum)?|highest|top|ceiling)\b[^0-9]{0,18}(\d{1,3}(?:\.\d+)?)/i, apply: m => ({ FAV_MAX: toPrice(m[1]) }) },

  // ── timing
  { re: /\b(?:wait|trail|delay)\b[^0-9]{0,20}(\d{1,3})\s*(?:min|minutes?)?/i, apply: m => ({ MIN_LIVE_MIN: toNum(m[1]) }) },
  { re: /\b(?:no|remove|get rid of)\s*(?:the\s*)?(?:wait|trail|delay)\b/i, apply: () => ({ MIN_LIVE_MIN: 0 }) },

  // ── take profit
  { re: /\b(?:take\s*profit|tp|sell)\b[^0-9]{0,20}(\d{1,3}(?:\.\d+)?)\s*(?:%|¢|c)?/i, apply: m => ({ TP_PRICE: toPrice(m[1]), TP_ENABLED: true }) },
  { re: /\b(?:take\s*profit|tp)\b.*\b(off|on|enable|disable)\b/i, apply: m => ({ TP_ENABLED: onOff(m[0]) }) },

  // ── DCA
  { re: /\b(?:dca|second\s*buy|dip\s*buy|average\s*down)\b[^0-9]{0,24}(\d{1,3}(?:\.\d+)?)\s*%/i, apply: m => ({ DCA_DROP_PCT: toPrice(m[1]), DCA_ENABLED: true }) },
  { re: /\b(?:dca|second\s*buy|dip\s*buy)\b.*\b(off|on|enable|disable)\b/i, apply: m => ({ DCA_ENABLED: onOff(m[0]) }) },

  // ── safety
  { re: /\b(?:circuit\s*breaker|kill\s*switch|stop\s*(?:below|at))\b[^0-9]{0,20}\$?\s*(\d{1,6})/i,
    apply: m => ({ KILL_FLOOR: toNum(m[1]), KILL_ENABLED: true }) },
  { re: /\b(?:circuit\s*breaker|kill\s*switch)\b.*\b(off|on|enable|disable)\b/i, apply: m => ({ KILL_ENABLED: onOff(m[0]) }) },
  { re: /\b(?:pause|halt|stop\s*betting|stop\s*the\s*bot)\b/i, apply: () => ({ PAUSED: true }) },
  { re: /\b(?:resume|unpause|start\s*betting|go\s*again)\b/i, apply: () => ({ PAUSED: false }) },

  // ── maker
  { re: /\bmaker\b.*\b(off|on|enable|disable)\b/i, apply: m => ({ MAKER_MODE: onOff(m[0]) }) },
];

/** Split on connectors so multiple instructions in one sentence each get a shot. */
function segments(text) {
  return text.split(/(?:,|;|\band\b|\balso\b|\bthen\b|\n)/i).map(s => s.trim()).filter(Boolean);
}

export function parseCommand(text) {
  const patch = {};
  const matched = [];
  const parts = segments(text);
  // Try whole text first (catches ranges that span a connector), then each part.
  for (const chunk of [text, ...parts]) {
    for (const rule of RULES) {
      const m = chunk.match(rule.re);
      if (!m) continue;
      const out = rule.apply(m) || {};
      for (const [k, v] of Object.entries(out)) {
        if (v == null || !SCHEMA[k]) continue;
        if (patch[k] !== undefined) continue;      // first match wins
        patch[k] = v;
        matched.push(k);
      }
    }
  }
  return { patch, matched };
}

/** Optional model fallback — only used when the rules find nothing. */
async function askClaude(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const keys = Object.entries(SCHEMA)
    .map(([k, s]) => `${k} (${s.label}${s.pct ? ", 0-1 decimal" : s.bool ? ", true/false" : ""})`).join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 400,
        system: `Map the user's instruction onto these trading-bot settings. Reply with ONLY a JSON object of the keys to change — no prose, no markdown. Use only these keys:\n${keys}\nPrices and percentages are decimals (65% → 0.65). If nothing maps, reply {}.`,
        messages: [{ role: "user", content: text }],
      }),
    });
    const data = await res.json();
    const raw = (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("").replace(/```json|```/g, "").trim();
    const obj = JSON.parse(raw);
    const patch = {};
    for (const [k, v] of Object.entries(obj)) if (SCHEMA[k]) patch[k] = v;
    return Object.keys(patch).length ? patch : null;
  } catch { return null; }
}

/** Human-readable confirmation of what changed. */
export function describe(patch) {
  return Object.entries(patch).map(([k, v]) => {
    const s = SCHEMA[k] || {};
    if (s.bool) return `${s.label || k} ${v ? "on" : "off"}`;
    if (s.pct)  return `${s.label || k} ${Math.round(v * 100)}${s.unit || "¢"}`;
    return `${s.label || k} ${s.unit === "$" ? "$" : ""}${v}${s.unit && s.unit !== "$" ? s.unit : ""}`;
  }).join(" · ");
}

/** Parse with model fallback. Returns { patch, matched, source }. */
export async function interpret(text) {
  const local = parseCommand(text || "");
  if (Object.keys(local.patch).length) return { ...local, source: "rules" };
  const ai = await askClaude(text || "");
  if (ai) return { patch: ai, matched: Object.keys(ai), source: "model" };
  return { patch: {}, matched: [], source: "none" };
}
