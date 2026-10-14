import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { sql, healthy } from "./db.js";
import { publish } from "./publish.js";
import { publicKey, pushConfigured, backends } from "./push.js";
import {
  newToken, store, deviceFrom, ownerFrom, holdsShop, isAdmin, adminKeySet,
} from "./auth.js";
import { sendSignInLink, mailConfigured } from "./mail.js";

/* Bumped by hand with each handoff, and reported by /v1/health. The app shows
   the same stamp on its first screen, so one look at each says whether the two
   halves actually match. */
const BUILD = "2026-10-14c";

/* Deliberately not just "is this not production": a pilot IS production here.
   It has to be switched on by hand and switched off again. */
const resetAllowed = String(process.env.ALLOW_RESET || "").toLowerCase() === "true";

const app = new Hono();

/* The installed app is not served from your website.
 *
 * On a phone the web view loads from a scheme of the platform's choosing —
 * capacitor://localhost on iOS, https://localhost on Android — and that is the
 * origin every request from the App Store build carries. It is a fact of the
 * platform rather than a deployment choice, so it belongs here and not in an
 * environment variable somebody has to remember.
 *
 * Leaving these out blocks every single request the installed app makes, and
 * the app can only report it as "couldn't reach Dealtitude" — which sends you
 * looking at your wifi rather than at this list. */
const NATIVE_ORIGINS = [
  "capacitor://localhost",      // iOS
  "https://localhost",          // Android
  "ionic://localhost",          // older builds, harmless to keep
];

const configured = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const allowedOrigins = configured.includes("*")
  ? "*"
  : [...new Set([...configured, ...NATIVE_ORIGINS])];

app.use("*", cors({
  origin: allowedOrigins,
  allowHeaders: ["content-type", "authorization", "x-admin-key"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
}));

/* A blunt per-IP limiter. Enough to stop a loop hammering the follow endpoint;
   a real one belongs at the edge. */
const hits = new Map();
app.use("*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, until: now + 60_000 };
  if (now > rec.until) { rec.n = 0; rec.until = now + 60_000; }
  rec.n++; hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  if (rec.n > Number(process.env.RATE_PER_MIN || 240))
    return c.json({ error: "slow down" }, 429);
  await next();
});

const fail = (c, status, error) => c.json({ error }, status);
const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    throw Object.assign(new Error(`${i.path.join(".") || "body"}: ${i.message}`),
                        { status: 400 });
  }
  return r.data;
};

app.onError((err, c) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[api]", err);
  return c.json({ error: err.message || "something went wrong" }, status);
});

/* ------------------------------------------------------------------ meta -- */
/* Everything a deploy needs to confirm, in one request. Each of these failing
   quietly looks identical from the app — a follow that doesn't stick, an alert
   nobody gets, a sign-in link that never arrives — so they are stated plainly
   here rather than discovered on a shop floor. */
app.get("/v1/health", async (c) => {
  const db = await healthy();
  return c.json({
    ok: db && pushConfigured,
    db,
    push: pushConfigured,
    /* Which routes to a lock screen are actually wired up. A native build
       whose keys never made it into the environment looks identical to a
       working one until the first alert vanishes, so it is stated here. */
    push_backends: backends(),
    mail: mailConfigured,
    /* Whether the App Store reviewer can get in. Worth seeing at a glance:
       its absence is only discovered through a rejection, days later. */
    review_sign_in: reviewSignInEnabled,
    /* Whether an operator key exists at all. Without one every key is
       refused, and the app can only report that as "wrong key" — which sends
       you checking the key you typed instead of the one that is missing. */
    admin_key: adminKeySet(),
    /* Whether the start-fresh route is open. Shown so the app can offer it
       only when it exists, and so you can see at a glance that you left it
       switched on. */
    reset_enabled: resetAllowed,
    app_url: process.env.APP_URL || null,
    origins: allowedOrigins,
    /* Two builds, because "is my change live?" was the hardest question to
       answer all week. BUILD is written by hand and matches the app's stamp;
       commit is whatever the host happened to deploy. */
    build: BUILD,
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
  }, db ? 200 : 503);
});

app.get("/v1/push-key", (c) =>
  pushConfigured ? c.json({ key: publicKey() })
                 : fail(c, 503, "push is not configured on this server"));

/* ---------------------------------------------------------------- device -- */
/* A phone registers its push subscription and gets a token back. That token
   is the whole identity — no email, no password, nothing to forget. */
