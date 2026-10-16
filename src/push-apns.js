/* ---------------------------------------------------------------------------
 * Apple Push Notification service.
 *
 * APNs is HTTP/2 only, and authenticates with a short-lived JWT signed by a
 * .p8 key downloaded once from the Apple Developer portal. That key is the
 * whole credential — there is no per-app certificate to renew and no yearly
 * expiry — so it lives in an environment variable and never in the repo.
 *
 * Two things here are easy to get wrong and expensive to debug:
 *
 *   1. The sandbox and production hosts are different, and a token minted by a
 *      TestFlight or Xcode build is NOT valid on the production host. Sending a
 *      development token to production comes back as BadDeviceToken, which
 *      looks exactly like a dead phone. So we never retire a device on that
 *      reason alone unless the environment is right — see below.
 *
 *   2. Apple refuses a JWT reissued more often than once every 20 minutes, and
 *      rejects one older than an hour. Both ends of that are a 403 that reads
 *      like a bad key. We mint one every 40 minutes, comfortably inside both.
 * ------------------------------------------------------------------------- */
import http2 from "node:http2";
import { createSign } from "node:crypto";

const KEY_ID  = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const TOPIC   = process.env.APNS_BUNDLE_ID || "com.dealtitude.app";
/* The .p8 file's contents. Render strips newlines from some pasted values, so
   an escaped \n is accepted and turned back into a real one. */
const KEY_P8  = (process.env.APNS_KEY_P8 || "").replace(/\\n/g, "\n");

/* "production" unless explicitly told otherwise. Getting this backwards is the
   single most common APNs mistake, so it is stated rather than guessed. */
/* Apple runs two completely separate push services, and a token minted for one
   is rejected by the other with "BadDeviceToken" — which reads exactly like a
   phone that deleted the app. A build installed from Xcode belongs to the
   sandbox; TestFlight and the App Store belong to production. One developer
   testing on their own phone while real customers use the shipped app
   therefore needs BOTH at once, which a single setting cannot express.

   So nothing here is configured. The first send to a phone tries the likely
   host, falls back to the other if Apple says the token is not ours, and the
   answer is remembered against that device. Nobody has to know this exists. */
const DEFAULT_ENV = process.env.APNS_ENV === "sandbox" ? "sandbox" : "production";

/* The overrides exist so the test suite can stand up local servers and
   exercise the signing, the HTTP/2 request, the fallback and the retire rules
   for real. Neither is ever set in production. */
const HOSTS = {
  production: process.env.APNS_HOST || "https://api.push.apple.com",
  sandbox: process.env.APNS_HOST_SANDBOX || process.env.APNS_HOST ||
           "https://api.sandbox.push.apple.com",
};

export const configured = Boolean(KEY_ID && TEAM_ID && KEY_P8);
/** Which service a phone is tried against FIRST. Not a restriction — see send(). */
export const environment = DEFAULT_ENV;

/* ------------------------------------------------------------------- JWT --- */

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o))
  .toString("base64url");

let cached = { token: null, at: 0 };
const JWT_MAX_AGE = 40 * 60 * 1000;

