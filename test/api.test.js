/* End-to-end against a real Postgres. Starts the server in-process, drives it
   over HTTP exactly as the app will, and checks the outcomes that matter:
   a follow survives, an aisle filter holds, a cap bites, and nobody can post
   in a shop they do not hold. */
import { sql } from "../src/db.js";

const BASE = `http://127.0.0.1:${process.env.PORT || 8788}`;
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? "ok  " : "FAIL"}  ${label}${cond ? "" : "   " + extra}`);
};

const call = async (method, path, { token, admin, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(admin ? { "x-admin-key": admin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

/* ---------------------------------------------------------------------------
 * A stand-in push service.
 *
 * It has to be real HTTPS with a real P-256 subscription key, or web-push
 * fails while encrypting and the send path is never exercised at all — which
 * is exactly the hole this version closes. test/run.sh generates the cert and
 * points NODE_EXTRA_CA_CERTS at it, so TLS verification stays on.
 *
 * Each endpoint path tells the service what to answer:
 *   /ok/...    201 — delivered
 *   /gone/...  410 — the subscription is dead; the only signal that may retire
 *   /oops/...  500 — the service is having a bad day; must NOT retire
 * ------------------------------------------------------------------------- */
import { createServer } from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const PUSH_PORT = 8799;
const pushService = createServer(
  { key: readFileSync(new URL("./tmp/key.pem", import.meta.url)),
    cert: readFileSync(new URL("./tmp/cert.pem", import.meta.url)) },
  (req, res) => {
    const code = req.url.startsWith("/gone") ? 410
               : req.url.startsWith("/oops") ? 500 : 201;
    res.writeHead(code); res.end();
  });
await new Promise((r) => pushService.listen(PUSH_PORT, "127.0.0.1", r));

/** A subscription the encryption layer will actually accept. */
const sub = (n, lane = "ok") => {
  const ec = createECDH("prime256v1"); ec.generateKeys();
  return {
    endpoint: `https://127.0.0.1:${PUSH_PORT}/${lane}/${n}-${Date.now()}-${Math.random()}`,
    p256dh: ec.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
};

await import("../src/server.js");
await new Promise((r) => setTimeout(r, 400));

const ADMIN = process.env.ADMIN_KEY;
const slug = "testshop" + Math.floor(Math.random() * 1e6);

/* ------------------------------------------------------------ setup ------ */
{
  const r = await call("POST", "/v1/admin/shops", { admin: ADMIN, body: {
    slug, name: "Test Grocery", address: "1 Test Road", town: "Monroe",
    zip: "08831", daily_cap: 2, aisles: ["produce", "dairy", "sweets"] } });
  ok("admin creates a shop", r.status === 201, JSON.stringify(r.body));

  const nope = await call("POST", "/v1/admin/shops", { body: { slug: "x", name: "x",
    address: "x", town: "x", zip: "08831", aisles: ["a"] } });
  ok("no admin key is refused", nope.status === 403);
}

/* ------------------------------------------------------- shopper side ---- */
let aliceTok, bobTok;
{
  const a = await call("POST", "/v1/device", { body: sub("alice") });
  const b = await call("POST", "/v1/device", { body: sub("bob") });
  aliceTok = a.body?.token; bobTok = b.body?.token;
  ok("device registers and gets a token", Boolean(aliceTok && bobTok));

  const anon = await call("POST", `/v1/shops/${slug}/follow`, { body: { aisles: [] } });
  ok("following without a device is refused", anon.status === 401);

  const fa = await call("POST", `/v1/shops/${slug}/follow`,
    { token: aliceTok, body: { aisles: ["produce"] } });
  ok("alice follows, produce only", fa.status === 200 &&
     JSON.stringify(fa.body.aisles) === '["produce"]', JSON.stringify(fa.body));

  const junk = await call("POST", `/v1/shops/${slug}/follow`,
    { token: bobTok, body: { aisles: ["dairy", "not-an-aisle"] } });
  ok("an aisle the shop lacks is dropped",
     JSON.stringify(junk.body.aisles) === '["dairy"]', JSON.stringify(junk.body));

  const mine = await call("GET", "/v1/me/follows", { token: aliceTok });
  ok("the follow persists and reads back", mine.body?.follows?.[0]?.slug === slug);

  /* A rotated subscription must keep its follows. The token is the identity;
     the endpoint is only where the phone happens to be reachable. */
  const moved = await call("PATCH", "/v1/device",
    { token: bobTok, body: sub("bob-rotated") });
  ok("a rotated subscription is accepted", moved.status === 200,
     JSON.stringify(moved.body));
  const still = await call("GET", "/v1/me/follows", { token: bobTok });
  ok("and the follows survive the rotation",
     still.body?.follows?.[0]?.slug === slug &&
     JSON.stringify(still.body.follows[0].aisles) === '["dairy"]',
     JSON.stringify(still.body));
}