/* `endpoint` is optional on purpose. Someone who declines notifications, or
   whose iPhone is not on the home screen yet, still gets a device so they can
   follow a shop and open the app to see what is on — and still counts as
   unreachable in the shop's reach figure until they have a subscription. */
/* `endpoint` means two different things depending on the route a phone is
   reachable by: a Web Push subscription URL for a browser, or an opaque APNs /
   FCM device token for an App Store or Play Store build. They have to be told
   apart rather than waved through, because a native token stored as a webpush
   row would be handed to the web-push library and fail forever — a follower
   who is counted, never written to, and never retired. */
const DeviceIn = z.object({
  endpoint: z.string().min(8).max(2000).optional(),
  p256dh: z.string().max(400).optional(),
  auth: z.string().max(400).optional(),
  kind: z.enum(["none", "webpush", "apns", "fcm"]).optional(),
}).superRefine((v, ctx) => {
  if (!v.endpoint) return;
  const kind = v.kind || "webpush";
  const bad = (m) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoint"], message: m });

  if (kind === "webpush") {
    let u;
    try { u = new URL(v.endpoint); } catch { return bad("endpoint must be a push subscription URL"); }
    if (u.protocol !== "https:") bad("a push subscription must be https");
    return;
  }
  if (kind === "none") return bad("a device with no notifications has no endpoint");
  /* Apple sends hex; Google sends a longer base64url-ish string with a colon.
     Neither is ever a URL, and anything with a slash or a space is a mistake. */
  if (!/^[A-Za-z0-9_:.-]{32,}$/.test(v.endpoint)) bad("that is not a valid device token");
});

app.post("/v1/device", async (c) => {
  const b = parse(DeviceIn, await c.req.json().catch(() => ({})));
  const token = newToken();
  const ua = (c.req.header("user-agent") || "").slice(0, 300);
  const kind = b.kind || (b.endpoint ? "webpush" : "none");

  /* No endpoint: nothing to match on, so this is simply a new phone. */
  if (!b.endpoint) {
    const [d] = await sql`
      insert into devices (kind, endpoint, user_agent, token_hash)
      values (${kind}, null, ${ua}, ${store(token)}) returning id`;
    return c.json({ device_id: d.id, token, push: false });
  }

  /* Same endpoint coming back = same phone. Re-issue rather than duplicate,
     and clear any retirement: it is plainly alive again. */
  const [d] = await sql`
    insert into devices (kind, endpoint, p256dh, auth, user_agent, token_hash)
    values (${kind}, ${b.endpoint}, ${b.p256dh ?? null}, ${b.auth ?? null},
            ${ua}, ${store(token)})
    on conflict (endpoint) do update
      set kind = excluded.kind, p256dh = excluded.p256dh, auth = excluded.auth,
          token_hash = excluded.token_hash, retired_at = null,
          last_seen_at = now()
    returning id`;
  return c.json({ device_id: d.id, token, push: true });
});

/* ------------------------------------------------- carrying a follower ---- */
/* An iPhone's home-screen app cannot see what Safari stored, so a follow made
   in Safari would be stranded the moment someone installs. These two routes
   carry it across: Safari asks for a code, the installed app redeems it, and
   the same device — with its follows and aisles — continues on the other side.

   The code is deliberately feeble on its own: short-lived, single use, and
   worth only the follows of the phone that asked for it. */

app.post("/v1/device/claim-code", async (c) => {
  const d = await deviceFrom(c);
  if (!d) return fail(c, 401, "unknown device");
  /* Unambiguous alphabet: no O/0, no I/1/L. This ends up in a URL and
     occasionally in front of a human being. */
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const code = Array.from(randomBytes(10))
    .map((n) => alphabet[n % alphabet.length]).join("");
  await sql`insert into device_claims (code, device_id, expires_at)
            values (${code}, ${d.id}, now() + interval '2 hours')`;
  return c.json({ code, expires_in: 7200 });
});

