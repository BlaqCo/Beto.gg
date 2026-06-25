/**
 * polymarket-us.js — polymarket.us integration (no SDK; raw signed REST)
 */

import axios from "axios";
import crypto from "crypto";

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
  const message = `${timestamp}${method}${path}`;
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
  const msg = res.data?.message || res.data?.error || JSON.stringify(res.data)?.slice(0, 140) || `HTTP ${res.status}`;
  throw new Error(`${res.status}: ${msg}`);
}

// ── Public: sports moneyline markets ────────────────────────────
let _cache = null, _cacheTime = 0;
const TTL = 20_000;
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// Sub-period markets to always exclude regardless of type
const SUB_PERIOD = /first half|1st half|first 5|first five|first inning|1st inning|first quarter|1st quarter/i;

// Season-long future patterns — exclude these even if they have a game start time
const SEASON_FUTURE = /\b(champion|pennant|world series|super bowl|stanley cup|nba finals|wcf|ecf|alcs|nlcs|mvp|cy young|award|division winner|win the|make the playoffs|season total|over\/under \d+ wins)\b/i;

// Game moneyline patterns — covers all Polymarket question formats
// "X vs Y", "X at Y", "Will X beat/defeat Y", "Will X win against Y", "Will X win over Y"
const GAME_VS = /\bvs\.?\b|\bat\b|\bbeat\b|\bdefeat\b|\bwill .+ win (against|over|the match)|\bwill .+ (beat|defeat)/i;

