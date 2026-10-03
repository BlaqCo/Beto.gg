/**
 * arena/specs-store.js — recipes written by the AI agents.
 * Stored in Redis hash "arena:specs": name -> { spec, author, created, status, note }.
 * status: "active" (tested every leaderboard run) or "retired" (kept for the record).
 */
import { redis } from "./redis.js";
import { validateSpec, compileSpec } from "./spec.js";

const KEY = "arena:specs";
const memory = new Map();

export async function listSpecs() {
  try {
    const flat = await redis(["HGETALL", KEY]);
    if (Array.isArray(flat)) {
      const out = [];
      for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch {} }
      return out;
    }
  } catch {}
  return [...memory.values()];
}

export async function saveSpec(rec) {
  const line = JSON.stringify(rec);
  try { if ((await redis(["HSET", KEY, rec.spec.name, line])) !== undefined) return; } catch {}
  memory.set(rec.spec.name, rec);
}

export async function addSpec(raw, { author, created = new Date().toISOString().slice(0, 10) } = {}) {
  const v = validateSpec(raw);
  if (!v.ok) return { ok: false, error: v.error };
  const existing = await listSpecs();
  if (existing.some(r => r.spec.name === v.spec.name)) return { ok: false, error: `a strategy named ${v.spec.name} already exists` };
  const rec = { spec: v.spec, author: String(author || "agent").toUpperCase().slice(0, 16), created, status: "active", note: "" };
  await saveSpec(rec);
  return { ok: true, rec };
}

export async function retireSpec(name, note) {
  const all = await listSpecs();
  const rec = all.find(r => r.spec.name === name);
  if (!rec || rec.status === "retired") return false;
  rec.status = "retired"; rec.note = String(note || "").slice(0, 200); rec.retiredAt = new Date().toISOString();
  await saveSpec(rec);
  return true;
}

/** Active recipes compiled into arena strategies. */
export async function loadSpecStrategies() {
  const out = [], errors = [];
  for (const rec of await listSpecs()) {
    if (rec.status !== "active") continue;
    const v = validateSpec(rec.spec);
    if (!v.ok) { errors.push({ file: `spec:${rec.spec?.name}`, error: v.error }); continue; }
    out.push(compileSpec(v.spec, { author: rec.author, created: rec.created }));
  }
  return { strategies: out, errors };
}
