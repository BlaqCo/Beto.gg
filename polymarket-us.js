/**
 * polymarket-us.js — polymarket.us integration (no SDK; raw signed REST)
 *
 * OFFICIAL API REFERENCE: https://docs.polymarket.us/api-reference/market/overview
 *
 * KEY FACTS FROM DOCS:
 * - GET /v1/markets?categories=sports&sportsMarketTypes=SPORTS_MARKET_TYPE_MONEYLINE
 * - Price in BBO: bestBid/bestAsk are Amount objects: { value: "0.55", currency: "USD" }
 * - Price in market list: bestBid/bestAsk are plain numbers
 * - outcomePrices: JSON string "[\"0.62\",\"0.38\"]", index 0 = Yes
 * - outcomes: JSON string "[\"Yes\",\"No\"]"
 * - sportsMarketTypeV2 field: "MONEYLINE", "SPREAD", "TOTAL", "PROP"
 * - gameStartTime field for game start
 * - marketSides[].price = string price for that side, marketSides[].long = true for YES side
 */

import axios from "axios";
import crypto from "crypto";

// ── VERSION BANNER: confirms which build is live ──
console.log("🔖 polymarket-us.js v11-STRATEGY loaded — true-live priority, tight spreads");

const GATEWAY = "https://gateway.polymarket.us";
const API     = "https://api.polymarket.us";

// ── Credential handling ─────────────────────────────────────────
const looksUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const looksB64  = s => /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length >= 40;
const clean = s => (s || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");

let _creds = null;
function getCreds() {
  if (_creds) return _creds;
  let keyId  = clean(process.env.POLYMARKET_API_KEY);
  let secret = clean(process.env.POLYMARKET_PRIVATE_KEY);
  if (!keyId || !secret || keyId.startsWith("your_")) {
    throw new Error("Set POLYMARKET_API_KEY and POLYMARKET_PRIVATE_KEY");
  }
  if (looksB64(keyId) && looksUuid(secret)) {
    console.log("⚠️ Credentials swapped — auto-correcting");
    [keyId, secret] = [secret, keyId];
  }
  console.log(`🔑 Key ID: ${keyId.length} chars ${looksUuid(keyId) ? "(uuid ✓)" : "(⚠️ not uuid)"} | Secret: ${secret.length} chars ${looksB64(secret) ? "(base64 ✓)" : "(⚠️ not base64)"}`);
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 32 && raw.length !== 64) throw new Error(`Secret decodes to ${raw.length} bytes; expected 32 or 64`);
  const seed = raw.subarray(0, 32);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  _creds = { keyId, privateKey };
  return _creds;
}

function authHeaders(method, path) {
  const { keyId, privateKey } = getCreds();
  const timestamp = Date.now().toString();
  // Sign only the path WITHOUT query string — Polymarket US signs base path only
  const basePath = path.split("?")[0];
  const message = `${timestamp}${method}${basePath}`;
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString("base64");
  return {
    "X-PM-Access-Key": keyId,
    "X-PM-Timestamp": timestamp,
    "X-PM-Signature": signature,
    "Content-Type": "application/json",
  };
}