/* ---------------------------------------------------------- owner side --- */
let ownerTok;
{
  await call("POST", "/v1/admin/invites",
    { admin: ADMIN, body: { slug, email: "owner@test.local" } });
  const req = await call("POST", "/v1/auth/request", { body: { email: "owner@test.local" } });
  const token = new URL(req.body.link, "http://x").searchParams.get("token");
  const ver = await call("POST", "/v1/auth/verify", { body: { token } });
  ownerTok = ver.body?.token;
  ok("owner signs in and claims the invite", ver.body?.claimed === 1);

  const shops = await call("GET", "/v1/owner/shops", { token: ownerTok });
  ok("owner holds exactly that shop", shops.body?.shops?.[0]?.slug === slug);

  const stranger = await call("POST", "/v1/auth/request", { body: { email: "nobody@test.local" } });
  const st = new URL(stranger.body.link, "http://x").searchParams.get("token");
  const sv = await call("POST", "/v1/auth/verify", { body: { token: st } });
  const intruder = await call("POST", `/v1/owner/shops/${slug}/posts`,
    { token: sv.body.token, body: { kind: "notice", name: "hello" } });
  ok("a stranger cannot post to someone else's shop", intruder.status === 403);

  const noAuth = await call("POST", `/v1/owner/shops/${slug}/posts`,
    { body: { kind: "notice", name: "hello" } });
  ok("posting with no session is refused", noAuth.status === 401);
}

/* --------------------------------------------------------- the filter ---- */
{
  const sale = await call("POST", `/v1/owner/shops/${slug}/posts`, { token: ownerTok,
    body: { kind: "sale", aisle: "produce", name: "Methi bunches", now_cents: 149 } });
  ok("a produce sale publishes", sale.status === 201, JSON.stringify(sale.body));
  ok("bob is withheld — wrong aisle", sale.body?.withheld?.aisle_off === 1,
     JSON.stringify(sale.body?.withheld));
  ok("and it actually reached alice", sale.body?.sent === 1, JSON.stringify(sale.body));

  const wide = await call("POST", `/v1/owner/shops/${slug}/posts`, { token: ownerTok,
    body: { kind: "hours", name: "Closed Tuesday" } });
  ok("a shop-wide post withholds nobody for aisle",
     !wide.body?.withheld?.aisle_off, JSON.stringify(wide.body?.withheld));
  ok("a shop-wide post reaches both followers", wide.body?.sent === 2,
     JSON.stringify(wide.body));

  const bad = await call("POST", `/v1/owner/shops/${slug}/posts`, { token: ownerTok,
    body: { kind: "sale", aisle: "hardware", name: "Hammer", now_cents: 999 } });
  ok("a sale in an aisle the shop lacks is refused", bad.status === 400);

  const noPrice = await call("POST", `/v1/owner/shops/${slug}/posts`, { token: ownerTok,
    body: { kind: "sale", aisle: "produce", name: "Okra" } });
  ok("a sale with no price is refused", noPrice.status === 400);

  const dup = await call("POST", `/v1/owner/shops/${slug}/posts`, { token: ownerTok,
    body: { kind: "hours", name: "Closed Tuesday" } });
  ok("the same post twice is refused", dup.status === 409);
}

/* ------------------------------------------------------------- reach ----- */
{
  const r = await call("GET", `/v1/owner/shops/${slug}/reach`, { token: ownerTok });
  ok("reach reports two followers", Number(r.body?.total) === 2, JSON.stringify(r.body));
  ok("both are reachable", Number(r.body?.no_push) === 0
     && Number(r.body?.reachable) === 2, JSON.stringify(r.body));
  ok("aisle demand is reported", Array.isArray(r.body?.aisles) && r.body.aisles.length === 3);
}