export async function fetchSportsMoneylines() {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;

  // Fetch strategy: explicit sport-category endpoints + broad offsets
  // Targets: MLB, Tennis, Esports, Soccer, NBA, NFL, WNBA + broad sweep
  // Polymarket.us API uses sportLeague tag filtering, not category= strings.
  // Correct approach: fetch by sportsMarketType + broad offsets to get everything.
  // The tag league names found on polymarket.us: MLB, WNBA, Tennis (ATP/WTA/ITF),
  // Esports (CS2/Valorant/LoL), Soccer (World Cup/MLS), NBA, NFL
  const BASE = `${GATEWAY}/v1/markets?active=true&closed=false&limit=200`;
  const urls = [
    // Moneyline markets directly (most reliable for game winners)
    `${BASE}&sportsMarketType=SPORTS_MARKET_TYPE_MONEYLINE`,
    // Sports category (World Cup, MLB, WNBA etc all tagged as sports on .us)
    `${BASE}&category=sports`,
    `${BASE}&category=sports&offset=200`,
    `${BASE}&category=sports&offset=400`,
    // Baseball specifically
    `${BASE}&category=Baseball`,
    `${BASE}&category=baseball`,
    // Basketball (NBA + WNBA)
    `${BASE}&category=Basketball`,
    `${BASE}&category=basketball`,
    // Tennis
    `${BASE}&category=Tennis`,
    `${BASE}&category=tennis`,
    // Esports
    `${BASE}&category=Esports`,
    `${BASE}&category=esports`,
    // Broad sweep — catches everything else (soccer, NFL, etc)
    `${BASE}&offset=0`,
    `${BASE}&offset=200`,
    `${BASE}&offset=400`,
    `${BASE}&offset=600`,
    `${BASE}&offset=800`,
    `${BASE}&offset=1000`,
    `${BASE}&offset=1200`,
  ];

  const results = await Promise.allSettled(
    urls.map(url => axios.get(url, { timeout: 12_000 }))
  );

  const seenKeys = new Set();
  let raw = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled") {
      console.log(`  ⚠️ endpoint ${i} failed: ${r.reason?.message || "unknown"}`);
      continue;
    }
    const arr = r.value?.data?.markets || [];
    if (i < 8 && arr.length > 0) {
      // Log sport-specific endpoint results
      const cat = urls[i].match(/category=([^&]+)/)?.[1] || urls[i].match(/offset=([^&]+)/)?.[1] || i;
      console.log(`  📋 ${cat}: ${arr.length} markets`);
    }
    for (const m of arr) {
      const key = m.slug || m.id;
      if (key && !seenKeys.has(key)) { seenKeys.add(key); raw.push(m); }
    }
  }

  if (!raw.length) { console.log("⚠️ [sports API] all endpoints empty"); return _cache || []; }
  console.log(`📡 [sports API] ${raw.length} unique markets from ${urls.length} endpoints`);

  // ── Price extraction helper ──────────────────────────────────
  const parseArr = v => { try { return typeof v === "string" ? JSON.parse(v) : (Array.isArray(v) ? v : []); } catch { return []; } };

  function extractPrice(m) {
    // 1) bestBidQuote / bestAskQuote (V2 objects or plain numbers)
    const bidQ = m.bestBidQuote ?? m.bestBid;
    const askQ = m.bestAskQuote ?? m.bestAsk;
    const bid = num(typeof bidQ === "object" ? bidQ?.price : bidQ);
    const ask = num(typeof askQ === "object" ? askQ?.price : askQ);

    // 2) outcomePrices — most common for binary YES/NO markets (MLB, tennis etc)
    //    API returns "["0.62","0.38"]" — take the YES/higher side
    const outcomes  = parseArr(m.outcomes);
    const prices    = parseArr(m.outcomePrices).map(Number).filter(n => n > 0 && n < 1);
    let est = null;
    if (prices.length >= 2) {
      // Find YES index or just take highest price (the favorite)
      let yi = outcomes.findIndex(o => /yes/i.test(String(o)));
      if (yi < 0) yi = prices.indexOf(Math.max(...prices)); // fallback: highest = favorite
      if (yi >= 0 && yi < prices.length) est = prices[yi];
      if (!est) est = Math.max(...prices); // absolute fallback
    } else if (prices.length === 1) {
      est = prices[0];
    }

    // 3) marketSides long price
    if (est == null) {
      const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
      const longSide = sides.find(s => s.long === true);
      if (longSide) est = num(longSide.price);
    }

    // 4) lastTradePrice / ask / bid as final fallbacks
    if (est == null) est = ask ?? bid ?? num(m.lastTradePrice);

    return { bid, ask, est };
  }

  // ── Sport detection ───────────────────────────────────────────
  const SPORT_TAGS = {
    MLB:     /\bmlb\b|baseball|phillies|dodgers|giants|astros|yankees|cubs|mets|red sox|athletics|tigers|nationals|braves|cardinals|padres|brewers|mariners|pirates|reds|rockies|orioles|rays|guardians|twins|white sox|royals|rangers|angels|blue jays|diamondbacks/i,
    NBA:     /\bnba\b|basketball.*nba|celtics|lakers|warriors|bulls|heat|nuggets|bucks|suns|76ers|nets|knicks|raptors|mavericks|clippers|spurs|rockets|jazz|magic|pistons|hornets|hawks|pacers|grizzlies|kings|pelicans|blazers|thunder|timberwolves|cavaliers/i,
    NFL:     /\bnfl\b|football.*nfl|patriots|chiefs|cowboys|packers|steelers|bears|giants.*nfl|eagles|49ers|seahawks|ravens|bills|bengals|browns|colts|texans|jaguars|titans|broncos|raiders|chargers|dolphins|jets|falcons|saints|buccaneers|panthers|lions|vikings|rams|cardinals.*nfl/i,
    WNBA:    /\bwnba\b/i,
    TENNIS:  /\btennis\b|wimbledon|\batp\b|\bwta\b|french open|us open|australian open|roland garros|\bserve\b.*match|djokovic|alcaraz|sinner|swiatek|sabalenka|nadal|federer|osaka/i,
    ESPORTS: /\besport|\bcs:?go\b|\bdota\b|\blol\b|league of legends|\bvalorant\b|\boverwatch\b|\bfortnite\b|\brocket league\b|\bcall of duty\b|\bstarcraft\b/i,
    SOCCER:  /\bsoccer\b|\bfootball\b|\bmls\b|world cup|champions league|premier league|la liga|bundesliga|serie a|ligue 1|\bfc\b|\bfc \b|\bunited\b.*fc|real madrid|barcelona|chelsea|manchester|arsenal|liverpool|tottenham|juventus|milan|inter|psg|dortmund|ajax|porto|celtic/i,
  };

  function detectLeague(m) {
    const q = m.question || m.title || "";
    const cat = (m.category || "").toLowerCase();
    const tags = Array.isArray(m.tags) ? m.tags : [];

    // Check tags first (most reliable)
    for (const t of tags) {
      const abbr = t?.league?.abbreviation || t?.league?.name || t?.sport?.name;
      if (abbr) return abbr.toUpperCase().slice(0, 12);
    }

    // Check category
    if (cat === "mlb" || cat.includes("baseball")) return "MLB";
    if (cat === "nba" || cat.includes("basketball")) return "NBA";
    if (cat === "nfl" || cat.includes("football") && !cat.includes("soccer")) return "NFL";
    if (cat === "wnba") return "WNBA";
    if (cat === "tennis") return "TENNIS";
    if (cat === "esports" || cat.includes("esport")) return "ESPORTS";
    if (cat === "soccer" || cat.includes("soccer") || cat.includes("football")) return "SOCCER";

    // Check question text
    for (const [league, re] of Object.entries(SPORT_TAGS)) {
      if (re.test(q)) return league;
    }

    return "SPORT";
  }

  // ── Game market filter ────────────────────────────────────────
  const isGameMarket = m => {
    const q = (m.question || m.title || "").trim();
    if (!q) return false;
    if (m.active === false || m.closed === true || m.resolved === true) return false;

    // Exclude sub-period / props
    if (SUB_PERIOD.test(q)) return false;
    if (SEASON_FUTURE.test(q)) return false;

    const cat = (m.category || "").toLowerCase();
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const hasSportTag = tags.some(t => t?.sport?.name || t?.league?.name);
    const isSportsCat = ["mlb","nba","nfl","wnba","tennis","esports","soccer","sports","football","baseball","basketball"].some(s => cat.includes(s));
    const looksLikeSports = /(nba|nfl|mlb|nhl|mls|wnba|tennis|wimbledon|atp|wta|world cup|champions league|premier league|la liga|bundesliga|esport|cs:go|dota|valorant)/i.test(q);

    if (!isSportsCat && !hasSportTag && !looksLikeSports) return false;

    // Must look like a head-to-head matchup
    if (!GAME_VS.test(q)) return false;

    return true;
  };

  // ── Build output ──────────────────────────────────────────────
  const now = Date.now();
  const out = [];

  for (const m of raw) {
    const slug = m.slug || m.id || m.marketId;
    if (!slug) continue;
    if (!isGameMarket(m)) continue;

    const q = m.question || m.title || "";
    const { bid, ask, est } = extractPrice(m);

    // Time window: live OR starting within 12h
    // If no gameStartTime, use endDate as proxy (must end within 12h or be active)
    const gameStart = m.gameStartTime || m.game_start_time || m.startTime || null;
    let startMs = gameStart ? new Date(gameStart).getTime() : null;
    const endMs  = m.endDate ? new Date(m.endDate).getTime() : null;

    let passesTime = false;
    if (startMs) {
      const hoursOut = (startMs - now) / 3_600_000;
      passesTime = startMs <= now || hoursOut <= 12; // live or within 12h
    } else if (endMs) {
      // No start time — accept if market ends within 24h and hasn't ended
      const daysToEnd = (endMs - now) / (3_600_000 * 24);
      passesTime = endMs > now && daysToEnd <= 1;
    }
    if (!passesTime) continue;

    // Must have a usable price
    const px = est ?? ask ?? bid;
    if (!px) continue;

    const league = detectLeague(m);
    if (startMs == null) startMs = endMs ?? now;
    const isLive = startMs <= now;
    const hoursUntil = isLive ? 0 : Math.round((startMs - now) / 3_600_000 * 10) / 10;

    out.push({
      slug, question: q,
      subtitle: m.subtitle || null,
      league,
      ask: ask ?? est, bid: bid ?? est, est: est ?? ask ?? bid,
      tick: num(m.orderPriceMinTickSize) || 0.01,
      minQty: num(m.minimumTradeQty) || 1,
      gameStartIso: gameStart,
      endIso: m.endDate || null,
      category: m.category || "",
      isLive,
      hoursUntil,
      sportsType: m.sportsMarketTypeV2 || m.sportsMarketType || "",
    });
  }

  // Sort: live first, then soonest, then highest price
  out.sort((a, b) => {
    if (b.isLive !== a.isLive) return b.isLive ? 1 : -1;
    const aStart = a.gameStartIso ? new Date(a.gameStartIso).getTime() : now + 999_999_999;
    const bStart = b.gameStartIso ? new Date(b.gameStartIso).getTime() : now + 999_999_999;
    if (aStart !== bStart) return aStart - bStart;
    return (b.est || 0) - (a.est || 0);
  });

  const liveCount = out.filter(x => x.isLive).length;
  const preCount  = out.length - liveCount;
  console.log(`📊 [sports API] ${raw.length} total → ${out.length} game moneylines (${liveCount} live, ${preCount} upcoming)`);
  if (out.length > 0) {
    console.log("  Sample markets: " + out.slice(0,5).map(m => `${m.isLive?"🔴":"⏳"} ${m.league} ${(m.est*100).toFixed(0)}¢ ${m.question.slice(0,30)}`).join(" | "));
  }

  _cache = out;
  _cacheTime = Date.now();
  return out;
}