app.post("/v1/device/claim", async (c) => {
  const b = parse(z.object({
    code: z.string().min(6).max(40),
    endpoint: z.string().url().max(2000).optional(),
    p256dh: z.string().max(400).optional(),
    auth: z.string().max(400).optional(),
  }), await c.req.json());

  const [claim] = await sql`
    select * from device_claims
     where code = ${b.code} and used_at is null and expires_at > now()`;
  if (!claim) return fail(c, 404, "that code has expired — follow the shop again");

  /* A fresh token for the new install: the old one stays valid on the old
     side, which is correct — Safari and the home-screen app are two real
     places the same person might open this. */
  const token = newToken();
  await sql.begin(async (tx) => {
    await tx`update device_claims set used_at = now() where code = ${claim.code}`;
    await tx`update devices
                set token_hash = ${store(token)},
                    last_seen_at = now(),
                    retired_at = null
                    ${b.endpoint ? tx`, endpoint = ${b.endpoint},
                        p256dh = ${b.p256dh ?? null}, auth = ${b.auth ?? null},
                        kind = 'webpush'` : tx``}
              where id = ${claim.device_id}`;
  });

  const follows = await sql`
    select s.slug, s.name, f.aisles, f.muted
      from follows f join shops s on s.id = f.shop_id
     where f.device_id = ${claim.device_id}`;
  return c.json({ device_id: claim.device_id, token, follows });
});

/* A browser may rotate a subscription without being asked. The phone keeps its
   token, so its follows stay attached — only the address it is reachable at
   changes. Without this a rotated follower is counted but never hears anything,
   which is the worst possible state for a shop paying for reach. */
app.patch("/v1/device", async (c) => {
  const d = await deviceFrom(c);
  if (!d) return fail(c, 401, "unknown device");
  const b = parse(DeviceIn, await c.req.json());
  /* This route exists to attach a subscription. Without one it would clear the
     device's only way of being reached — the opposite of what it is for. */
  if (!b.endpoint) return fail(c, 400, "an endpoint is required");

  /* If that endpoint is already some other row — the same browser registered
     fresh before the rotation reached us — fold this one into it rather than
     tripping the unique index. */
  const [other] = await sql`
    select id from devices where endpoint = ${b.endpoint} and id <> ${d.id}`;
  if (other) {
    await sql.begin(async (tx) => {
      /* Release the hash before handing it over — it is a unique index, and
         the two rows would otherwise collide mid-merge. */
      await tx`update devices set token_hash = null, retired_at = now()
                where id = ${d.id}`;

      /* Union the aisles. Both rows are this same phone, and each aisle in
         either one is an opt-in the shopper actually made; keeping only one
         side's list would silently switch an aisle back off. */
      await tx`
        insert into follows (device_id, shop_id, aisles, muted)
        select ${other.id}, shop_id, aisles, muted
          from follows where device_id = ${d.id}
        on conflict (device_id, shop_id) do update
          set aisles = (select array_agg(distinct a order by a)
                          from unnest(follows.aisles || excluded.aisles) as a),
              muted  = follows.muted and excluded.muted,
              updated_at = now()`;

      /* The old row's follows are now represented by the surviving row.
         Leaving them in place would count this one phone twice in reach. */
      await tx`delete from follows where device_id = ${d.id}`;

      await tx`update devices
                  set token_hash = ${d.token_hash}, retired_at = null,
                      p256dh = ${b.p256dh ?? null}, auth = ${b.auth ?? null},
                      kind = ${b.kind || "webpush"}, last_seen_at = now()
                where id = ${other.id}`;
    });
    return c.json({ device_id: other.id, merged: true });
  }

  await sql`update devices
               set endpoint = ${b.endpoint}, p256dh = ${b.p256dh ?? null},
                   auth = ${b.auth ?? null}, kind = ${b.kind || "webpush"},
                   retired_at = null, last_seen_at = now()
             where id = ${d.id}`;
  return c.json({ device_id: d.id, merged: false });
});

/* ------------------------------------------------------------- age gate --- */
/* A liquor shop's alerts are alcohol marketing, and both app stores require a
   gate in front of them.
 *
 * The phone asks for a date of birth, works out the answer there, and sends
 * only the bar it cleared. No birth date reaches this server, so there is none
 * stored here — which is the honest version of a promise the shop owners were
 * already told: Dealtitude knows how many followers they have, never who.
 *
 * This is an attestation, like every age gate on the consumer internet. It is
 * what the app stores ask for; it is not identity verification and is not
 * described as one anywhere in the product. */

const AgeIn = z.object({ min_age: z.number().int().min(13).max(25) });

