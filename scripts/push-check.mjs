/* Why a phone is not being reached. Reads only; changes nothing.
 *
 * "apns_BadDeviceToken_both" has exactly two causes, and they need opposite
 * fixes, so guessing between them wastes a day:
 *
 *   1. The TOKEN is stale — registered by an older install and since killed by
 *      Apple. The app has to register again. Tell them apart by the date: a
 *      token last written before the newest build was installed is stale.
 *
 *   2. The TOPIC or the KEY does not match the app. APNs rejects every token
 *      for a topic that is not the app's bundle id, however fresh. This looks
 *      identical from the outside and no amount of re-registering fixes it.
 *
 * Run in Render's Web Shell on the API service:  node scripts/push-check.mjs
 */
import { sql } from "../src/db.js";

const BUNDLE_EXPECTED = "com.dealtitude.app";
const topic = process.env.APNS_BUNDLE_ID || BUNDLE_EXPECTED;

console.log("\n=== APNS CONFIG (no secrets printed) ======================");
console.log(`  topic sent to Apple : ${topic}`);
console.log(`  the app's bundle id : ${BUNDLE_EXPECTED}`);
console.log(`  MATCH               : ${topic === BUNDLE_EXPECTED ? "yes" : "NO — THIS IS THE BUG"}`);
console.log(`  APNS_ENV            : ${process.env.APNS_ENV || "(unset → production)"}`);
console.log(`  key id set          : ${process.env.APNS_KEY_ID ? "yes (" + process.env.APNS_KEY_ID + ")" : "NO"}`);
console.log(`  team id set         : ${process.env.APNS_TEAM_ID ? "yes (" + process.env.APNS_TEAM_ID + ")" : "NO"}`);
console.log(`  private key set     : ${process.env.APNS_KEY_P8 ? "yes, " + process.env.APNS_KEY_P8.length + " chars" : "NO"}`);

/* An APNs device token is 64 hex characters. Anything else in this column for
   an "apns" device means the wrong thing was registered, which is its own bug
   and nothing to do with Apple. */
const devices = await sql`
  select d.id, d.kind, d.endpoint, d.push_env, d.created_at, d.last_seen_at,
         d.retired_at, d.blocked_at,
         (select count(*) from follows f where f.device_id = d.id) as follows
    from devices d
   order by d.last_seen_at desc nulls last
   limit 20`;

console.log("\n=== DEVICES (newest first) ================================");
if (!devices.length) console.log("  none");
for (const d of devices) {
  const ep = d.endpoint || "";
  const hex64 = /^[0-9a-fA-F]{64}$/.test(ep);
  console.log(
    `\n  ${d.kind}  follows:${d.follows}  env:${d.push_env || "-"}` +
    `${d.retired_at ? "  RETIRED" : ""}${d.blocked_at ? "  BLOCKED" : ""}`);
  console.log(`    token      : ${ep ? ep.slice(0, 16) + "… (" + ep.length + " chars)" : "(none)"}`);
  console.log(`    shape      : ${!ep ? "no token at all" : hex64
    ? "ok — 64 hex, a real APNs token"
    : ep.startsWith("http") ? "a WEB PUSH url, not an APNs token" : "NOT 64 hex — wrong shape"}`);
  console.log(`    registered : ${d.created_at?.toISOString?.().replace("T", " ").slice(0, 16)}`);
  console.log(`    last seen  : ${d.last_seen_at?.toISOString?.().replace("T", " ").slice(0, 16)}`);
}

/* The question that settles it. A token written before the newest build went
   on the phone cannot have come from that build. */
console.log("\n=== WHAT THIS MEANS =======================================");
const live = devices.filter((d) => d.kind === "apns" && d.endpoint);
if (topic !== BUNDLE_EXPECTED) {
  console.log("  APNS_BUNDLE_ID does not match the app. Every token will be");
  console.log("  refused however often the app registers. Fix the env var.");
} else if (!live.length) {
  console.log("  No APNs token on file at all. The app has never successfully");
  console.log("  registered — the problem is on the phone, not at Apple.");
} else {
  console.log("  Compare 'registered' above with the time you installed the");
  console.log("  newest build:");
  console.log("    • BEFORE it  → the app is still not re-registering.");
  console.log("    • AFTER it   → the token is fresh and Apple still refuses it,");
  console.log("                   so the key, team or topic belongs to another app.");
}
console.log();
await sql.end();
