/* ---------------------------------------------------------------------------
 * Sending.
 *
 * Three routes to the same lock screen, chosen by the device's `kind`:
 *
 *   webpush  — the browser and the home-screen PWA, with VAPID
 *   apns     — the App Store build on an iPhone
 *   fcm      — the Play Store build on Android
 *
 * They are deliberately interchangeable. Nothing above this file learns which
 * one carried a message, which is what lets a shop have web followers and app
 * followers at the same time and one honest reach number across both — and
 * what lets the app move to the App Store without stranding anyone already
 * following from a browser.
 *
 * Each route decides for itself what counts as "this phone is gone for good".
 * Getting that wrong in either direction is costly: too eager and a shop loses
 * real followers to a transient error, too shy and its reach number counts
 * people who will never hear anything.
 * ------------------------------------------------------------------------- */
import webpush from "web-push";
import { sql } from "./db.js";
import * as apns from "./push-apns.js";
import * as fcm from "./push-fcm.js";

const PUB  = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
const SUBJ = process.env.VAPID_SUBJECT || "mailto:hello@dealtitude.com";

export const pushConfigured = Boolean(PUB && PRIV);
if (pushConfigured) webpush.setVapidDetails(SUBJ, PUB, PRIV);

export const publicKey = () => PUB || null;

/** What /v1/health reports, so a misconfigured route is visible before a
    shop owner discovers it by sending into silence. */
export const backends = () => ({
  webpush: pushConfigured,
  apns: apns.configured,
  apns_env: apns.configured ? apns.environment : null,
  fcm: fcm.configured,
  fcm_project: fcm.projectId,
});

/** Let the process shut down without a dangling HTTP/2 session to Apple. */
export const closePush = () => apns.close();

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
  /* A device with no subscription yet is not a failure to retire — it is a
     follower who hasn't switched notifications on. They still see the feed. */
  if (!device.endpoint) return { ok: false, retire: false, reason: "no_subscription" };

  if (device.kind === "apns") {
    const res = await apns.send(device, payload);
    /* The sender may have discovered which of Apple's two services this phone
       actually belongs to. Remembering it here means the next alert goes
       straight there rather than paying for a failed attempt first. */
    if (res.env && res.env !== device.push_env) {
      await sql`update devices set push_env = ${res.env} where id = ${device.id}`
        .catch(() => {});       // a lost optimisation must never lose an alert
    }
    return res;
  }
  if (device.kind === "fcm")  return fcm.send(device, payload);
  if (device.kind !== "webpush") return { ok: false, retire: false, reason: "unsupported_kind" };

  if (!pushConfigured) return { ok: false, retire: false, reason: "push_not_configured" };

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
