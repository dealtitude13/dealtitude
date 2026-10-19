import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { sql, healthy } from "./db.js";
import { zipPoint, milesBetween, knownZip } from "./geo.js";
import { publish } from "./publish.js";
import { publicKey, pushConfigured, backends } from "./push.js";
import {
  newToken, store, deviceFrom, ownerFrom, holdsShop, isAdmin, adminKeySet,
} from "./auth.js";
import {
  sendSignInLink, sendInviteLink, sendRecoveryConfirm, sendRestoreLink,
  mailConfigured,
} from "./mail.js";

/* Bumped by hand with each handoff, and reported by /v1/health. The app shows
   the same stamp on its first screen, so one look at each says whether the two
   halves actually match. */
const BUILD = "2026-10-18a";

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
    /* "did my migration run" answered without a shell. */
    schema: schemaState,
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
     where f.device_id = ${claim.device_id} and s.active`;
  return c.json({ device_id: claim.device_id, token, follows });
});

/* ----------------------------------------------- getting your follows back --
 * The same claim machinery as above, reached from an email instead of from the
 * address bar — which is what turns a one-off install trick into an answer to
 * "I got a new phone".
 *
 * Deliberately NOT an account. One optional address, no password, no name, and
 * no effect on anything a shop sees. A shopper who skips this loses nothing
 * they have today; a shopper who fills it in can get their follows back.
 *
 * Three rules hold this together:
 *   - Unverified is absent. A mistyped address must never receive somebody
 *     else's follows, and the person who mistyped it would never know.
 *   - The restore route is unauthenticated, because a new phone has nothing to
 *     authenticate with. So it must never confirm whether an address is known.
 *   - It sends mail to an address supplied by the caller, so it is rate
 *     limited well below the global ceiling.
 */

/* .trim() before .email(), not after: a phone keyboard adds a trailing space
   often enough that validating the raw string first turned an ordinary typing
   habit into "Invalid email address" with nothing on screen to explain it. */
const RecoveryIn = z.object({ email: z.string().trim().email().max(200) });

/** What this phone has set up, so Settings can show the real state. */
app.get("/v1/device/recovery", async (c) => {
  const d = await deviceFrom(c);
  if (!d) return fail(c, 401, "unknown device");
  return c.json({
    email: d.recovery_email || null,
    verified: Boolean(d.recovery_verified_at),
  });
});

/** Save or change the address, and send the confirmation that verifies it. */
app.post("/v1/device/recovery", async (c) => {
  const d = await deviceFrom(c);
  if (!d) return fail(c, 401, "unknown device");
  const b = parse(RecoveryIn, await c.req.json());
  const email = b.email.trim().toLowerCase();

  /* Re-saving the same address re-sends the confirmation rather than silently
     doing nothing — "it never arrived" is the common case, not a changed mind.
     A fresh token each time means the previous email stops working, which is
     what you want if the first one went to the wrong place. */
  const token = newToken();
  await sql`update devices
               set recovery_email = ${email},
                   recovery_verified_at = null,
                   recovery_token_hash = ${store(token)},
                   recovery_sent_at = now()
             where id = ${d.id}`;

  /* Built from this server's own address rather than the website's, so
     confirming needs no new page deployed anywhere — the route below answers
     with a small page of its own. */
  const origin = (() => {
    try { return new URL(c.req.url).origin; } catch { return process.env.APP_URL || ""; }
  })();
  const link = `${origin}/v1/device/recovery/verify?t=${token}`;
  const mail = await sendRecoveryConfirm(email, link);

  /* Same reasoning as the owner sign-in route: the link comes back in the body
     only on a server with no mail sender that is not production, so a pilot can
     run before the mail domain is verified. */
  const showLink = !mailConfigured && process.env.NODE_ENV !== "production";
  return c.json({ ok: true, email, sent: mail.sent, can_send: mailConfigured,
                  ...(showLink ? { link } : {}) });
});

/** Stop keeping the address. Everything else about the phone is untouched. */
app.delete("/v1/device/recovery", async (c) => {
  const d = await deviceFrom(c);
  if (!d) return fail(c, 401, "unknown device");
  await sql`update devices
               set recovery_email = null, recovery_verified_at = null,
                   recovery_token_hash = null, recovery_sent_at = null
             where id = ${d.id}`;
  return c.json({ ok: true });
});

/* Tapping the confirmation. A GET, because it is a link in an email, and the
   only thing it changes is this one flag — there is nothing here worth a
   cross-site request. Single use: the token is spent on arrival. */
app.get("/v1/device/recovery/verify", async (c) => {
  const t = c.req.query("t") || "";
  const [d] = t ? await sql`
    update devices
       set recovery_verified_at = now(), recovery_token_hash = null
     where recovery_token_hash = ${store(t)}
       and recovery_sent_at > now() - interval '7 days'
     returning id, recovery_email` : [];

  /* A person is looking at this in a mail app's browser, so it answers in
     words rather than JSON. Nothing here needs the app to be installed. */
  const page = (head, body) => c.html(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dealtitude</title></head>
<body style="margin:0;padding:28px 18px;background:#F5EFE4;
  font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1A1410">
<div style="max-width:420px;margin:40px auto;background:#FFFDF8;border:1px solid #DED3C2;
  border-radius:14px;padding:26px 22px;text-align:center">
  <div style="font-size:12px;font-weight:700;letter-spacing:.09em;color:#7A6E62;
    text-transform:uppercase">Dealtitude</div>
  <div style="font-size:21px;font-weight:800;margin:14px 0 10px;letter-spacing:-.02em">${head}</div>
  <div style="font-size:15px;line-height:1.55;color:#7A6E62">${body}</div>
</div></body></html>`, d ? 200 : 404);

  if (!d) {
    return page("That link has expired",
      "Open Dealtitude, go to the You tab and save your email again — a fresh " +
      "link will arrive in a moment.");
  }
  return page("Your follows are protected",
    "If you ever change phones, ask for a restore link at this address and the " +
    "shops you follow will come back. You can close this page.");
});