/* ------------------------------- the cap, and who deserves to be retired --- */
{
  /* carol's push service says 410 — she is gone for good.
     dave's says 500 — it is having a bad day, and dave must survive it. */
  const carol = await call("POST", "/v1/device", { body: sub("carol", "gone") });
  const dave  = await call("POST", "/v1/device", { body: sub("dave",  "oops") });
  for (const t of [carol.body.token, dave.body.token])
    await call("POST", `/v1/shops/${slug}/follow`, { token: t, body: { aisles: ["produce"] } });

  const second = await call("POST", `/v1/owner/shops/${slug}/posts`, { token: ownerTok,
    body: { kind: "sale", aisle: "produce", name: "Curry leaves", now_cents: 99 } });
  ok("a second produce sale publishes", second.status === 201, JSON.stringify(second.body));
  ok("alice is capped — she has had her two for today",
     second.body?.withheld?.daily_cap === 1, JSON.stringify(second.body?.withheld));
  ok("nothing reached anyone this time", second.body?.sent === 0,
     JSON.stringify(second.body));

  const r = await call("GET", `/v1/owner/shops/${slug}/reach`, { token: ownerTok });
  ok("a 410 retires that follower, a 500 does not",
     Number(r.body?.total) === 4 && Number(r.body?.no_push) === 1
       && Number(r.body?.reachable) === 3, JSON.stringify(r.body));

  /* The cap must count what arrived, not what we tried to send. Dave's push
     failed on a 500, so tomorrow's first alert is still owed to him. */
  const [daveRow] = await sql`
    select count(*) filter (where withheld is null) as got
      from deliveries where device_id = (
        select id from devices where token_hash = encode(
          digest(${dave.body.token}, 'sha256'), 'hex'))`;
  ok("a failed send does not burn the follower's daily cap",
     Number(daveRow.got) === 0, JSON.stringify(daveRow));
}

/* ---------------- a follower with notifications off is still a follower --- */
{
  /* No endpoint at all: declined notifications, or an iPhone not yet on the
     home screen. Following must still work, and reach must still be honest. */
  const quiet = await call("POST", "/v1/device", { body: {} });
  ok("a phone with no push subscription can register",
     quiet.status === 200 && Boolean(quiet.body?.token) && quiet.body?.push === false,
     JSON.stringify(quiet.body));

  const f = await call("POST", `/v1/shops/${slug}/follow`,
    { token: quiet.body.token, body: { aisles: ["dairy"] } });
  ok("and can follow a shop", f.status === 200, JSON.stringify(f.body));

  const feed = await call("GET", "/v1/me/feed", { token: quiet.body.token });
  ok("and still sees the shop's news in the app", Array.isArray(feed.body?.posts),
     JSON.stringify(feed.body).slice(0, 120));

  const r = await call("GET", `/v1/owner/shops/${slug}/reach`, { token: ownerTok });
  ok("but is counted as unreachable, not as reach",
     Number(r.body?.total) === 5 && Number(r.body?.no_push) === 2
       && Number(r.body?.reachable) === 3, JSON.stringify(r.body));

  const bad = await call("PATCH", "/v1/device", { token: quiet.body.token, body: {} });
  ok("patching a device with no endpoint is refused", bad.status === 400);
}

/* ------------------- two rows, one browser: the merge must not lose a follow */
{
  /* This happens for real: the browser registers fresh on open, and the
     rotation notice for the old subscription arrives afterwards. Two rows,
     one phone. Whichever row survives has to carry both sets of follows —
     dropping either one silently unsubscribes a paying shop's follower. */
  const oldSub = sub("eve-old"), newSub = sub("eve-new");
  const first  = await call("POST", "/v1/device", { body: oldSub });
  const second = await call("POST", "/v1/device", { body: newSub });

  await call("POST", `/v1/shops/${slug}/follow`,
    { token: first.body.token,  body: { aisles: ["produce"] } });
  await call("POST", `/v1/shops/${slug}/follow`,
    { token: second.body.token, body: { aisles: ["sweets"] } });

  const m = await call("PATCH", "/v1/device",
    { token: first.body.token, body: newSub });
  ok("the duplicate row is folded in, not duplicated", m.body?.merged === true,
     JSON.stringify(m.body));

  const kept = await call("GET", "/v1/me/follows", { token: first.body.token });
  ok("the surviving row still follows the shop",
     kept.body?.follows?.length === 1 && kept.body.follows[0].slug === slug,
     JSON.stringify(kept.body));
  ok("and keeps both aisles the shopper had opted into",
     JSON.stringify(kept.body?.follows?.[0]?.aisles) === '["produce","sweets"]',
     JSON.stringify(kept.body?.follows?.[0]?.aisles));

  const [dupes] = await sql`
    select count(*) as n from follows f join devices d on d.id = f.device_id
     where f.shop_id = (select id from shops where slug = ${slug})
       and d.endpoint in (${oldSub.endpoint}, ${newSub.endpoint})`;
  ok("one phone counts once, not twice", Number(dupes.n) === 1, JSON.stringify(dupes));

  const stale = await call("GET", "/v1/me/follows", { token: second.body.token });
  ok("the superseded token no longer works", stale.status === 401,
     JSON.stringify(stale.body));
}

/* ------------------------------------------------------------ cleanup ---- */
await sql`delete from shops where slug = ${slug}`;
await sql`delete from owners where email in ('owner@test.local','nobody@test.local')`;
await sql.end();
pushService.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