app.post("/v1/device/age", async (c) => {
  const device = await need(c);
  const b = parse(AgeIn, await c.req.json());
  /* Highest bar wins: clearing 21 also clears 18, and a later lower answer
     must not quietly walk back an earlier one. */
  await sql`
    update devices
       set age_ok_to = greatest(coalesce(age_ok_to, 0), ${b.min_age}),
           age_ok_at = now(), last_seen_at = now()
     where id = ${device.id}`;
  return c.json({ age_ok_to: b.min_age });
});

/** Has this caller cleared the bar for this shop? Shops with no bar: always. */
const oldEnough = (device, shop) =>
  !shop.min_age || (device?.age_ok_to != null && device.age_ok_to >= shop.min_age);

/* ----------------------------------------------------------------- shops -- */
const shopShape = sql`
  s.id, s.slug, s.name, s.address, s.town, s.zip, s.hours, s.daily_cap, s.min_age`;

app.get("/v1/shops", async (c) => {
  const zip = (c.req.query("zip") || "").trim();
  if (!/^\d{5}$/.test(zip)) return fail(c, 400, "a 5-digit zip is required");
  const rows = await sql`
    select ${shopShape},
           coalesce((select array_agg(a.aisle order by a.position, a.aisle)
                       from shop_aisles a where a.shop_id = s.id), '{}') as aisles,
           (select count(*) from follows f where f.shop_id = s.id) as followers
      from shops s where s.zip = ${zip} and s.active order by s.name`;
  return c.json({ shops: rows });
});

app.get("/v1/shops/:slug", async (c) => {
  const [s] = await sql`
    select ${shopShape},
           coalesce((select array_agg(a.aisle order by a.position, a.aisle)
                       from shop_aisles a where a.shop_id = s.id), '{}') as aisles,
           (select count(*) from follows f where f.shop_id = s.id) as followers
      from shops s where s.slug = ${c.req.param("slug")} and s.active`;
  if (!s) return fail(c, 404, "no such shop");

  /* The shop's name, address and hours are not alcohol content and stay
     visible — a printed card has to land somewhere that makes sense. What is
     held back is the marketing: the posts. The app shows the gate in their
     place, so this is the lock behind that door rather than the door itself. */
  if (s.min_age && !oldEnough(await deviceFrom(c), s)) {
    return c.json({ shop: s, posts: [], age_gated: true });
  }

  const posts = await sql`
    select id, kind, aisle, name, note, was_cents, now_cents, ends, created_at
      from posts where shop_id = ${s.id} and status = 'active'
     order by created_at desc limit 30`;
  return c.json({ shop: s, posts });
});

/* --------------------------------------------------------------- follows -- */
const need = async (c) => {
  const d = await deviceFrom(c);
  if (!d) throw Object.assign(new Error("register this device first"), { status: 401 });
  return d;
};

const FollowIn = z.object({ aisles: z.array(z.string().max(40)).max(40).default([]) });

app.post("/v1/shops/:slug/follow", async (c) => {
  const device = await need(c);
  const b = parse(FollowIn, await c.req.json().catch(() => ({})));
  const [shop] = await sql`
    select id, min_age from shops where slug = ${c.req.param("slug")} and active`;
  if (!shop) return fail(c, 404, "no such shop");
  /* Following IS the subscription to the marketing, so this is the one that
     actually matters. Refusing here is what stops a device that never saw the
     gate — a script, a stale app, a curious developer — from signing itself up
     for alcohol alerts. */
  if (!oldEnough(device, shop))
    return fail(c, 403, "confirm your age before following this shop");

  /* Only aisles this shop actually has — a typo must not become a silent
     subscription to nothing. */
  const valid = (await sql`select aisle from shop_aisles where shop_id = ${shop.id}`)
    .map((r) => r.aisle);
  const aisles = b.aisles.filter((a) => valid.includes(a));

  await sql`
    insert into follows (device_id, shop_id, aisles)
    values (${device.id}, ${shop.id}, ${aisles})
    on conflict (device_id, shop_id) do update
      set aisles = excluded.aisles, muted = false, updated_at = now()`;
  return c.json({ following: true, aisles });
});

const PatchIn = z.object({
  aisles: z.array(z.string().max(40)).max(40).optional(),
  muted: z.boolean().optional(),
});