/**
 * The new phone. Unauthenticated by necessity, so it is careful.
 *
 * Always answers the same way whether or not the address is known. The code it
 * creates is the ordinary claim code: short-lived, single use, and worth only
 * the follows of the phone that address belongs to.
 */
const restoreHits = new Map();
app.post("/v1/device/restore", async (c) => {
  const b = parse(RecoveryIn, await c.req.json());
  const email = b.email.trim().toLowerCase();

  /* Per-address, not per-IP: the thing being protected is somebody's inbox,
     and a shared network should not stop a second person restoring. */
  const now = Date.now();
  const rec = restoreHits.get(email) || { n: 0, until: now + 3_600_000 };
  if (now > rec.until) { rec.n = 0; rec.until = now + 3_600_000; }
  rec.n++; restoreHits.set(email, rec);
  if (restoreHits.size > 5000) restoreHits.clear();
  /* Still a 200. A 429 here would confirm the address exists. */
  if (rec.n > Number(process.env.RESTORE_PER_HOUR || 5)) return c.json({ ok: true });

  /* The most recently used phone with that address. More than one is normal —
     someone who did this on an old phone and again on its replacement — and
     the newest is the one with the follows they expect. */
  const [d] = await sql`
    select id from devices
     where lower(recovery_email) = ${email}
       and recovery_verified_at is not null
     order by last_seen_at desc
     limit 1`;
  if (!d) return c.json({ ok: true });              // says nothing either way

  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const code = Array.from(randomBytes(10))
    .map((n) => alphabet[n % alphabet.length]).join("");
  await sql`insert into device_claims (code, device_id, expires_at)
            values (${code}, ${d.id}, now() + interval '2 hours')`;

  /* The app reads a claim code out of the hash already — the same path the
     home-screen handoff uses — so this link needs no new handling in the app.

     The code is sent in the clear beside the link on purpose. Someone who has
     already installed the app from the App Store would otherwise tap the link
     and land in Safari instead of in the app they are holding; typing ten
     characters into the You tab gets them there with no deep-link setup. */
  await sendRestoreLink(email, `${process.env.APP_URL || ""}/#c=${code}`, code);
  return c.json({ ok: true });
});

/* ------------------------------------------------------ deleting yourself --
 * A shopper erasing their own record.
 *
 * Required by the App Store, and right anyway: the app created this record
 * without ever asking anyone to sign up, so it has to be removable without
 * asking anyone to get in touch.
 *
 * What goes: the device row, and by cascade every follow, every aisle choice,
 * every item they asked for, and any outstanding restore code. The recovery
 * address goes with the row.
 *
 * What stays: the delivery rows, detached. They are the shops' record of how
 * many phones an announcement reached, and that number is not the shopper's to
 * take away — but with device_id set to NULL there is nothing in it that points
 * at a person, and no query that reads the ledger as a shopper can match it.
 */
app.delete("/v1/me", async (c) => {
  const d = await deviceFrom(c);
  /* An unknown token is the state someone is asking for, so it is a success.
     Reporting 401 here would leave a shopper who tapped twice believing their
     data is still somewhere. */
  if (!d) return c.json({ deleted: true, follows: 0, wants: 0 });

  const [counts] = await sql`
    select (select count(*) from follows where device_id = ${d.id}) as follows,
           (select count(*) from wants   where device_id = ${d.id}) as wants`;

  await sql`delete from devices where id = ${d.id}`;
  console.log(`[delete] device ${d.id} removed at its own request`);
  return c.json({ deleted: true,
                  follows: Number(counts.follows),
                  wants: Number(counts.wants) });
});

/* An owner closing their account.
 *
 * Their shops are NOT deleted. A shop exists on the platform independently of
 * whoever happens to run it: a shopkeeper handing the business on, or walking
 * away from it, must not take its followers with them. The membership is what
 * goes, so the shop reverts to having nobody running it and can be invited to
 * someone else — which is exactly what happens before its first owner accepts.
 */
