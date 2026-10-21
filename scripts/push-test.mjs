/* Ask Apple directly, and print exactly what it says.
 *
 * Everything so far has been inference from a one-word reason code. This sends
 * a real notification to the newest iPhone on file, to BOTH of Apple's
 * services explicitly, and prints the host, the topic, the HTTP status and
 * Apple's own JSON for each. No guessing left.
 *
 * Run in Render's Web Shell:   node scripts/push-test.mjs
 * It sends a real alert. If one lands on the phone, that is the answer.
 */
import http2 from "node:http2";
import { createSign } from "node:crypto";
import { sql } from "../src/db.js";

const KEY_ID  = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const TOPIC   = process.env.APNS_BUNDLE_ID || "com.dealtitude.app";
const KEY_P8  = (process.env.APNS_KEY_P8 || "").replace(/\\n/g, "\n");

/* A host override exists for the test harness. If one is set in production
   every send goes somewhere that is not Apple, which would look exactly like
   this — so it is printed rather than assumed. */
const HOSTS = {
  production: process.env.APNS_HOST || "https://api.push.apple.com",
  sandbox: process.env.APNS_HOST_SANDBOX || process.env.APNS_HOST
         || "https://api.sandbox.push.apple.com",
};

console.log("\n=== WHAT WE ARE ABOUT TO DO ===============================");
console.log(`  topic        : ${TOPIC}`);
console.log(`  production   : ${HOSTS.production}`);
console.log(`  sandbox      : ${HOSTS.sandbox}`);
if (process.env.APNS_HOST) {
  console.log("  !! APNS_HOST is set, so this is NOT going to Apple. That is");
  console.log("     almost certainly a leftover and is the bug. Remove it.");
}

/* base64url without padding, which is what a JWT wants. */
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o))
  .toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/* ES256 wants the raw r||s pair; Node signs DER by default. Getting this wrong
   is a 403 on every send with a perfectly good key. */
const derToJose = (der) => {
  let o = 2, len = der[1];
  if (len & 0x80) o = 2 + (len & 0x7f);
  const rLen = der[o + 1]; let r = der.subarray(o + 2, o + 2 + rLen);
  const sOff = o + 2 + rLen;
  const sLen = der[sOff + 1]; let s = der.subarray(sOff + 2, sOff + 2 + sLen);
  const pad = (b) => b.length > 32 ? b.subarray(b.length - 32)
    : Buffer.concat([Buffer.alloc(32 - b.length), b]);
  return Buffer.concat([pad(r), pad(s)]);
};

const jwt = () => {
  const head = b64({ alg: "ES256", kid: KEY_ID });
  const claim = b64({ iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  const signer = createSign("SHA256");
  signer.update(`${head}.${claim}`);
  const der = signer.sign(KEY_P8);
  return `${head}.${claim}.${derToJose(der).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
};

const send = (token, env) => new Promise((resolve) => {
  let done = false;
  const finish = (r) => { if (!done) { done = true; resolve(r); } };
  /* Without this, a host that accepts the TCP connection and then says nothing
     hangs the script for ever, which is indistinguishable from "still working"
     to whoever is watching it. */
  const timer = setTimeout(() => finish({ env, error: "timed out after 15s \u2014 "
    + "the host did not answer (blocked network, or a wrong APNS_HOST)" }), 15000);
  const resolveOnce = (r) => { clearTimeout(timer); finish(r); };

  let client;
  try { client = http2.connect(HOSTS[env]); }
  catch (e) { return resolveOnce({ env, error: `connect threw: ${e.message}` }); }
  client.on("error", (e) => resolveOnce({ env, error: `connection: ${e.message}` }));

  const body = JSON.stringify({
    aps: { alert: { title: "Dealtitude test", body: "If you can see this, push works." },
           sound: "default" },
  });
  let req;
  try {
    req = client.request({
      ":method": "POST", ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt()}`,
      "apns-topic": TOPIC, "apns-push-type": "alert", "apns-priority": "10",
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
    });
  } catch (e) { client.close(); return resolveOnce({ env, error: `request threw: ${e.message}` }); }

  let status = 0, data = "", id = "";
  req.setEncoding("utf8");
  req.on("response", (h) => { status = h[":status"]; id = h["apns-id"] || ""; });
  req.on("data", (c) => { data += c; });
  req.on("error", (e) => { client.close(); resolveOnce({ env, error: e.message }); });
  req.on("end", () => { client.close(); resolveOnce({ env, status, id, body: data || "(empty)" }); });
  req.end(body);
});

const [dev] = await sql`
  select id, endpoint, kind, push_env, retired_at, created_at
    from devices
   where kind = 'apns' and endpoint is not null
   order by last_seen_at desc nulls last limit 1`;

if (!dev) {
  console.log("\n  No APNs device on file at all. Nothing to test.\n");
  await sql.end();
  process.exit(0);
}

console.log("\n=== THE PHONE =============================================");
console.log(`  token   : ${dev.endpoint.slice(0, 16)}… (${dev.endpoint.length} chars)`);
console.log(`  env     : ${dev.push_env || "(never established)"}`);
console.log(`  retired : ${dev.retired_at ? "yes" : "no"}`);

for (const env of ["production", "sandbox"]) {
  const r = await send(dev.endpoint, env);
  console.log(`\n=== APPLE'S ANSWER — ${env.toUpperCase()} =======================`);
  if (r.error) { console.log(`  transport error: ${r.error}`); continue; }
  console.log(`  HTTP status : ${r.status}`);
  console.log(`  apns-id     : ${r.id || "(none)"}`);
  console.log(`  body        : ${r.body}`);
  if (r.status === 200) console.log("  → DELIVERED. Check the phone.");
}

console.log("\n=== HOW TO READ IT ========================================");
console.log("  200 on either      → push works; the app's own send path is at fault.");
console.log("  400 BadDeviceToken → that token is not for this app's bundle id.");
console.log("  403 InvalidProviderToken → the key, key id or team id is wrong.");
console.log("  403 ExpiredProviderToken → the server's clock, or a stale jwt.");
console.log("  410 Unregistered   → the app was removed from that phone.\n");
await sql.end();
