import { test } from "node:test";
import assert from "node:assert/strict";

// A fake Upstash: SET NX succeeds only for a key that isn't there yet.
process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
const store = new Map();
let fail = false;
globalThis.fetch = async (url, { body }) => {
  if (fail) return { ok: false, status: 503, json: async () => ({}) };
  const [cmd, key, val, nx] = JSON.parse(body);
  if (cmd === "SET" && nx === "NX") {
    if (store.has(key)) return { ok: true, json: async () => ({ result: null }) };
    store.set(key, val); return { ok: true, json: async () => ({ result: "OK" }) };
  }
  return { ok: true, json: async () => ({ result: null }) };
};
const { claimOnce } = await import("../state.js");

test("claimOnce: only one running copy of the bot gets a window", async () => {
  assert.equal(await claimOnce("arena:copy:live:claim:btc15:123"), true, "first copy bets");
  assert.equal(await claimOnce("arena:copy:live:claim:btc15:123"), false, "second copy is refused");
  assert.equal(await claimOnce("arena:copy:live:claim:btc15:456"), true, "next window is free again");
});

test("claimOnce: a Redis error throws so the caller can refuse to bet", async () => {
  fail = true;
  await assert.rejects(claimOnce("arena:copy:live:claim:btc15:789"));
  fail = false;
});