function bearer() {
  if (cached.token && Date.now() - cached.at < JWT_MAX_AGE) return cached.token;

  const head = b64({ alg: "ES256", kid: KEY_ID });
  const body = b64({ iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  /* APNs wants the raw 64-byte r||s pair, not the DER wrapper Node produces by
     default. Without ieee-p1363 every request comes back 403 InvalidProviderToken
     with a perfectly valid key. */
  const sig = createSign("SHA256")
    .update(`${head}.${body}`)
    .sign({ key: KEY_P8, dsaEncoding: "ieee-p1363" })
    .toString("base64url");

  cached = { token: `${head}.${body}.${sig}`, at: Date.now() };
  return cached.token;
}

/* ---------------------------------------------------- the connection ------- */
/* One HTTP/2 session, reused. Opening a fresh one per notification is what
   makes a fan-out to a few hundred followers take minutes instead of seconds. */

const sessions = new Map();         // environment -> http2 session

function connect(env) {
  const held = sessions.get(env);
  if (held && !held.closed && !held.destroyed) return held;
  const s = http2.connect(HOSTS[env]);
  s.setTimeout(60_000, () => { try { s.close(); } catch {} });
  s.on("error", (e) => {
    console.warn(`[apns:${env}] session error:`, e?.message || e);
    try { s.destroy(); } catch {}
    if (sessions.get(env) === s) sessions.delete(env);
  });
  s.on("close", () => { if (sessions.get(env) === s) sessions.delete(env); });
  sessions.set(env, s);
  return s;
}

/** Let the process exit cleanly, and let tests close up after themselves. */
export function close() {
  for (const s of sessions.values()) { try { s.close(); } catch {} }
  sessions.clear();
}

/* ------------------------------------------------------------------ send --- */

/**
 * Deliver one alert to one iPhone.
 *
 * Returns { ok } or { ok: false, retire, reason }, matching the web sender,
 * plus `env` when this send established which of Apple's two services the
 * phone belongs to — the caller stores that so the next send goes straight
 * there.
 */
/* Apple has more than one way of saying "that token is not for this service".
   All of them mean: try the other one before writing the phone off. */
const ENV_MISMATCH = new Set([
  "apns_BadDeviceToken",
  "apns_BadEnvironmentKeyInToken",
  "apns_BadCertificateEnvironment",
]);

export async function send(device, payload) {
  if (!configured) return { ok: false, retire: false, reason: "apns_not_configured" };

  /* What we know, or the configured guess. */
  const first = device.push_env === "sandbox" || device.push_env === "production"
    ? device.push_env : DEFAULT_ENV;
  const second = first === "production" ? "sandbox" : "production";

  const a = await attempt(device, payload, first);
  /* These answers mean "right token, wrong one of Apple's two services", and
     they are the ones that otherwise get a real follower deleted. Everything
     else is final.
     This was a single string — BadDeviceToken — and a phone built from Xcode
     is issued a DEVELOPMENT token, which production APNs refuses with
     BadEnvironmentKeyInToken instead. Different word, same meaning, and it
     skipped the retry entirely: the shop was told "the alert service refused
     it, try again shortly" forever, for a follower who was one hop away. */
  if (a.ok || !ENV_MISMATCH.has(a.reason)) {
    return device.push_env ? a : { ...a, env: a.ok ? first : undefined };
  }

  const b = await attempt(device, payload, second);
  if (b.ok) {
    console.warn(`[apns] device belongs to ${second}, not ${first} — remembered`);
    return { ok: true, env: second };
  }
  /* Refused by both. Carry APNS's OWN second answer rather than a synthesised
     one: if both services say the token is bad the phone is genuinely gone,
     but if the second attempt failed for some other reason — a bad signing
     key, say — that is ours to fix and must not be reported as a follower who
     uninstalled the app. */
  const bothSayBadToken = ENV_MISMATCH.has(b.reason);
  return { ok: false, retire: bothSayBadToken, reason: `${b.reason}_both` };
}

function attempt(device, payload, env) {
  return new Promise((resolve) => {
    let client;
    try { client = connect(env); }
    catch (e) { return resolve({ ok: false, retire: false, reason: "apns_connect_failed" }); }

    /* The shape Apple expects. Everything outside `aps` is ours, and arrives
       in the app as the notification's data — the same keys the web service
       worker reads, so the app's tap handler doesn't care which route it came
       by. */
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body || "" },
        sound: "default",
        "thread-id": payload.shop || undefined,
      },
      shop: payload.shop || null,
      postId: payload.postId || null,
      kind: payload.kind || null,
    });

    const headers = {
      ":method": "POST",
      ":path": `/3/device/${device.endpoint}`,
      authorization: `bearer ${bearer()}`,
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      /* 10 = deliver now. A sale alert that arrives when the phone next wakes
         is worth nothing to a shopper walking past the shop. */
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 6 * 60 * 60),
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    /* One notification per post: a retry replaces rather than stacks, which is
       the same promise the web worker's `tag` makes. */
    if (payload.postId) headers["apns-collapse-id"] = String(payload.postId).slice(0, 64);

    let req;
    try { req = client.request(headers); }
    catch { return resolve({ ok: false, retire: false, reason: "apns_request_failed" }); }

    let status = 0, data = "";
    req.setEncoding("utf8");
    req.on("response", (h) => { status = h[":status"]; });
    req.on("data", (chunk) => { data += chunk; });
    req.on("error", (e) =>
      resolve({ ok: false, retire: false, reason: `apns_${e?.code || "error"}` }));
    req.on("end", () => {
      if (status === 200) return resolve({ ok: true });

      let apple = "";
      try { apple = JSON.parse(data || "{}").reason || ""; } catch {}

      /* Gone for good: the app was deleted, or the token was for a different
         app entirely. Neither is fixed by retrying.

         BadDeviceToken is NOT decided here. It is the one answer that can mean
         "right phone, wrong one of Apple's two services", so send() tries the
         other before anybody is retired. */
      const gone = apple === "Unregistered" || apple === "DeviceTokenNotForTopic";

      resolve({ ok: false, retire: gone, reason: `apns_${apple || status}` });
    });

    req.end(body);
  });
}