async function signedRequest(method, path, body) {
  const headers = authHeaders(method, path);
  const res = await axios({
    method, url: API + path, headers,
    data: body ?? undefined, timeout: 15_000,
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  if (res.status === 429) {
    // Rate limited — wait and retry once
    const retryAfter = parseInt(res.headers?.["retry-after"] || "5") * 1000;
    await new Promise(r => setTimeout(r, Math.max(retryAfter, 5000)));
    const res2 = await axios({
      method, url: API + path, headers: authHeaders(method, path),
      data: body ?? undefined, timeout: 15_000,
      validateStatus: () => true,
    });
    if (res2.status >= 200 && res2.status < 300) return res2.data;
    throw new Error(`429 rate limited (retry also failed)`);
  }
  const msg = res.data?.message || res.data?.error || JSON.stringify(res.data)?.slice(0, 140) || `HTTP ${res.status}`;
  throw new Error(`${res.status}: ${msg}`);
}

// ── Helpers ──────────────────────────────────────────────────────
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const parseArr = v => { try { return typeof v === "string" ? JSON.parse(v) : (Array.isArray(v) ? v : []); } catch { return []; } };

// Amount object from BBO/book: { value: "0.55", currency: "USD" } OR plain number
const amountVal = x => {
  if (x == null) return null;
  if (typeof x === "object") return num(x.value ?? x.amount);
  return num(x);
};

// ── Price extraction (handles ALL field formats from docs) ────────
function extractYesPrice(m) {
  // 1) marketSides — most accurate: find the "long" side (YES)
  const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
  if (sides.length > 0) {
    const longSide = sides.find(s => s.long === true);
    const p = num(longSide?.price);
    if (p) return p;
  }

  // 2) bestAsk from market list (plain number per docs)
  const ask = num(m.bestAsk);
  if (ask) return ask;

  // 3) outcomePrices JSON string: "[\"0.62\",\"0.38\"]"
  //    outcomes JSON string: "[\"Yes\",\"No\"]" — index 0 is YES
  const prices   = parseArr(m.outcomePrices).map(Number).filter(n => n > 0 && n < 1);
  const outcomes = parseArr(m.outcomes);
  if (prices.length >= 2) {
    const yi = outcomes.findIndex(o => /yes/i.test(String(o)));
    const idx = yi >= 0 ? yi : prices.indexOf(Math.max(...prices));
    return prices[idx] ?? Math.max(...prices);
  }
  if (prices.length === 1) return prices[0];

  // 4) lastTradePrice or bestBid as final fallback
  return num(m.lastTradePrice) ?? num(m.bestBid) ?? null;
}

// ── League detection ─────────────────────────────────────────────
function detectLeague(m) {
  const q   = (m.question || m.title || "").toLowerCase();
  const cat = (m.category || "").toLowerCase();
  const sub = (m.subcategory || "").toLowerCase();

  // Use subcategory first (most specific — e.g. "MLB", "WNBA", "ATP")
  if (sub) {
    const s = sub.toUpperCase();
    if (s.includes("MLB") || s.includes("BASEBALL")) return "MLB";
    if (s.includes("NBA"))  return "NBA";
    if (s.includes("WNBA")) return "WNBA";
    if (s.includes("NFL"))  return "NFL";
    if (s.includes("NHL"))  return "NHL";
    if (s.includes("ATP") || s.includes("WTA") || s.includes("ITF") || s.includes("TENNIS")) return "TENNIS";
    if (s.includes("CS2") || s.includes("VALORANT") || s.includes("LOL") || s.includes("ESPORT")) return "ESPORTS";
    if (s.includes("MLS") || s.includes("WORLD CUP") || s.includes("SOCCER") || s.includes("UCL")) return "SOCCER";
    if (sub.length <= 12) return sub.toUpperCase(); // use as-is for short subcategories
  }

  // Question text matching
  if (/\bmlb\b|baseball|\b(phillies|dodgers|giants|astros|yankees|mets|cubs|red sox|athletics|tigers|nationals|braves|cardinals|padres|brewers|mariners|pirates|reds|rockies|orioles|rays|guardians|twins|royals|rangers|angels|diamondbacks)\b/i.test(q)) return "MLB";
  if (/\bwnba\b|\b(mystics|sky|aces|liberty|fever|dream|sparks|storm|sun|lynx|wings|mercury|valkyries|firebirds)\b/i.test(q)) return "WNBA";
  if (/\bnba\b|\b(celtics|lakers|warriors|bulls|heat|nuggets|bucks|suns|76ers|nets|knicks|raptors|mavericks|clippers|spurs|rockets|jazz|magic|pistons|hornets|hawks|pacers|grizzlies|kings|pelicans|blazers|thunder|timberwolves|cavaliers)\b/i.test(q)) return "NBA";
  if (/\bnfl\b|\b(patriots|chiefs|cowboys|packers|steelers|bears|eagles|49ers|seahawks|ravens|bills|bengals|browns|colts|texans|jaguars|titans|broncos|raiders|chargers|dolphins|jets|falcons|saints|buccaneers|panthers|lions|vikings|rams)\b/i.test(q)) return "NFL";
  if (/\btennis\b|wimbledon|\batp\b|\bwta\b|\bitf\b|french open|us open|australian open|(djokovic|alcaraz|sinner|swiatek|sabalenka|nadal|federer)/i.test(q)) return "TENNIS";
  if (/esport|cs2|cs:go|\bdota\b|\blol\b|league of legends|valorant|overwatch|rocket league|starcraft/i.test(q)) return "ESPORTS";
  if (/world cup|soccer|mls|premier league|la liga|bundesliga|serie a|champions league|ucl/i.test(q)) return "SOCCER";
  if (/\bnhl\b|hockey|\b(bruins|rangers|maple leafs|canadiens|penguins|blackhawks|red wings|flyers|capitals|kings)\b/i.test(q)) return "NHL";

  return "SPORT";
}

// ── Game market filter ───────────────────────────────────────────
// DEAD SIMPLE: 
// - Only accept markets with sportsMarketTypeV2 = "SPORTS_MARKET_TYPE_MONEYLINE"
// - Reject sub-period props, season futures, player props
// - Polymarket.us returns active:true, closed:true on live tradeable markets
//   → DO NOT FILTER BY CLOSED FIELD
// - DO NOT use GAME_VS regex for rejection

function isGameMarket(m) {
  const q = (m.question || m.title || "").trim();
  
  // MUST be active and NOT resolved
  if (!q || m.active !== true || m.resolved === true) return false;

  // REJECT: sub-period props (first half, 1st inning, first quarter, etc)
  if (/first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter|1h\b|h1\b|halftime|period\d|quarter\d/i.test(q)) {
    return false;
  }

  // REJECT: season/futures (champion, pennant, world series, MVP, etc)
  if (/champion|pennant|world series|super bowl|stanley cup|nba finals|mvp|cy young|award|division|win the|make the playoffs|season win|season record|playoff|postseason/i.test(q)) {
    return false;
  }

  // REJECT: player props (hitting, scoring, passing, etc)
  if (/will (score|throw|catch|run|make|hit|pass|strikeout|homerun|touchdown|goal|assist|rebound|block|steal|point|basket|field goal|extra point)/i.test(q)) {
    return false;
  }

  // ════════════════════════════════════════════════════════════════
  // ACCEPT ALL ACTIVE MARKETS — find the 2 live ones
  // ════════════════════════════════════════════════════════════════
  return true;
}

// ── Main fetch ───────────────────────────────────────────────────
let _cache = null, _cacheTime = 0;
const TTL = 20_000;

export async function fetchSportsMoneylines() {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;

  // OFFICIAL PARAMS from docs:
  // categories=sports (plural, array-style)
  // sportsMarketTypes=SPORTS_MARKET_TYPE_MONEYLINE (enum filter)
  // gameStartTime via endDateMin/endDateMax
  // volumeNumMin to filter out dead markets
  const now = Date.now();

  // OFFICIAL API PARAMS (docs.polymarket.us): date filters are
  // startDateMin/startDateMax/endDateMin/endDateMax (ISO 8601).
  // endDateMin=now-12h excludes stale resolved games SERVER-SIDE.
  // sportsMarketTypes=SPORTS_MARKET_TYPE_MONEYLINE = moneylines only (NO PROPS).
  const endMin   = new Date(now - 12 * 3600_000).toISOString();
  const startMin = new Date(now - 24 * 3600_000).toISOString();
  const startMax = new Date(now + 48 * 3600_000).toISOString();
  const ML = "sportsMarketTypes=SPORTS_MARKET_TYPE_MONEYLINE";

  // ★★★ v10: OFFICIAL v2 SPORTS API (docs.polymarket.us/api-reference/sports) ★★★
  // GET /v2/leagues/{slug}/events and /v2/sports/{slug}/events — this is what
  // powers the app's league tabs (MLB, Esports, Golf, World Cup...).
  // type=sport (default) = actual games, NOT futures. Events contain their markets.
  // The old v1 tag sweeps are DEAD — the API now ignores tags= and returns the
  // same stale Nov-2025 dump for every tag (proven in logs).
  const LEAGUES = ["mlb","nba","nfl","nhl","wnba","epl","la-liga","serie-a",
                   "bundesliga","ligue-1","mls","ucl","world-cup","kbo","npb",
                   "atp","wta","itf","ufc","cs2","valorant","lol","dota-2"];
  const SPORTS  = ["baseball","basketball","football","hockey","soccer","tennis",
                   "mma","boxing","cricket","golf","esports","darts","table-tennis",
                   "motorsports","rugby","volleyball","handball"];

  const urls = [
    // ── PRIMARY: v2 sports/league event sweeps (what the app itself uses) ──
    ...SPORTS.map(s  => `${GATEWAY}/v2/sports/${s}/events?limit=50`),
    ...LEAGUES.map(l => `${GATEWAY}/v2/leagues/${l}/events?limit=50`),
    // ── Fallback: v1 date-filtered market queries (returned 5 real markets) ──
    `${GATEWAY}/v1/markets?active=true&archived=false&categories=sports&${ML}&endDateMin=${encodeURIComponent(endMin)}&limit=500`,
    `${GATEWAY}/v1/markets?active=true&archived=false&categories=sports&${ML}&startDateMin=${encodeURIComponent(startMin)}&startDateMax=${encodeURIComponent(startMax)}&limit=500`,
  ];

  const results = await Promise.allSettled(
    urls.map(url => axios.get(url, { timeout: 12_000 }))
  );

  const seenKeys = new Set();
  const marketSource = new Map(); // Track which endpoint returned each market
  let raw = [];
  let sportsCatCount = 0;
  let moneylineCount = 0;
  let shapeDumped = false;

  // Normalize any response shape (v2 events / v1 markets) into market objects
  const extractMarkets = (data) => {
    const events = data?.events || (Array.isArray(data) ? data : null);
    if (events && Array.isArray(events)) {
      const mkts = [];
      for (const ev of events) {
        const evMarkets = ev?.markets || ev?.market ? (ev.markets || [ev.market]) : [];
        for (const m of evMarkets) {
          // Inherit game timing/live info from the parent event when missing
          if (!m.gameStartTime) m.gameStartTime = ev.gameStartTime || ev.startTime || ev.startDate || null;
          if (!m.endDate)       m.endDate       = ev.endDate || ev.endTime || null;
          if (m.eventLive === undefined) m.eventLive = ev.live ?? ev.isLive ?? undefined;
          if (!m.question)      m.question      = m.title || ev.title || ev.name || null;
          mkts.push(m);
        }
        // Some responses may put markets fields directly on the event
        if (!evMarkets.length && (ev?.slug || ev?.id) && (ev?.outcomePrices || ev?.bestAsk || ev?.marketSides)) {
          mkts.push(ev);
        }
      }
      return mkts;
    }
    return data?.markets || [];
  };

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled") continue;
    const data = r.value?.data;
    const arr = extractMarkets(data);
    const label = (urls[i].match(/\/v2\/(?:sports|leagues)\/([^/]+)\//) || [])[1]
               || ((urls[i].match(/tags=([^&]*)/) || [])[1])
               || "v1-datefilter";
    if (arr.length) {
      const first = arr[0];
      console.log(`  🌐 ${decodeURIComponent(label)} → ${arr.length} | ${first?.question?.slice(0,30) || first?.slug || "-"} | start=${first?.gameStartTime || "-"}`);
      // 🔬 Dump ONE raw sample so the exact v2 shape is visible in logs
      if (!shapeDumped && urls[i].includes("/v2/")) {
        shapeDumped = true;
        console.log(`  🔬 V2 RAW SAMPLE: ${JSON.stringify(data).slice(0, 1200)}`);
      }
    }
    const urlUsed = urls[i] || "";
    const isLiveEndpoint = true; // v2 events endpoints serve current/live events
    
    for (const m of arr) {
      const key = m.slug || m.id;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      marketSource.set(key, { isLiveEndpoint });
      raw.push(m);
      if ((m.category || "").toLowerCase().includes("sports")) sportsCatCount++;
      if (m.sportsMarketTypeV2 === "SPORTS_MARKET_TYPE_MONEYLINE" || m.sportsMarketType === "SPORTS_MARKET_TYPE_MONEYLINE" || m.smt === "moneyline") moneylineCount++;
    }
  }

  if (!raw.length) { console.log("⚠️ [sports API] all endpoints empty"); return _cache || []; }
  console.log(`🔖 v11-STRATEGY | 📡 ${raw.length} markets from v2 sports/league events (pre-filter)`);

  // ── LOG ALL MARKETS to see what's actually available ──
  for (const m of raw.slice(0, 10)) {
    console.log(`  🎯 ${m.closed ? "❌ CLOSED" : "✅ OPEN"} | ${m.title || m.question} | closed=${m.closed} active=${m.active} resolved=${m.resolved}`);
  }

  // ── Build output ─────────────────────────────────────────
  const out = [];
  const rej = { noslug: 0, active: 0, resolved: 0, prop: 0, stale: 0, faroff: 0, nodates: 0 };

  for (const m of raw) {
    const slug = m.slug || m.id || m.marketId;
    if (!slug) { rej.noslug++; continue; }
    
    // Relaxed: only reject when explicitly inactive/resolved.
    // v2 event markets may omit these fields entirely.
    if (m.active === false) { rej.active++; continue; }
    if (m.resolved === true || m.closed === true && m.eventLive === false) { rej.resolved++; continue; }

    // ── NO PROPS: moneylines only ──
    const smt = (m.sportsMarketTypeV2 || m.sportsMarketType || "").toUpperCase();
    if (smt && smt !== "SPORTS_MARKET_TYPE_MONEYLINE" && smt !== "MONEYLINE") { rej.prop++; continue; }
    // Text-based prop rejection for markets missing the type field
    const qText = m.question || m.title || "";
    if (/first half|1st half|first 5|first inning|1st inning|first quarter|1st quarter|halftime|to score|will .* (score|throw|catch|hit|pass|strikeout|touchdown|goal|assist|rebound)|over\/under|\bspread\b|\btotal\b|player prop/i.test(qText)) { rej.prop++; continue; }

    const q = m.question || m.title || "";
    const est = extractYesPrice(m);

    // ── DATE GATE (v10) ──
    // Only gameStartTime is real game time. Markets whose parent event is
    // flagged live bypass the gate entirely.
    const gameStart = m.gameStartTime || null;
    let startMs = gameStart ? new Date(gameStart).getTime() : null;
    const endMs  = m.endDate ? new Date(m.endDate).getTime() : null;
    const source = marketSource.get(slug) || { isLiveEndpoint: false };
    const evLive = m.eventLive === true;

    if (!evLive) {
      if (startMs) {
        const hoursOut = (startMs - now) / 3_600_000;
        if (hoursOut < -8)  { rej.stale++;  continue; }  // started >8h ago → over
        if (hoursOut > 24)  { rej.faroff++; continue; }  // starts >24h away
      } else {
        if (endMs && endMs < now) { rej.stale++; continue; }  // already ended
        if (!endMs) { rej.nodates++; continue; }              // no dates → unverifiable
        // ends in the future & no gameStart → keep (live games; book-state check guards entry)
      }
    }

    const league    = detectLeague(m);
    // A market is LIVE if:
    // 1. It came from the LIVE endpoint (no closed=false filter), OR
    // 2. It has a gameStartTime in the past (started < now)
    // LIVE = the event is actually in progress: API live flag, or game
    // started within the last 8h. (v11 fix: previously EVERY v2 market was
    // flagged live, so live-first prioritization did nothing.)
    const isLive    = m.eventLive === true ||
                      (startMs && startMs <= now && (now - startMs) < 8 * 3_600_000);
    const hoursUntil = isLive ? 0 : (startMs ? Math.round((startMs - now) / 3_600_000 * 10) / 10 : null);

    // Compute ask/bid from available fields (est may be null)
    const displayPrice = est ?? 0.50; // default for sorting/display
    const ask = (est ?? amountVal(m.bestAsk) ?? 0.50) || 0.50;
    const bid = (amountVal(m.bestBid) ?? (est && est - 0.02 > 0 ? est - 0.02 : 0.48)) || 0.48;

    out.push({
      slug, question: q,
      subtitle: m.description?.slice(0, 80) || null,
      league,
      ask: Math.min(Math.max(ask, 0.01), 0.99), // ensure 0.01 - 0.99
      bid: Math.min(Math.max(bid, 0.01), 0.99),
      est: est || displayPrice,
      tick:   num(m.orderPriceMinTickSize) || 0.01,
      minQty: num(m.minimumTradeQty) || 1,
      gameStartIso: gameStart,
      endIso:  m.endDate || null,
      category: m.category || "",
      subcategory: m.subcategory || "",
      isLive,
      hoursUntil,
      volume24h: num(m.volume24hr) || 0,
      sportsType: m.sportsMarketTypeV2 || m.sportsMarketType || "",
    });
  }

  // Sort: live first → soonest → highest volume → highest price
  out.sort((a, b) => {
    if (b.isLive !== a.isLive) return b.isLive ? 1 : -1;
    const aS = a.gameStartIso ? new Date(a.gameStartIso).getTime() : now + 999_999_999;
    const bS = b.gameStartIso ? new Date(b.gameStartIso).getTime() : now + 999_999_999;
    if (aS !== bS) return aS - bS;
    if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
    return (b.est || 0) - (a.est || 0);
  });

  const liveCount = out.filter(x => x.isLive).length;
  console.log(`📊 [sports API] ${raw.length} total → ${out.length} game moneylines (${liveCount} 🔴 live, ${out.length - liveCount} ⏳ upcoming)`);
  console.log(`  ⛔ rejected: inactive=${rej.active} resolved=${rej.resolved} prop=${rej.prop} stale=${rej.stale} faroff=${rej.faroff} nodates=${rej.nodates}`);
  for (const s of out.slice(0, 8)) {
    console.log(`  ✅ SURVIVOR: ${s.slug} | ${s.question?.slice(0,35) || "-"} | gameStart=${s.gameStartTime || "-"} end=${s.endDate || "-"}`);
  }
  if (out.length > 0) {
    console.log("  Top markets: " + out.slice(0, 8).map(m =>
      `${m.isLive ? "🔴" : "⏳"} ${m.league} ${(m.est * 100).toFixed(0)}¢ ${m.question.slice(0, 40)}`
    ).join(" | "));
  }
  // Log how many per league for debugging
  const byLeague = {};
  out.forEach(m => { byLeague[m.league] = (byLeague[m.league] || 0) + 1; });
  console.log("  By league: " + Object.entries(byLeague).map(([l,n]) => `${l}:${n}`).join(" "));

  _cache = out;
  _cacheTime = Date.now();
  return out;
}

// ── verifyCandidates ─────────────────────────────────────────────
export async function verifyCandidates(cands, { maxSpread = 0.06 } = {}) {
  const checks = await Promise.all(cands.map(async c => {
    const bbo = await getBBO(c.slug);
    if (!bbo?.bid || !bbo?.ask) return null;
    if (bbo.ask - bbo.bid > maxSpread) return null;
    return { ...c, ask: bbo.ask, bid: bbo.bid };
  }));
  return checks.filter(Boolean);
}

// ── getBBO ───────────────────────────────────────────────────────
// BBO response: { marketData: { bestBid: { value: "0.54", currency: "USD" }, bestAsk: { value: "0.56" }, lastTradePx: {...}, currentPx: {...} } }
export async function getBBO(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/bbo`, { timeout: 8_000 });
    const d = data?.marketData || data || {};
    const result = {
      bid:  amountVal(d.bestBid),
      ask:  amountVal(d.bestAsk),
      last: amountVal(d.lastTradePx) ?? amountVal(d.currentPx),
    };
    // DEBUG: log if BBO is suspiciously high
    if (result.ask >= 0.95) {
      console.log(`⚠️ [getBBO] HIGH ASK=${result.ask} | slug=${slug} | raw=${JSON.stringify({bid: d.bestBid, ask: d.bestAsk})}`);
    }
    return result;
  } catch (err) {
    console.log(`❌ [getBBO] ERROR: ${err.message} | slug=${slug}`);
    return null;
  }
}

// ── getBookState ─────────────────────────────────────────────────
// GROUND TRUTH tradeability check (official docs): the /book endpoint
// returns state = MARKET_STATE_OPEN only if the market is trading NOW.
// Stale/resolved markets return EXPIRED / TERMINATED / HALTED.
let _bookShapeLogged = false;
export async function getBookState(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`, { timeout: 8_000 });
    if (!_bookShapeLogged) {
      _bookShapeLogged = true;
      console.log(`  🔬 BOOK RAW SAMPLE (${slug}): ${JSON.stringify(data).slice(0, 500)}`);
    }
    const d = data?.marketData || data || {};
    const state = d.state || d.status || d.marketState || "UNKNOWN";
    return {
      state,
      isOpen: /OPEN/i.test(String(state)),
      bestBid: amountVal(d.bids?.[0]?.px) ?? amountVal(d.bestBid),
      bestAsk: amountVal(d.offers?.[0]?.px) ?? amountVal(d.asks?.[0]?.px) ?? amountVal(d.bestAsk),
      bidQty:  Number(d.bids?.[0]?.qty || 0),
      askQty:  Number(d.offers?.[0]?.qty || d.asks?.[0]?.qty || 0),
    };
  } catch (err) {
    // Network/404 → state UNKNOWN (fail-open); NOT a dead-market signal
    return { state: "UNKNOWN", isOpen: false, bestBid: null, bestAsk: null, bidQty: 0, askQty: 0 };
  }
}

// ── getSettlement ────────────────────────────────────────────────
export async function getSettlement(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/settlement`, { timeout: 8_000 });
    const v = Number(data?.settlement);
    if (!Number.isFinite(v)) return null;
    if (v >= 0.99) return 1;
    if (v <= 0.01) return 0;
    return null;
  } catch { return null; }
}

// ── getBuyingPower ───────────────────────────────────────────────
const money = x => {
  if (x == null) return null;
  if (typeof x === "object") return money(x.value ?? x.amount ?? x.units);
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

let _balShapeLogged = false;
export async function getBuyingPower() {
  const b = await signedRequest("GET", "/v1/account/balances");
  let root = b?.balances ?? b ?? {};
  if (Array.isArray(root)) root = root[0] || {};
  const buyingPower    = money(root.buyingPower) ?? money(root.buying_power) ?? null;
  const currentBalance = money(root.currentBalance) ?? money(root.current_balance) ?? money(root.cashBalance) ?? null;
  if ((buyingPower == null || buyingPower === 0) && !_balShapeLogged) {
    _balShapeLogged = true;
    console.log("🔍 balances raw shape:", JSON.stringify(b).slice(0, 300));
  }
  return { buyingPower: buyingPower ?? 0, currentBalance: currentBalance ?? buyingPower ?? 0 };
}

// ── buyYesFOK ────────────────────────────────────────────────────
export async function buyYesFOK({ slug, sizeUsd, ask, tick = 0.01 }) {
  const limit = Math.min(0.99, Math.round((ask + tick) / tick) * tick);
  let qty     = Math.floor(sizeUsd / limit);
  // HARD CAP: whole contracts, total cost can NEVER exceed sizeUsd
  while (qty > 0 && qty * limit > sizeUsd + 1e-9) qty--;
  if (qty < 1) return { filled: false, error: `size $${sizeUsd} < 1 contract @ ${limit.toFixed(2)}` };
  try {
    const order = await signedRequest("POST", "/v1/orders", {
      marketSlug: slug,
      intent:     "ORDER_INTENT_BUY_LONG",
      type:       "ORDER_TYPE_LIMIT",
      price:      { value: limit.toFixed(2), currency: "USD" },
      quantity:   qty,
      tif:        "TIME_IN_FORCE_FILL_OR_KILL",
    });
    let state = order?.state, id = order?.id;
    if (state === "ORDER_STATE_PENDING_NEW" && id) {
      await new Promise(r => setTimeout(r, 1200));
      try { state = (await signedRequest("GET", `/v1/order/${id}`))?.state; } catch {}
    }
    if (state === "ORDER_STATE_FILLED") {
      return { filled: true, qty, fillPrice: limit, cost: +(qty * limit).toFixed(2), orderId: id };
    }
    return { filled: false, error: `order ${state || "unknown"}`, orderId: id };
  } catch (err) {
    return { filled: false, error: err.message };
  }
}

// ── closePositionLive ─────────────────────────────────────────────
export async function closePositionLive(slug) {
  try {
    await signedRequest("POST", "/v1/order/close-position", { marketSlug: slug });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── getOpenPositions ─────────────────────────────────────────────
export async function getOpenPositions() {
  try {
    const data = await signedRequest("GET", "/v1/portfolio/positions");
    const positions = data?.positions || {};
    const out = {};
    for (const [slug, p] of Object.entries(positions)) {
      // Same field fallbacks as getOpenPositionsEnriched (proven against live API):
      const qty = parseFloat(p?.qtyBoughtDecimal ?? p?.netPositionDecimal ?? p?.qtyBought ?? p?.netPosition ?? 0);
      out[slug] = { qtyBought: qty, netPosition: qty };
    }
    return out;
  } catch (err) {
    console.error("⚠️ getOpenPositions failed:", err.message);
    return null;
  }
}

// ── getTradeHistory ──────────────────────────────────────────────
// Fetches activities from /v1/portfolio/activities (correct endpoint per docs).
// Filters to TRADE + POSITION_RESOLUTION types.
// Activity shape:
//   { type, trade: { marketSlug, price:{value,currency}, qtyDecimal, costBasis:{value}, realizedPnl:{value}, createTime, state }, positionResolution: { ... } }
export async function getTradeHistory({ limit = 500 } = {}) {
  try {
    const amtVal = x => x?.value != null ? parseFloat(x.value) : null;
    const allActivities = [];
    let cursor = null;
    let page = 0;

    while (page < 10) {
      const params = new URLSearchParams({ limit: "200", sortOrder: "SORT_ORDER_DESCENDING" });
      if (cursor) params.set("cursor", cursor);
      const data = await signedRequest("GET", `/v1/portfolio/activities?${params}`);

      // Log raw shape on first page so we can see real field names
      if (page === 0) {
        const sample = (data?.activities || [])[0];
        if (sample) {
          console.log(`📋 Activity sample: ${JSON.stringify(sample).slice(0, 500)}`);
          console.log(`📋 Activity types found: ${[...new Set((data.activities||[]).map(a=>a.type))].join(", ")}`);
        } else {
          console.log(`📋 No activities returned. Response keys: ${JSON.stringify(Object.keys(data||{}))}`);
        }
      }

      const acts = data?.activities || [];
      allActivities.push(...acts);
      if (!data?.nextCursor || acts.length === 0 || data?.eof) break;
      cursor = data.nextCursor;
      page++;
      if (allActivities.length >= limit) break;
    }

    console.log(`📋 Total activities: ${allActivities.length}`);

    return allActivities.map(a => {
      // ACTIVITY_TYPE_TRADE — a buy or sell fill
      if (a.type === "ACTIVITY_TYPE_TRADE" && a.trade) {
        const t = a.trade;
        const pl   = amtVal(t.realizedPnl) ?? 0;
        const cost = amtVal(t.costBasis) ?? amtVal(t.cost) ?? 0;

        // Price from aggressorExecution (fill price) or makerExecution
        // aggressorExecution: { price: {value, currency}, quantity, ... }
        const aggEx  = t.aggressorExecution || t.aggressor_execution || {};
        const mkEx   = t.makerExecution     || t.maker_execution     || {};
        const exPrice = amtVal(aggEx.lastPx) ?? amtVal(aggEx.price) ?? amtVal(mkEx.lastPx) ?? amtVal(mkEx.price) ?? amtVal(t.price) ?? null;

        // Quantity from execution
        const exQty = parseFloat(aggEx.quantity ?? aggEx.qty ?? mkEx.quantity ?? t.qtyDecimal ?? t.qty ?? 0);

        // Side: aggressorExecution side or trade-level side
        const rawSide = (aggEx.side || t.side || "").toUpperCase();
        const side = rawSide || (cost > 0 && pl <= 0 ? "BUY" : "SELL");

        // For a BUY: entryPrice = exPrice (the price you paid per contract)
        // This is the reliable source — not cost/qty
        const entryPrice = exPrice;

        const slug = t.marketSlug || a.marketSlug || "";
        const q    = t.marketTitle || t.question || t.marketSlug || "";
        // Log first few trades to see full field structure
        if (!getTradeHistory._logged || getTradeHistory._logged < 3) {
          getTradeHistory._logged = (getTradeHistory._logged || 0) + 1;
          console.log(`📋 Trade[${getTradeHistory._logged}]: ${slug.slice(0,30)} side=${side} price=${entryPrice} qty=${exQty} cost=${cost}`);
          console.log(`📋   aggEx fields: ${JSON.stringify(Object.keys(aggEx))}`);
          console.log(`📋   aggEx.price: ${JSON.stringify(aggEx.price)}`);
        }
        return {
          _type:       "trade",
          marketSlug:  slug,
          question:    q,
          price:       entryPrice,   // real fill price (0-1)
          qty:         exQty,
          costBasis:   cost,
          realizedPnl: pl,
          side,
          createTime:  t.createTime || a.createTime || "",
          state:       t.state || "",
        };
      }

      // ACTIVITY_TYPE_POSITION_RESOLUTION — market settled WIN or LOSS
      if (a.type === "ACTIVITY_TYPE_POSITION_RESOLUTION" && a.positionResolution) {
        const r = a.positionResolution;
        const beforeReal = amtVal(r.beforePosition?.realized) ?? 0;
        const afterReal  = amtVal(r.afterPosition?.realized)  ?? 0;
        // Incremental P/L from this resolution
        const pl = afterReal - beforeReal;
        // Also try direct pnl fields
        const directPl = amtVal(r.pnl) ?? amtVal(r.realizedPnl) ?? null;
        const finalPl  = directPl !== null ? directPl : pl;
        const won = finalPl > 0
          || r.side === "POSITION_RESOLUTION_SIDE_LONG"
          || r.outcome === "YES" || r.outcome === "WON";
        const question = r.afterPosition?.marketMetadata?.title
          || r.beforePosition?.marketMetadata?.title
          || r.marketTitle || r.marketSlug || "";
        console.log(`📋 RESOLUTION: ${question.slice(0,40)} pl=$${finalPl.toFixed(2)} won=${won}`);
        return {
          _type:       "resolution",
          marketSlug:  r.marketSlug || a.marketSlug || "",
          question,
          realizedPnl: finalPl,
          createTime:  r.updateTime || r.createTime || a.createTime || "",
          won,
        };
      }
      return null;
    }).filter(Boolean);

  } catch (err) {
    console.error("⚠️ getTradeHistory failed:", err.message);
    return [];
  }
}


export async function getOpenPositionsEnriched(stateBets = [], entryPriceCache = {}) {
  try {
    const amtVal = x => x?.value != null ? parseFloat(x.value) : null;
    const data = await signedRequest("GET", "/v1/portfolio/positions");
    const raw = data?.positions || {};

    // Log full raw shape so we know exact field names
    const slugs = Object.keys(raw);
    if (slugs.length > 0) {
      console.log(`🔍 Position keys (slugs): ${slugs.slice(0,5).join(" | ")}`);
      console.log(`🔍 Position sample fields: ${JSON.stringify(Object.keys(raw[slugs[0]]||{}))}`);
      console.log(`🔍 Position sample values: ${JSON.stringify(raw[slugs[0]]).slice(0,400)}`);
      console.log(`🔍 State bet IDs: ${stateBets.slice(0,5).map(b=>b.marketConditionId).join(" | ")}`);
    }

    const out = [];
    for (const [slug, p] of Object.entries(raw)) {
      const qty = parseFloat(p?.qtyBoughtDecimal ?? p?.netPositionDecimal ?? p?.qtyBought ?? 0);
      if (qty <= 0) continue;

      // Dollar amounts from API
      const costBasis = amtVal(p?.cost);
      const cashValue = amtVal(p?.cashValue);
      const realized  = amtVal(p?.realized);

      // avgPx: the actual average fill price from the API — most reliable source
      const apiAvgPx = p?.avgPx != null ? parseFloat(p.avgPx) : null;

      // Market metadata
      const meta = p?.marketMetadata || p?.market_metadata || {};
      let question = meta.title || meta.question || meta.name ||
                     p?.title || p?.question || null;
      let category = meta.category || p?.category || "";
      let entryPrice = null;
      let placedAt = null;

      // avgPx from API is ground truth for entry price when available
      if (!entryPrice && apiAvgPx && apiAvgPx > 0.05 && apiAvgPx < 0.99) {
        entryPrice = +apiAvgPx.toFixed(4);
      }

      // Cross-ref state bets — try multiple matching strategies
      const stateBet = stateBets.find(b => {
        const id = (b.marketConditionId || "").toLowerCase();
        const s  = slug.toLowerCase();
        return id === s
          || id === s + "-yes"
          || s === id + "-yes"
          || s.startsWith(id.replace(/-yes$/,""))
          || id.startsWith(s.replace(/-yes$/,""))
          || (id.length > 8 && s.includes(id.slice(0,15)))
          || (s.length > 8 && id.includes(s.slice(0,15)));
      });

      if (stateBet) {
        if (!question)    question   = (stateBet.marketQuestion||"").replace(/^\[.*?\]\s*/,"") || null;
        if (!category)    category   = stateBet.entryCoin || "";
        if (!entryPrice)  entryPrice = stateBet.entryPrice || null;
        if (!placedAt)    placedAt   = stateBet.placedAt || null;
        console.log(`  ✅ Matched: ${slug.slice(0,30)} → entry=${entryPrice}`);
      } else {
        // No state match (state reset on restart)
        // DO NOT derive entryPrice from cost/qty — qty scale is unreliable
        // Try bodPosition fields from the API instead
        const bod = p?.bodPosition || {};
        const bodCost = amtVal(bod?.cost);
        const bodQty  = parseFloat(bod?.qtyBought ?? 0);
        if (!entryPrice && bodCost && bodQty > 0) {
          const derived = +(bodCost / bodQty).toFixed(4);
          // Only use if it's a sane probability (5% - 98%)
          if (derived >= 0.05 && derived <= 0.98) {
            entryPrice = derived;
            console.log(`  📊 bodDerived: ${slug.slice(0,30)} → entry=${entryPrice}`);
          }
        }
        // Try entryPriceCache from recent trade activities
        if (!entryPrice && entryPriceCache[slug]) {
          entryPrice = entryPriceCache[slug];
          console.log(`  📊 CacheDerived: ${slug.slice(0,30)} → entry=${entryPrice}`);
        }
        if (!entryPrice) {
          console.log(`  ❌ No entry price: ${slug.slice(0,40)} cost=${costBasis} qty=${qty}`);
        }
      }

      // Payout = costBasis / entryPrice = contracts × $1 per contract
      const payout = (costBasis && entryPrice && entryPrice > 0)
        ? +(costBasis / entryPrice).toFixed(2) : null;

      // Live BBO
      let currentBid = null;
      try {
        const bbo = await getBBO(slug);
        currentBid = bbo?.bid ?? null;
      } catch {}

      // P/L = (currentBid - entryPrice) * payout
      let openPnl = null;
      if (currentBid != null && entryPrice && payout) {
        openPnl = +((currentBid - entryPrice) * payout).toFixed(2);
      } else if (cashValue != null && costBasis != null) {
        openPnl = +(cashValue - costBasis).toFixed(2);
      }

      const currentVal = (currentBid && payout)
        ? +(currentBid * payout).toFixed(2) : cashValue;

      out.push({
        slug,
        question:   question || slug,
        category,
        qty,
        avgPrice:   entryPrice,
        costBasis,
        cashValue,
        currentBid,
        currentVal,
        openPnl,
        payout,
        realized,
        updateTime: p?.updateTime,
        placedAt,
      });
    }
    return out;
  } catch (err) {
    console.error("⚠️ getOpenPositionsEnriched failed:", err.message);
    return [];
  }
}


export async function preflightUS() {
  const msgs = [];
  let keyId;
  try { keyId = getCreds().keyId; msgs.push("✅ API credentials parsed (Ed25519 key loaded)"); }
  catch (e) { msgs.push("❌ " + e.message); return { ok: false, messages: msgs }; }
  try {
    const { buyingPower, currentBalance } = await getBuyingPower();
    msgs.push(`✅ Auth works | balance $${currentBalance.toFixed(2)} | buying power $${buyingPower.toFixed(2)}`);
    if (buyingPower <= 0) {
      msgs.push("❌ Buying power is $0 — deposit funds in the Polymarket app");
      return { ok: false, messages: msgs };
    }
  } catch (e) {
    msgs.push("❌ Auth/balance check failed: " + e.message);
    msgs.push(`🔎 Key ID: ${keyId.slice(0, 13)}… (${keyId.length} chars, ${looksUuid(keyId) ? "uuid ✓" : "⚠️ NOT uuid"})`);
    if (/not found/i.test(e.message)) msgs.push("👉 Generate new API keys at polymarket.us/developer");
    return { ok: false, messages: msgs };
  }
  return { ok: true, messages: msgs };
}
