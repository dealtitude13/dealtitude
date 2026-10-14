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
  const [d] = await sql`
    select * from devices where token_hash = ${hash(token)} limit 1`;
  if (d) sql`update devices set last_seen_at = now() where id = ${d.id}`.catch(() => {});
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