export async function verifyCandidates(cands, { maxSpread = 0.06 } = {}) {
  const checks = await Promise.all(cands.map(async c => {
    const bbo = await getBBO(c.slug);
    if (!bbo?.bid || !bbo?.ask) return null;
    if (bbo.ask - bbo.bid > maxSpread) return null;
    return { ...c, ask: bbo.ask, bid: bbo.bid };
  }));
  return checks.filter(Boolean);
}

export async function getBBO(slug) {
  try {
    const { data } = await axios.get(
      `${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/bbo`, { timeout: 8_000 });
    const d = data?.marketData || data || {};
    const val = x => (x && x.value != null) ? Number(x.value) : num(x);
    return { bid: val(d.bestBid), ask: val(d.bestAsk),
             last: val(d.lastTradePx) ?? val(d.lastTradePrice) };
  } catch { return null; }
}

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
  const buyingPower = money(root.buyingPower) ?? money(root.buying_power) ?? null;
  const currentBalance = money(root.currentBalance) ?? money(root.current_balance) ?? money(root.cashBalance) ?? null;
  if ((buyingPower == null || buyingPower === 0) && !_balShapeLogged) {
    _balShapeLogged = true;
    console.log("🔍 balances raw shape:", JSON.stringify(b).slice(0, 300));
  }
  return { buyingPower: buyingPower ?? 0, currentBalance: currentBalance ?? buyingPower ?? 0 };
}

