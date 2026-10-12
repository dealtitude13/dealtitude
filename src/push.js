/* ---------------------------------------------------------------------------
 * Sending.
 *
 * Web Push with VAPID, which is the cheapest route to a real pilot: it works
 * in Chrome on Android with no install at all, and on iOS 16.4+ once the app
 * is on the home screen — with no Apple Developer account and no $99.
 *
 * Native APNs/FCM slots in later behind the same `send()` signature; the rest
 * of the server never learns which one carried the message.
 * ------------------------------------------------------------------------- */
import webpush from "web-push";
import { sql } from "./db.js";

const PUB  = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
const SUBJ = process.env.VAPID_SUBJECT || "mailto:hello@dealtitude.com";

export const pushConfigured = Boolean(PUB && PRIV);
if (pushConfigured) webpush.setVapidDetails(SUBJ, PUB, PRIV);

export const publicKey = () => PUB || null;

/**
 * Deliver one notification to one device.
 * Returns { ok: true } or { ok: false, retire: boolean, reason }.
 *
 * `retire` means the subscription is permanently dead — the browser was
 * uninstalled, the user revoked permission, the endpoint expired. Those rows
 * get stamped so the shop's "reachable" count tells the truth rather than
 * flattering them with followers who cannot hear anything.
 */
export async function send(device, payload) {
  if (!pushConfigured) return { ok: false, retire: false, reason: "push_not_configured" };
  /* A device with no subscription yet is not a failure to retire — it is a
     follower who hasn't switched notifications on. They still see the feed. */
  if (!device.endpoint) return { ok: false, retire: false, reason: "no_subscription" };
  if (device.kind !== "webpush") return { ok: false, retire: false, reason: "unsupported_kind" };

  const subscription = {
    endpoint: device.endpoint,
    keys: { p256dh: device.p256dh, auth: device.auth },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 60 * 60 * 6,          // a sale that is six hours stale helps nobody
      urgency: "normal",
    });
    return { ok: true };
  } catch (err) {
    const code = err?.statusCode;
    /* 404/410 = gone for good. 403/401 = our keys are wrong, which is our
       problem and not the subscriber's, so never retire on those. */
    const retire = code === 404 || code === 410;
    return { ok: false, retire, reason: `push_${code || "error"}` };
  }
}

export async function retireDevice(deviceId, reason) {
  await sql`update devices set retired_at = now() where id = ${deviceId}`;
  console.warn("[push] retired device", deviceId, reason);
}