app.patch("/v1/shops/:slug/follow", async (c) => {
  const device = await need(c);
  const b = parse(PatchIn, await c.req.json());
  const [shop] = await sql`select id from shops where slug = ${c.req.param("slug")}`;
  if (!shop) return fail(c, 404, "no such shop");

  if (b.aisles) {
    const valid = (await sql`select aisle from shop_aisles where shop_id = ${shop.id}`)
      .map((r) => r.aisle);
    const aisles = b.aisles.filter((a) => valid.includes(a));
    await sql`update follows set aisles = ${aisles}, updated_at = now()
               where device_id = ${device.id} and shop_id = ${shop.id}`;
  }
  if (b.muted !== undefined) {
    await sql`update follows set muted = ${b.muted}, updated_at = now()
               where device_id = ${device.id} and shop_id = ${shop.id}`;
  }
  const [f] = await sql`select aisles, muted from follows
     where device_id = ${device.id} and shop_id = ${shop.id}`;
  if (!f) return fail(c, 404, "not following that shop");
  return c.json(f);
});

app.delete("/v1/shops/:slug/follow", async (c) => {
  const device = await need(c);
  const [shop] = await sql`select id from shops where slug = ${c.req.param("slug")}`;
  if (!shop) return fail(c, 404, "no such shop");
  await sql`delete from follows where device_id = ${device.id} and shop_id = ${shop.id}`;
  return c.json({ following: false });
});

app.get("/v1/me/follows", async (c) => {
  const device = await need(c);
  const rows = await sql`
    select s.slug, s.name, s.address, s.town, s.zip, s.hours, s.daily_cap,
           s.min_age, f.aisles, f.muted
      from follows f join shops s on s.id = f.shop_id
     where f.device_id = ${device.id} order by s.name`;
  return c.json({ follows: rows });
});

app.get("/v1/me/feed", async (c) => {
  const device = await need(c);
  const rows = await sql`
    select p.id, p.kind, p.aisle, p.name, p.note, p.was_cents, p.now_cents,
           p.ends, p.created_at, s.slug, s.name as shop_name
      from posts p
      join follows f on f.shop_id = p.shop_id and f.device_id = ${device.id}
      join shops s on s.id = p.shop_id
     where p.status = 'active'
       and (p.kind in ('hours','notice') or p.aisle = any (f.aisles))
       /* An age-restricted shop's posts only appear once this device has
          cleared that shop's bar. A follow made before the gate existed, or a
          bar a shop raises later, both land on the right side of this. */
       and (s.min_age is null
            or (${device.age_ok_to ?? null}::smallint is not null
                and ${device.age_ok_to ?? null}::smallint >= s.min_age))
     order by p.created_at desc limit 50`;
  return c.json({ posts: rows });
});

/* A tapped notification. The honest ceiling on what a shop can be told. */
app.post("/v1/posts/:id/opened", async (c) => {
  const device = await deviceFrom(c);
  if (!device) return c.json({ ok: true });     // never block on telemetry
  await sql`update deliveries set opened_at = now()
             where post_id = ${c.req.param("id")} and device_id = ${device.id}
               and opened_at is null`;
  return c.json({ ok: true });
});

/* ----------------------------------------------------------------- owner -- */
app.post("/v1/auth/request", async (c) => {
  const { email } = parse(z.object({ email: z.string().email() }), await c.req.json());
  const token = newToken();
  await sql`insert into login_links (token, email, expires_at)
            values (${store(token)}, ${email}, now() + interval '20 minutes')`;
  const link = `${process.env.APP_URL || ""}/owner?token=${token}`;
  const mail = await sendSignInLink(email, link, 20);

  /* The reply never says whether that address has a shop — telling a stranger
     which emails are registered hands them the list for free.

     The link comes back in the body only when there is no mail sender wired
     AND this is not production, so a pilot can run before the mail domain is
     verified without the link ever being exposed on a live server. */
  const showLink = !mailConfigured && process.env.NODE_ENV !== "production";
  return c.json(showLink ? { sent: true, link } : { sent: true });
});