export async function buyYesFOK({ slug, sizeUsd, ask, tick = 0.01 }) {
  const limit = Math.min(0.99, Math.round((ask + tick) / tick) * tick);
  const qty = Math.floor(sizeUsd / limit);
  if (qty < 1) return { filled: false, error: `size $${sizeUsd} < 1 contract @ ${limit.toFixed(2)}` };
  try {
    const order = await signedRequest("POST", "/v1/orders", {
      marketSlug: slug,
      intent: "ORDER_INTENT_BUY_LONG",
      type: "ORDER_TYPE_LIMIT",
      price: { value: limit.toFixed(2), currency: "USD" },
      quantity: qty,
      tif: "TIME_IN_FORCE_FILL_OR_KILL",
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

export async function closePositionLive(slug) {
  try {
    await signedRequest("POST", "/v1/order/close-position", { marketSlug: slug });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function getOpenPositions() {
  try {
    const data = await signedRequest("GET", "/v1/portfolio/positions");
    const positions = data?.positions || {};
    const out = {};
    for (const [slug, p] of Object.entries(positions)) {
      out[slug] = {
        qtyBought: Number(p?.qtyBought ?? 0),
        netPosition: Number(p?.netPosition ?? 0),
      };
    }
    return out;
  } catch (err) {
    console.error("⚠️ getOpenPositions failed:", err.message);
    return null;
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
    msgs.push(`🔎 Sending Key ID: ${keyId.slice(0, 13)}… (${keyId.length} chars, ${looksUuid(keyId) ? "uuid ✓" : "⚠️ NOT uuid"})`);
    if (/not found/i.test(e.message)) {
      msgs.push("👉 Key doesn't exist server-side — generate new API keys at polymarket.us/developer");
    }
    return { ok: false, messages: msgs };
  }
  return { ok: true, messages: msgs };
}
