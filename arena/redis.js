/** arena/redis.js — tiny Upstash REST helper. Returns undefined when Redis isn't configured. */
const URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.REDIS_REST_URL   || null;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || null;
export const hasRedis = () => !!(URL && TOKEN);
export async function redis(cmd) {
  if (!URL || !TOKEN) return undefined;
  const res = await fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json())?.result ?? null;
}