app.delete("/v1/owner/me", async (c) => {
  const owner = await ownerFrom(c);
  if (!owner) return c.json({ deleted: true, shops: 0 });

  const [counts] = await sql`
    select (select count(*) from memberships where owner_id = ${owner.id}) as shops`;

  /* Sessions and memberships cascade from the owner row. Invites written to
     that address are cleared too, or the next person to sign in with it would
     silently inherit shops the previous holder had been invited to. */
  await sql`delete from invites where email = ${owner.email} and accepted_at is null`;
  await sql`delete from login_links where email = ${owner.email}`;
  await sql`delete from owners where id = ${owner.id}`;
  console.log(`[delete] owner ${owner.email} closed their account`);
  return c.json({ deleted: true, shops: Number(counts.shops) });
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

/* Shops near a ZIP, by actual distance.
 *
 * This used to return every shop whose zip column matched the string typed in,
 * and the app drew a distance from an invented coordinate system — so a shop
 * 42 miles away could be listed as "within five miles" the moment anything
 * else put it on the screen. Distance is now computed here, from Census ZCTA
 * centroids, and a shop with no coordinates is never given one.
 *
 * radius is in miles, defaults to 5, and is capped so this cannot be turned
 * into "every shop in the country" by editing a URL. */
app.get("/v1/shops", async (c) => {
  const zip = (c.req.query("zip") || "").trim();
  if (!/^\d{5}$/.test(zip)) return fail(c, 400, "a 5-digit zip is required");

  const here = zipPoint(zip);
  if (!here) return fail(c, 404, "that zip code isn't one we can place on a map");

  const asked = Number(c.req.query("radius"));
  const radius = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 50) : 5;

  const rows = await sql`
    select ${shopShape}, s.lat, s.lon,
           coalesce((select array_agg(a.aisle order by a.position, a.aisle)
                       from shop_aisles a where a.shop_id = s.id), '{}') as aisles,
           (select count(*) from follows f where f.shop_id = s.id) as followers
      from shops s where s.active`;

  const near = [];
  let unplaceable = 0;
  for (const s of rows) {
    const mi = milesBetween(here, { lat: s.lat, lon: s.lon });
    if (mi == null) {
      /* No coordinates: it may still be the shop they are looking for if the
         ZIP matches exactly, but it is never claimed to be a distance away. */
      if (s.zip === zip) near.push({ ...s, miles: null });
      else unplaceable++;
      continue;
    }
    if (mi <= radius) near.push({ ...s, miles: Math.round(mi * 10) / 10 });
  }
  near.sort((a, b) => (a.miles ?? 1e9) - (b.miles ?? 1e9) || a.name.localeCompare(b.name));

  /* Shops this phone follows that fall OUTSIDE the radius, with their true
     distance from the ZIP just searched.
     
     The app has to keep a followed shop reachable — losing sight of one reads
     as a lost follow — but it has no geography of its own to measure with, and
     giving it any would be how invented distances crept back in. So the answer
     comes from here, in the same request, under its own key: a separate list
     the app can show under a separate heading, never counted as nearby. */
  const device = await deviceFrom(c);
  let followedOutside = [];
  if (device) {
    const inList = new Set(near.map((s) => s.id));
    const followed = await sql`
      select ${shopShape}, s.lat, s.lon,
             coalesce((select array_agg(a.aisle order by a.position, a.aisle)
                         from shop_aisles a where a.shop_id = s.id), '{}') as aisles,
             (select count(*) from follows f2 where f2.shop_id = s.id) as followers
        from follows f join shops s on s.id = f.shop_id
       where f.device_id = ${device.id} and s.active`;
    followedOutside = followed
      .filter((s) => !inList.has(s.id))
      .map((s) => ({ ...s, miles: (() => {
        const mi = milesBetween(here, { lat: s.lat, lon: s.lon });
        return mi == null ? null : Math.round(mi * 10) / 10;
      })() }))
      .sort((a, b) => (a.miles ?? 1e9) - (b.miles ?? 1e9));
  }

  return c.json({ shops: near, zip, radius,
                  followed_outside: followedOutside,
                  /* Said plainly so the app can explain an empty list rather
                     than implying there are no shops anywhere. */
                  unplaceable });
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
         /* Also checked here, not only by the sweep: a shopper must never be
            shown a sale that has already run out, however recently it did. */
         and (ends_at is null or ends_at > now())
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
  /* Filtered on active: a shop taken off the app cannot be followed. Without
     it the Follow button worked on a shop that no longer existed, the follow
     was recorded, and the next screen said "no such shop" — the app arguing
     with itself in front of the person using it. */
  const [shop] = await sql`
    select id from shops where slug = ${c.req.param("slug")} and active`;
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
  /* NOT filtered on active, on purpose: unfollowing is how a phone tidies up
     after a shop that has gone, and refusing it would strand the row. */
  const [shop] = await sql`select id from shops where slug = ${c.req.param("slug")}`;
  if (!shop) return fail(c, 404, "no such shop");
  await sql`delete from follows where device_id = ${device.id} and shop_id = ${shop.id}`;
  return c.json({ following: false });
});

/* ------------------------------------------------------------------ wants ---
 * An item a shopper is hoping to see, in their own words. Three things make
 * this different from picking an aisle, and all three are why it replaced a
 * second copy of the aisle list:
 *
 *   it is an ITEM, so the owner learns something he does not already know;
 *   it is counted across shoppers, so "6 waiting on Kaju Katli" is a fact;
 *   it earns a standing alert for that item, which outranks the aisle filter.
 *
 * Asking implies following — you cannot be told about the thing you asked for
 * otherwise — so the POST creates the follow if it isn't there. It never
 * touches the aisles of a follow that already exists: a want is an addition to
 * what someone chose, never a quiet edit of it. */

const WantIn = z.object({
  label: z.string().min(2).max(80),
  aisle: z.string().max(40).optional(),
  alert: z.boolean().optional(),
});

/** The list, plus what this device asked for, plus something to autocomplete
    against. Device auth is optional — a browsing shopper still sees the
    counts, which is most of the reason to leave an ask at all. */
app.get("/v1/shops/:slug/wants", async (c) => {
  const [shop] = await sql`
    select id from shops where slug = ${c.req.param("slug")} and active`;
  if (!shop) return fail(c, 404, "no such shop");

  const wants = await sql`select * from wants_for(${shop.id})`;

  /* Autocomplete source: what this shop has actually posted before. Offering
     the shop's own catalogue is what keeps forty spellings of one item from
     becoming forty separate asks nobody can count. */
  const suggest = await sql`
    select distinct on (norm_item(name)) name as label, aisle
      from catalog where shop_id = ${shop.id}
     order by norm_item(name), updated_at desc limit 60`;

  const device = await deviceFrom(c);
  const mine = device
    ? await sql`select norm, label, aisle, alert from wants
                 where shop_id = ${shop.id} and device_id = ${device.id}
                   and filled_at is null`
    : [];
  return c.json({ wants, suggest, mine });
});

app.post("/v1/shops/:slug/wants", async (c) => {
  const device = await need(c);
  const b = parse(WantIn, await c.req.json());
  const [shop] = await sql`
    select id, min_age from shops where slug = ${c.req.param("slug")} and active`;
  if (!shop) return fail(c, 404, "no such shop");
  /* Same gate as following, for the same reason: an ask that turns into an
     alert is a subscription, and the age bar is on the subscription. */
  if (!oldEnough(device, shop))
    return fail(c, 403, "confirm your age before asking this shop for something");

  const [{ norm }] = await sql`select norm_item(${b.label}) as norm`;
  if (!norm) return fail(c, 400, "say what you're hoping to see");

  /* Only an aisle this shop has; otherwise leave it null and let the owner
     file it when he posts. A wrong aisle on a want would route the eventual
     alert at the wrong people. */
  let aisle = null;
  if (b.aisle) {
    const [has] = await sql`
      select 1 from shop_aisles where shop_id = ${shop.id} and aisle = ${b.aisle}`;
    if (has) aisle = b.aisle;
  }
  /* Nothing chosen: infer it from the shop's own catalogue, which is where the
     suggestion most likely came from. */
  if (!aisle) {
    const [guess] = await sql`
      select aisle from catalog
       where shop_id = ${shop.id} and norm_item(name) = ${norm} and aisle is not null
       limit 1`;
    if (guess) aisle = guess.aisle;
  }

  await sql`
    insert into follows (device_id, shop_id, aisles)
    values (${device.id}, ${shop.id}, '{}')
    on conflict (device_id, shop_id) do nothing`;

  await sql`
    insert into wants (shop_id, device_id, label, norm, aisle, alert)
    values (${shop.id}, ${device.id}, ${b.label.trim()}, ${norm}, ${aisle},
            ${b.alert ?? true})
    on conflict (shop_id, device_id, norm) do update
      set label = excluded.label, aisle = coalesce(excluded.aisle, wants.aisle),
          alert = excluded.alert, filled_at = null`;

  const [row] = await sql`
    select norm, label, shoppers, aisle from wants_for(${shop.id}) where norm = ${norm}`;
  return c.json({ asked: true, want: row }, 201);
});

app.delete("/v1/shops/:slug/wants/:norm", async (c) => {
  const device = await need(c);
  const [shop] = await sql`select id from shops where slug = ${c.req.param("slug")}`;
  if (!shop) return fail(c, 404, "no such shop");
  const [{ norm }] = await sql`select norm_item(${c.req.param("norm")}) as norm`;
  await sql`delete from wants
             where shop_id = ${shop.id} and device_id = ${device.id} and norm = ${norm}`;
  const [row] = await sql`
    select norm, label, shoppers from wants_for(${shop.id}) where norm = ${norm}`;
  return c.json({ asked: false, want: row || null });
});

app.get("/v1/me/follows", async (c) => {
  const device = await need(c);
  const rows = await sql`
    select s.slug, s.name, s.address, s.town, s.zip, s.hours, s.daily_cap,
           s.min_age, f.aisles, f.muted
      from follows f join shops s on s.id = f.shop_id
     where f.device_id = ${device.id} and s.active order by s.name`;
  return c.json({ follows: rows });
});

/* ------------------------------------------------- what reached this phone --
 * The Alerts tab used to be filled by the demo walkthrough and by nothing else
 * — in the live app `setInbox` was never called, so it promised "anything a
 * shop you follow sends will appear here" and then showed an empty screen
 * forever.
 *
 * The data was already here. Every send is written to `deliveries`, which is
 * the same ledger the owner's "sent" counts come from. This is that ledger from
 * the other end.
 *
 * Only what actually WENT is listed. Rows withheld by the aisle filter or the
 * daily cap are deliberately left out: a shopper reading "we decided not to
 * tell you about this" is being shown a decision they did not ask to see, and
 * it invites exactly the question the cap exists to avoid. */
app.get("/v1/me/alerts", async (c) => {
  const device = await need(c);
  const rows = await sql`
    select d.sent_at, d.opened_at,
           p.id as post_id, p.kind, p.aisle, p.name, p.note,
           p.was_cents, p.now_cents, p.status,
           s.slug, s.name as shop_name, s.active as shop_live
      from deliveries d
      join posts p on p.id = d.post_id
      /* Deliberately NOT joined on s.active.
         This is the shopper's own record of what was sent to their phone, and
         taking a shop off the app is not a reason to erase it. The filter used
         to be here, which meant a shop being removed silently emptied the
         Alerts tab of every alert it had ever sent — alerts kept arriving and
         the screen stayed blank for good, with nothing to explain it. The
         shop's name is still shown; only its listing is gone. */
      join shops s on s.id = d.shop_id
     where d.device_id = ${device.id} and d.withheld is null
     order by d.sent_at desc limit 50`;
  return c.json({ alerts: rows });
});

app.get("/v1/me/feed", async (c) => {
  const device = await need(c);
  const rows = await sql`
    select p.id, p.kind, p.aisle, p.name, p.note, p.was_cents, p.now_cents,
           p.ends, p.ends_at, p.status, p.created_at, s.slug, s.name as shop_name
      from posts p
      join follows f on f.shop_id = p.shop_id and f.device_id = ${device.id}
      /* Joined on active: a shop taken off the app stops reaching the phones
         that follow it, feed included. Its posts are kept, so a restore brings
         them back. Backticks are deliberately absent from this comment — it
         sits inside a template literal, where one would end the query. */
      join shops s on s.id = p.shop_id and s.active
       /* Live posts, plus the ones that have just ended.
          A sale vanishing the moment it expires leaves a shopper unable to
          tell "it's over" from "I imagined it" — and they ask the shop, which
          is the shop's problem then. Two days of ended posts, marked as ended,
          answers it. The app renders anything not active as plainly over; the
          one thing this must never cause is somebody walking to a shop for a
          sale that finished yesterday, so the status travels with the row and
          the screen leads with it. */
     where (
         (p.status = 'active' and (p.ends_at is null or p.ends_at > now()))
         or coalesce(p.ends_at, p.created_at) > now() - interval '2 days'
       )
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

  /* can_send says whether this server has a mail sender AT ALL. It is about
     the server, not about the address, so it leaks nothing — and without it
     the app can only say "check your inbox" to someone whose inbox will never
     receive anything, which is the single most confusing thing it can say.

     The link itself still never leaves a production server: handing one to
     whoever types an address would be a way to sign in as any owner. */
  return c.json({ sent: mail.sent, can_send: mailConfigured,
                  ...(showLink ? { link } : {}) });
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
  /* Filtered on active here too: an owner whose shop was taken down must not
     read its reach or list its posts, any more than they can post to it. */
  const [shop] = await sql`
    select * from shops where slug = ${c.req.param("slug")} and active`;
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
  /* What the owner typed, for reading. */
  ends: z.string().max(60).optional(),
  /* The same moment as an instant, for the clock. The phone converts the
     shopkeeper's local "9pm today" before sending, so a shop expires at its
     own closing time rather than at UTC's. */
  ends_at: z.string().datetime({ offset: true }).optional(),
});

app.post("/v1/owner/shops/:slug/posts", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const body = parse(PostIn, await c.req.json());
  if (body.kind === "sale" && body.now_cents == null)
    return fail(c, 400, "a sale needs a price");
  /* Publishing something already over would alert every follower about a sale
     they cannot use, and the sweep would mark it expired moments later. */
  if (body.ends_at && new Date(body.ends_at) <= new Date())
    return fail(c, 400, "that end time has already passed");
  const out = await publish(shop.id, body, owner.email);
  return c.json(out, 201);
});

app.get("/v1/owner/shops/:slug/posts", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  /* Expire before reading. The sweep below runs on a timer, but a read must
     never be able to show a sale as live when its own end time has passed —
     the timer being a minute behind is not a reason to tell a shopkeeper
     something untrue about their own shelf. */
  await sql`select expire_due_posts()`;
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

/* Editing a post, or taking it down, through one route.
 *
 * A mistyped price used to mean deleting the post and writing it again, which
 * alerts every follower a second time for the same item. Correcting it must
 * not cost the shop its goodwill — so an edit NEVER re-sends. The alert went
 * when it went; this changes what the app shows from here on.
 *
 * The kind and the aisle are deliberately NOT editable: they decided who was
 * told. Changing them after the fact would leave a post in front of people it
 * was never sent to, and absent from the ones it was. A different audience is
 * a different post. */
const PostEdit = z.object({
  status:    z.enum(["active", "ended"]).optional(),
  name:      z.string().min(2).max(80).optional(),
  note:      z.string().max(300).nullable().optional(),
  was_cents: z.number().int().min(0).nullable().optional(),
  now_cents: z.number().int().min(0).nullable().optional(),
  ends:      z.string().max(60).nullable().optional(),
  ends_at:   z.string().datetime({ offset: true }).nullable().optional(),
});

app.patch("/v1/owner/shops/:slug/posts/:id", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const b = parse(PostEdit, await c.req.json());

  const [before] = await sql`
    select * from posts where id = ${c.req.param("id")} and shop_id = ${shop.id}`;
  if (!before) return fail(c, 404, "no such post");

  const patch = {};
  for (const k of ["name", "note", "was_cents", "now_cents", "ends"]) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  if (b.ends_at !== undefined) patch.ends_at = b.ends_at ? new Date(b.ends_at) : null;

  /* A sale without a price is not a sale. */
  const nowCents = patch.now_cents !== undefined ? patch.now_cents : before.now_cents;
  if (before.kind === "sale" && nowCents == null)
    return fail(c, 400, "a sale needs a price");

  if (b.status !== undefined) {
    /* Putting an expired post back on the shelf needs a future end time, or it
       expires again on the next sweep and the owner is left pressing a button
       that appears to do nothing. */
    if (b.status === "active") {
      const endsAt = patch.ends_at !== undefined ? patch.ends_at : before.ends_at;
      if (endsAt && new Date(endsAt) <= new Date())
        return fail(c, 400, "give it a new end time before putting it back on");
    }
    patch.status = b.status;
  }

  if (!Object.keys(patch).length) return c.json(before);

  const [p] = await sql`
    update posts set ${sql(patch)} where id = ${before.id} returning *`;
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

/* Real demand, most-wanted first. The panel this feeds used to read the
   shopper app's own local state, so an owner was shown his own taps. */
app.get("/v1/owner/shops/:slug/wants", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const wants = await sql`select * from wants_for(${shop.id})`;
  const [filled] = await sql`
    select count(*) as filled from wants
     where shop_id = ${shop.id} and filled_at > now() - interval '30 days'`;
  return c.json({ wants, ...filled });
});

/* ------------------------------------------- the shop's own details --------
 * There was no way to change a shop after it was created. A mistyped address
 * or a change of hours meant removing the shop and adding it again, which is
 * drastic for a typo and takes the shop off the app in between.
 *
 * The slug is NOT editable: it is the address on a printed counter card, and
 * changing it would turn every card already in a customer's pocket into a dead
 * link. The ZIP moves the shop on the map, so it is re-placed when it changes. */
const ShopEdit = z.object({
  name:      z.string().min(2).max(80).optional(),
  address:   z.string().min(2).max(120).optional(),
  town:      z.string().min(2).max(60).optional(),
  zip:       z.string().regex(/^\d{5}$/).optional(),
  hours:     z.string().max(80).nullable().optional(),
  phone:     z.string().max(32).nullable().optional(),
  note:      z.string().max(280).nullable().optional(),
  daily_cap: z.number().int().min(1).max(10).optional(),
  aisles:    z.array(z.string().min(1).max(40)).max(24).optional(),
});

app.patch("/v1/owner/shops/:slug", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);          // membership is checked here
  const b = parse(ShopEdit, await c.req.json());

  const patch = {};
  for (const k of ["name", "address", "town", "zip", "hours", "phone", "note", "daily_cap"]) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  /* Moved town: put it back on the map, or distance silently keeps measuring
     from where it used to be. */
  if (patch.zip && patch.zip !== shop.zip) {
    const at = zipPoint(patch.zip);
    patch.lat = at?.lat ?? null;
    patch.lon = at?.lon ?? null;
  }
  if (Object.keys(patch).length) {
    patch.updated_at = new Date();
    await sql`update shops set ${sql(patch)} where id = ${shop.id}`;
  }

  /* Aisles are a list, so they are replaced wholesale — but only the ones that
     actually changed, because dropping an aisle a follower has switched on is
     a thing to do deliberately rather than as a side effect of renaming the
     shop. The follow rows keep their aisle names; an aisle that no longer
     exists simply never matches a post again. */
  if (b.aisles) {
    const want = [...new Set(b.aisles.map((x) => x.trim()).filter(Boolean))];
    if (!want.length) return fail(c, 400, "a shop needs at least one aisle");
    await sql`delete from shop_aisles where shop_id = ${shop.id}`;
    await sql`insert into shop_aisles ${sql(
      want.map((aisle, position) => ({ shop_id: shop.id, aisle, position })))}`;
  }

  const [fresh] = await sql`select * from shops where id = ${shop.id}`;
  const aisles = (await sql`
    select aisle from shop_aisles where shop_id = ${shop.id} order by position`)
    .map((r) => r.aisle);
  return c.json({ shop: { ...fresh, aisles } });
});

/* The owner's own name, which is all there is to an account here: sign-in is a
   emailed link, so there is no password to change and nothing else stored. */
app.patch("/v1/owner/me", async (c) => {
  const owner = await needOwner(c);
  const b = parse(z.object({ name: z.string().min(1).max(80).nullable() }),
                  await c.req.json());
  const [me] = await sql`
    update owners set name = ${b.name} where id = ${owner.id}
    returning id, email, name`;
  return c.json({ owner: me });
});

/* ------------------------------------------- moderating the ask list -------
 * Scoped to this shop by construction: a want row belongs to one shop and one
 * device, so hiding by (shop, norm) cannot touch another shop's list. The same
 * shopper asking the same thing of a different shop keeps it. Hidden rather
 * than deleted so the same device cannot simply re-add it a moment later. */
app.delete("/v1/owner/shops/:slug/wants/:norm", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const [{ norm }] = await sql`select norm_item(${c.req.param("norm")}) as norm`;
  if (!norm) return fail(c, 400, "nothing to remove");
  const rows = await sql`
    update wants set hidden_at = now(), alert = false
     where shop_id = ${shop.id} and norm = ${norm} and hidden_at is null
     returning id`;
  if (!rows.length) return fail(c, 404, "that is not on this shop's list");
  return c.json({ removed: norm, shoppers: rows.length });
});

/* ------------------------------------------------ what has happened --------
 * Derived from rows that already carry their own timestamps rather than from a
 * separate log: posts published, followers arriving, items asked for. The old
 * version of this panel was built in the browser from whatever that session
 * happened to see, so it showed one person their own actions and forgot them
 * on reload.
 *
 * What this cannot show is an edit or a take-down, because nothing records
 * when those happened — only the current state is stored. Rather than invent a
 * plausible-looking line for them, they are simply absent. */
app.get("/v1/owner/shops/:slug/activity", async (c) => {
  const owner = await needOwner(c);
  const shop = await needShop(c, owner);
  const rows = await sql`
    (select 'post' as type, p.created_at as at, p.name as what,
            p.kind as detail, p.status as extra
       from posts p where p.shop_id = ${shop.id}
       order by p.created_at desc limit 40)
    union all
    (select 'follow', f.created_at, null, null, null
       from follows f where f.shop_id = ${shop.id}
       order by f.created_at desc limit 40)
    union all
    (select 'want', w.created_at, w.label, w.aisle, null
       from wants w where w.shop_id = ${shop.id} and w.hidden_at is null
       order by w.created_at desc limit 40)
    order by at desc limit 40`;

  /* Requests the owner took off their own list.
   *
   * Hiding one removed it from every screen the owner had, which made a
   * dismissed request indistinguishable from one that was never made — and the
   * shopper still has theirs, so the two sides disagreed with nothing on
   * either screen to explain why. Counted and named here instead, so a
   * decision stays visible to whoever made it.
   *
   * Grouped by norm, like the live list, so one dismissal covers every
   * spelling of the same item rather than appearing once per shopper. */
  const removed = await sql`
    select w.norm,
           (array_agg(w.label order by w.hidden_at desc))[1] as label,
           count(*)             as shoppers,
           max(w.hidden_at)     as at
      from wants w
     where w.shop_id = ${shop.id} and w.hidden_at is not null
     group by w.norm
     order by max(w.hidden_at) desc
     limit 30`;

  return c.json({ activity: rows, removed });
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

  /* A shop taken off the app keeps its row, so it keeps its name — and the
     name is derived from the shop's own name, so re-adding that shop failed
     with "already exists" and nothing in the app could bring it back. The
     only cure was a database. Standing in a shop you took down by mistake,
     "add it again" plainly means "put it back", so that is what this does. */
  const [existing] = await sql`
    select id, active from shops where slug = ${b.slug}`;

  if (existing?.active) {
    return fail(c, 409, "that shop is already on the app");
  }

  /* Place it on the map at creation, from its own ZIP's centroid. Without
     this a shop has no coordinates, and anything that tries to measure a
     distance to it has to either invent one or admit it cannot — the first of
     which is what went wrong. */
  const at = zipPoint(b.zip);
  const fields = {
    name: b.name, address: b.address, town: b.town, zip: b.zip,
    hours: b.hours ?? null, daily_cap: b.daily_cap, min_age: b.min_age ?? null,
    lat: at?.lat ?? null, lon: at?.lon ?? null,
  };

  if (existing) {
    /* Back on, with whatever details were just typed in — they are fresher
       than the ones it went down with. Its posts and followers were never
       deleted, so they come back with it. */
    const [shop] = await sql`
      update shops set ${sql({ ...fields, active: true })}
       where id = ${existing.id} returning *`;
    await sql`delete from shop_aisles where shop_id = ${shop.id}`;
    await sql`insert into shop_aisles ${sql(
      b.aisles.map((aisle, position) => ({ shop_id: shop.id, aisle, position })))}`;
    return c.json({ shop, restored: true }, 200);
  }

  const [shop] = await sql`
    insert into shops ${sql({ slug: b.slug, ...fields })} returning *`;
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
  /* The name as well as the id: it goes in the subject line of the first email
     this shopkeeper ever gets from us, and "undefined is ready on Dealtitude"
     is not a first impression you recover from. */
  const [shop] = await sql`select id, name from shops where slug = ${b.slug}`;
  if (!shop) return fail(c, 404, "no such shop");
  const token = newToken();
  await sql`insert into invites (token, shop_id, email, role, expires_at)
            values (${store(token)}, ${shop.id}, ${b.email}, ${b.role},
                    now() + interval '14 days')`;

  /* And actually send it.
   *
   * This route used to create the row and return advice. Nothing reached the
   * owner, and from the outside that is indistinguishable from mail being
   * broken — the operator is told the invite was sent and the shopkeeper's
   * inbox stays empty. An invite that is not delivered is not an invite.
   *
   * The link is a login link for that address, so opening it proves the
   * address and claims the invite by the same path as any other sign-in. No
   * new kind of credential, and nothing a forwarded copy could do that the
   * address holder could not already do. */
  const linkToken = newToken();
  const DAYS = 7;
  await sql`insert into login_links (token, email, expires_at)
            values (${store(linkToken)}, ${b.email},
                    now() + interval '7 days')`;
  const link = `${process.env.APP_URL || ""}/owner?token=${linkToken}`;
  const mail = await sendInviteLink(b.email, link, shop.name, DAYS);

  /* The caller already holds the operator key and chose this address a moment
     ago, so handing the link back when mail did not go grants them nothing —
     and it is the difference between a pilot that continues and one that waits
     on DNS. Never included when the mail actually went. */
  return c.json({
    invited: b.email, shop: b.slug, mail,
    ...(mail.sent ? {} : { link }),
    instructions: mail.sent
      ? "they have been emailed a link to their shop"
      : "mail is not sending — pass them this link yourself",
  }, 201);
});

/* Place any shop that has no coordinates yet.
 *
 * Shops created before distance existed carry no lat/lon, and a shop without
 * them can only be found by an exact ZIP match — it is never offered to a
 * search by distance. Doing it here means an existing pilot shop starts
 * working the moment this deploys, with nothing to run by hand. Cheap, and a
 * no-op on every boot after the first. */
async function placeUnplacedShops() {
  try {
    const rows = await sql`select id, zip from shops where lat is null`;
    let placed = 0;
    for (const r of rows) {
      const at = zipPoint(r.zip);
      if (!at) continue;
      await sql`update shops set lat = ${at.lat}, lon = ${at.lon} where id = ${r.id}`;
      placed++;
    }
    if (placed) console.log(`[geo] placed ${placed} shop(s) from their ZIP`);
  } catch (e) {
    /* Never block startup on this: the app works without it, shops just stay
       findable by exact ZIP only. */
    console.error("[geo] could not place shops:", e.message);
  }
}
/* Apply the schema on boot.
 *
 * schema.sql is idempotent all the way through — create-if-not-exists,
 * create-or-replace, and one authoritative list for each constraint — so
 * running it every boot is a no-op after the first and costs a few hundred
 * milliseconds.
 *
 * It is here rather than left to `npm run migrate` because the alternative is
 * a deploy where the code is new and the database is not: the `wants` table
 * would be missing, every shop page would 500 on its "hoping for something
 * else" list, and the only clue would be a stack trace in a log nobody is
 * watching. Whoever deploys this should not have to know which release needed
 * a migration.
 *
 * A failure must be loud but must not stop the server: an owner locked out of
 * a working app is worse than one running on yesterday's schema. /v1/health
 * reports it either way, which is the one place to look. */
let schemaState = "pending";
async function applySchema() {
  try {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    await sql.unsafe(readFileSync(join(here, "../db/schema.sql"), "utf8"));
    schemaState = "ok";
    console.log("[schema] applied");
  } catch (e) {
    schemaState = `failed: ${e.message}`;
    console.error("[schema] COULD NOT APPLY —", e.message);
    console.error("[schema] the server is still serving, on whatever schema "
                + "the database already had. /v1/health says so.");
  }
}
export const schemaStatus = () => schemaState;

/* Posts end by themselves.
 *
 * Checked on every read as well, because a timer that is a minute behind must
 * never be the reason a shopper is shown a sale that is over. This exists so
 * the status is also correct when NOBODY is reading — the owner's list, the
 * ledger and anything looking at the table directly all see the truth without
 * someone having to open the app first. */
/* A minute is a good trade: the read-time check already means nobody is ever
   SHOWN something stale, so this only decides how quickly the stored status
   catches up for anyone reading the table directly. Overridable so a test can
   prove the timer fires without sitting for a minute to watch it. */
const SWEEP_MS = Math.max(200, Number(process.env.POSTS_SWEEP_MS) || 60_000);
async function sweepExpired() {
  try {
    const [{ expire_due_posts: n }] = await sql`select expire_due_posts()`;
    if (n > 0) console.log(`[posts] ${n} expired`);
  } catch (e) {
    /* Never let this kill the process: a missed sweep is a minute of staleness
       that the read-time check already covers. */
    console.error("[posts] sweep failed:", e.message);
  }
}

await applySchema();
await sweepExpired();
/* unref so the timer never holds the process open on shutdown */
setInterval(sweepExpired, SWEEP_MS).unref();
placeUnplacedShops();

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port }, () =>
  console.log(`dealtitude api on :${port}  push=${pushConfigured ? "on" : "OFF"}`));

export default app;