app.post("/v1/auth/verify", async (c) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), await c.req.json());
  const [link] = await sql`
    select * from login_links
     where token = ${store(token)} and used_at is null and expires_at > now()`;
  if (!link) return fail(c, 401, "that link has expired — ask for a new one");
  await sql`update login_links set used_at = now() where token = ${link.token}`;

  const [owner] = await sql`
    insert into owners (email) values (${link.email})
    on conflict (email) do update set email = excluded.email returning *`;

  /* Any invite waiting for this address becomes membership now. This is the
     only path by which anyone ever comes to hold a shop. */
  const invites = await sql`
    select * from invites where email = ${link.email}
      and accepted_at is null and expires_at > now()`;
  for (const inv of invites) {
    await sql`insert into memberships (owner_id, shop_id, role)
              values (${owner.id}, ${inv.shop_id}, ${inv.role})
              on conflict do nothing`;
    await sql`update invites set accepted_at = now(), accepted_by = ${owner.id}
               where token = ${inv.token}`;
  }

  const session = newToken();
  await sql`insert into sessions (token, owner_id, expires_at)
            values (${store(session)}, ${owner.id}, now() + interval '60 days')`;
  return c.json({ token: session, owner: { id: owner.id, email: owner.email },
                  claimed: invites.length });
});

/* ---------------------------------------------------------------- review ---
 * Signing in without an inbox.
 *
 * Owner access is a link emailed to the address on the invitation, which works
 * for a shopkeeper and not at all for the person at Apple who has to open this
 * app and try everything in it before it can go on the App Store. They have no
 * inbox of ours, so the email road is a dead end and the app is rejected as
 * unreviewable — one of the most common reasons a first submission fails.
 *
 * This is the standard answer: ONE account that signs in with a fixed code,
 * handed to Apple in the review notes. It is deliberately narrow.
 *
 *   - Dead unless BOTH env vars are set. No env, no route.
 *   - One address only, the one named in REVIEW_EMAIL.
 *   - The code is compared in constant time, so it cannot be guessed by
 *     timing the answer.
 *   - It grants nothing on its own. The account holds exactly the shops it was
 *     invited to, through the same invite rows as everyone else — so invite it
 *     to a demo shop and it can never touch a real one.
 * ------------------------------------------------------------------------- */

/* One or more addresses, comma separated. More than one because the person
   who built this needs to sign in on a shop floor with no inbox to hand just
   as much as a reviewer does, and sharing one address between them would mean
   Apple signing in as the real operator. */
/* Either spelling works. The value is a LIST, so the plural is the natural
   guess when typing it into a hosting dashboard — and getting it wrong fails
   as "that code is not right", which sends you looking at the code instead of
   the variable name. */
const REVIEW_EMAILS = (process.env.REVIEW_EMAIL || process.env.REVIEW_EMAILS || "")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const REVIEW_CODE  = process.env.REVIEW_CODE || "";
export const reviewSignInEnabled = Boolean(REVIEW_EMAILS.length && REVIEW_CODE);

/* Turning every invite addressed to this owner into a membership.
 *
 * Shared by signing in and by /v1/owner/claim, because an invite that only
 * takes effect on the NEXT sign-in is a trap: the operator adds a shop with
 * their own address on it, the screen stays empty, and nothing on it suggests
 * signing out is what's needed. Only invites written to this owner's own
 * address are ever accepted, so it grants nothing that a sign-in would not. */
async function claimInvites(owner) {
  const invites = await sql`
    select * from invites where email = ${owner.email}
      and accepted_at is null and expires_at > now()`;
  for (const inv of invites) {
    await sql`insert into memberships (owner_id, shop_id, role)
              values (${owner.id}, ${inv.shop_id}, ${inv.role})
              on conflict do nothing`;
    await sql`update invites set accepted_at = now(), accepted_by = ${owner.id}
               where token = ${inv.token}`;
  }
  return invites;
}

app.post("/v1/auth/code", async (c) => {
  if (!reviewSignInEnabled) return fail(c, 404, "not found");
  const b = parse(z.object({
    email: z.string().email(),
    code: z.string().min(8).max(100),
  }), await c.req.json());

  const email = b.email.trim().toLowerCase();
  const emailOk = REVIEW_EMAILS.includes(email);
  /* Both sides padded to the same length first: timingSafeEqual throws on a
     length mismatch, and the throw itself would leak the code's length. */
  const a = Buffer.from(b.code.padEnd(128).slice(0, 128));
  const z2 = Buffer.from(REVIEW_CODE.padEnd(128).slice(0, 128));
  const codeOk = timingSafeEqual(a, z2);
  if (!emailOk || !codeOk) return fail(c, 401, "that code is not right");

  /* Only an address on the list reaches this line, so it is safe to sign in
     as whichever one was asked for. */
  const [owner] = await sql`
    insert into owners (email) values (${email})
    on conflict (email) do update set email = excluded.email returning *`;

  /* Same invite-to-membership step as the emailed link. There is no other way
     to come to hold a shop, here included. */
  const invites = await claimInvites(owner);

  const session = newToken();
  /* Short, unlike a shopkeeper's 60 days: a review takes a day. */
  await sql`insert into sessions (token, owner_id, expires_at)
            values (${store(session)}, ${owner.id}, now() + interval '7 days')`;
  return c.json({ token: session, owner: { id: owner.id, email: owner.email },
                  claimed: invites.length });
});

