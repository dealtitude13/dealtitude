/* ---------------------------------------------------------------------------
 * Who is calling.
 *
 * Two kinds of caller, deliberately unequal:
 *
 *   A device   — a shopper's phone. No account, no email, no password. The
 *                phone proves itself with a token it was handed when it first
 *                registered. Losing the phone loses only that phone's follows.
 *
 *   An owner   — a shopkeeper. Email magic link, then a session. Owning a shop
 *                is never something a request body can assert: membership
 *                comes from an invite someone with the keys created.
 * ------------------------------------------------------------------------- */
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { sql } from "./db.js";

export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
const hash = (t) => createHash("sha256").update(t).digest("hex");

/* Stored hashed: a leaked database row must not be a working credential. */
export const store = hash;

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const bearer = (c) => {
  const h = c.req.header("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

/** Resolves the device, or null. Never throws — callers decide what's required. */
export async function deviceFrom(c) {
  const token = bearer(c);
  if (!token) return null;
  /* The touch and the lookup are ONE statement, awaited.
   *
   * It used to be a select followed by a fire-and-forget update, which looked
   * cheaper and was not: two round-trips instead of one, and the write could
   * still be in flight when the next request read it. That mattered once
   * last_seen_at stopped being a diagnostic and became evidence — it is what
   * decides whether a shop is told a follower is confirmed reachable. A number
   * shown to a shopkeeper should not depend on which query won a race, and an
   * error swallowed by .catch() would silently under-report it.
   *
   * token_hash is unique, so this updates at most one row. */
  const [d] = await sql`
    update devices set last_seen_at = now()
     where token_hash = ${hash(token)}
    returning *`;
  return d || null;
}

export async function ownerFrom(c) {
  const token = bearer(c);
  if (!token) return null;
  const [s] = await sql`
    select o.* from sessions s join owners o on o.id = s.owner_id
     where s.token = ${hash(token)} and s.expires_at > now() limit 1`;
  return s || null;
}

/** Does this owner hold this shop? The only route to posting. */
export async function holdsShop(ownerId, shopId) {
  const [m] = await sql`
    select 1 from memberships where owner_id = ${ownerId} and shop_id = ${shopId}`;
  return Boolean(m);
}

/** Operator key, for creating shops and issuing invites. Not a user role. */
export function isAdmin(c) {
  /* Both sides trimmed. A value pasted into a hosting dashboard picks up a
     trailing newline often enough, and the symptom — every correct key
     refused — looks nothing like its cause. */
  const key = (c.req.header("x-admin-key") || "").trim();
  const want = (process.env.ADMIN_KEY || "").trim();
  return Boolean(want && key && safeEqual(key, want));
}

/** Is an operator key configured at all? Without one, every key is refused,
    which is indistinguishable from a wrong key unless we say so. */
export const adminKeySet = () => Boolean((process.env.ADMIN_KEY || "").trim());