const needOwner = async (c) => {
  const o = await ownerFrom(c);
  if (!o) throw Object.assign(new Error("sign in first"), { status: 401 });
  return o;
};
const needShop = async (c, owner) => {
  const [shop] = await sql`select * from shops where slug = ${c.req.param("slug")}`;
  if (!shop) throw Object.assign(new Error("no such shop"), { status: 404 });
  if (!(await holdsShop(owner.id, shop.id)))
    throw Object.assign(new Error("that is not your shop"), { status: 403 });
  return shop;
};

/* Pick up any shop invited to this address since signing in, without having
   to sign in again. */
app.post("/v1/owner/claim", async (c) => {
  const owner = await needOwner(c);
  const claimed = await claimInvites(owner);
  return c.json({ claimed: claimed.length });
});

app.get("/v1/owner/shops", async (c) => {
  const owner = await needOwner(c);
  const rows = await sql`
    select s.slug, s.name, s.address, s.town, s.zip, s.hours, s.lat, s.lon,
           s.daily_cap, s.min_age, m.role,
           coalesce((select array_agg(a.aisle order by a.position, a.aisle)
                       from shop_aisles a where a.shop_id = s.id), '{}') as aisles
      from memberships m join shops s on s.id = m.shop_id
     where m.owner_id = ${owner.id} and s.active order by s.name`;
  /* Say who is asking. A client restoring a 60-day session has the token but
     not the address it belongs to, and it should not have to keep its own copy
     of that — this is the answer the server already knows. */
  return c.json({ owner: { id: owner.id, email: owner.email, name: owner.name },
                  shops: rows });
});

const PostIn = z.object({
  kind: z.enum(["sale", "arrival", "hours", "notice"]),
  name: z.string().min(1).max(120),
  aisle: z.string().max(40).optional(),
  note: z.string().max(200).optional(),
  gtin: z.string().regex(/^\d{8,14}$/).optional(),
  was_cents: z.number().int().min(0).max(10_000_00).optional(),
  now_cents: z.number().int().min(0).max(10_000_00).optional(),
  ends: z.string().max(60).optional(),
});

app.post("/v1/owner/shops/:slug/posts", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const body = parse(PostIn, await c.req.json());
  if (body.kind === "sale" && body.now_cents == null)
    return fail(c, 400, "a sale needs a price");
  const out = await publish(shop.id, body, owner.email);
  return c.json(out, 201);
});

app.get("/v1/owner/shops/:slug/posts", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const rows = await sql`
    select p.*,
           (select count(*) from deliveries d
             where d.post_id = p.id and d.withheld is null) as sent,
           (select count(*) from deliveries d
             where d.post_id = p.id and d.opened_at is not null) as opened
      from posts p where p.shop_id = ${shop.id}
     order by p.created_at desc limit 50`;
  return c.json({ posts: rows });
});

app.patch("/v1/owner/shops/:slug/posts/:id", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const { status } = parse(z.object({ status: z.enum(["active", "ended"]) }),
                           await c.req.json());
  const [p] = await sql`update posts set status = ${status}
     where id = ${c.req.param("id")} and shop_id = ${shop.id} returning id, status`;
  if (!p) return fail(c, 404, "no such post");
  return c.json(p);
});

app.get("/v1/owner/shops/:slug/reach", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const [reach] = await sql`select * from reach_for(${shop.id})`;
  const [week] = await sql`
    select count(*) as new_this_week from follows
     where shop_id = ${shop.id} and created_at > now() - interval '7 days'`;
  const aisles = await sql`
    select a.aisle, count(*) filter (where a.aisle = any (f.aisles)) as wanted
      from shop_aisles a left join follows f on f.shop_id = a.shop_id
     where a.shop_id = ${shop.id} group by a.aisle order by wanted desc`;
  return c.json({ ...reach, ...week, aisles });
});

app.get("/v1/owner/shops/:slug/catalog/:gtin", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const [item] = await sql`select name, aisle, was_cents, now_cents from catalog
     where shop_id = ${shop.id} and gtin = ${c.req.param("gtin")}`;
  return item ? c.json(item) : fail(c, 404, "not in this shop's catalogue yet");
});

/* ----------------------------------------------------------------- admin -- */
const guard = (c) => { if (!isAdmin(c))
  throw Object.assign(new Error("nope"), { status: 403 }); };

const ShopIn = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/),
  name: z.string().min(1).max(120),
  address: z.string().min(1).max(200),
  town: z.string().min(1).max(80),
  zip: z.string().regex(/^\d{5}$/),
  hours: z.string().max(80).optional(),
  daily_cap: z.number().int().min(1).max(10).default(3),
  aisles: z.array(z.string().max(40)).min(1).max(20),
  /* 21 for a liquor store. Null for everyone else. Set at creation because a
     shop that sells alcohol does so from its first post, not from whenever
     someone remembers to tick a box. */
  min_age: z.number().int().min(13).max(25).nullable().optional(),
});

/* Wiping everything, for a pilot that has gone round in circles.
 *
 * Two keys are needed, not one: the operator key AND an ALLOW_RESET flag in
 * the server's own settings. The key alone is not enough, because a key is a
 * string that gets pasted into phones and read off screens, and the blast
 * radius here is the whole business. The flag is turned on deliberately, used,
 * and turned off — so for all but a few minutes of its life, this route
 * answers 404 to everyone including its author.
 *
 * It truncates rather than drops: the schema, and so the shape of the thing,
 * is never at risk. */
app.post("/v1/admin/reset", async (c) => {
  if (!resetAllowed) return fail(c, 404, "not found");
  guard(c);
  /* The caller has to name what it is destroying. A reset that fires on an
     empty body is one stray request away from happening by accident. */
  const b = parse(z.object({ confirm: z.literal("RESET") }), await c.req.json());
  await sql`truncate
    shops, shop_aisles, devices, follows, posts, deliveries, owners,
    memberships, invites, login_links, sessions, catalog, device_claims
    restart identity cascade`;
  console.warn("[dealtitude] everything was reset on purpose:", b.confirm);
  return c.json({ reset: true });
});

app.post("/v1/admin/shops", async (c) => {
  guard(c);
  const b = parse(ShopIn, await c.req.json());
  const [shop] = await sql`
    insert into shops ${sql({
      slug: b.slug, name: b.name, address: b.address, town: b.town,
      zip: b.zip, hours: b.hours ?? null, daily_cap: b.daily_cap,
      min_age: b.min_age ?? null })}
    returning *`;
  await sql`insert into shop_aisles ${sql(
    b.aisles.map((aisle, position) => ({ shop_id: shop.id, aisle, position })))}`;
  return c.json({ shop }, 201);
});

/* Taking a shop down.
 *
 * Deactivating rather than deleting: a shop's posts, its followers and the
 * record of what was delivered are the only evidence of what actually happened
 * during the pilot, and a mistyped name at a counter should not be able to
 * destroy it. Deactivated shops vanish from every shopper-facing route, which
 * is the thing that was actually wanted. */
app.delete("/v1/admin/shops/:slug", async (c) => {
  guard(c);
  const [shop] = await sql`
    update shops set active = false where slug = ${c.req.param("slug")} returning slug, name`;
  if (!shop) return fail(c, 404, "no such shop");
  return c.json({ removed: shop.slug, name: shop.name });
});

app.post("/v1/admin/invites", async (c) => {
  guard(c);
  const b = parse(z.object({
    slug: z.string(), email: z.string().email(),
    role: z.enum(["owner", "staff"]).default("owner"),
  }), await c.req.json());
  const [shop] = await sql`select id from shops where slug = ${b.slug}`;
  if (!shop) return fail(c, 404, "no such shop");
  const token = newToken();
  await sql`insert into invites (token, shop_id, email, role, expires_at)
            values (${store(token)}, ${shop.id}, ${b.email}, ${b.role},
                    now() + interval '14 days')`;
  /* The invite is claimed by signing in with that address — the token is a
     record, not a key someone else could use. */
  return c.json({ invited: b.email, shop: b.slug,
                  instructions: "they sign in with this email and the shop is theirs" }, 201);
});

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port }, () =>
  console.log(`dealtitude api on :${port}  push=${pushConfigured ? "on" : "OFF"}`));

export default app;
