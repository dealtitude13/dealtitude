/* ---------------------------------------------------------------------------
 * The only file that talks to the server.
 *
 * Two kinds of caller, as on the server side: a phone, which proves itself
 * with a device token it was handed on first registration, and an owner, who
 * signs in by email and holds a session.
 *
 * If no API address is configured, `live` is false and the app runs on its own
 * in-memory state — which is what a shop visit wants: the demo works on a
 * countertop with no signal and nothing it does reaches a real follower.
 * ------------------------------------------------------------------------- */

/* Set at deploy time by www/config.js, so the same bundle can point at a local
   server, a staging one, or production without a rebuild. */
const BASE = (typeof window !== "undefined" && window.DEALTITUDE_API) || "";

export const live = Boolean(BASE);
export const base = BASE;

const KEY_DEVICE = "dt.device.token";
const KEY_OWNER = "dt.owner.token";
/* The operator key, kept on YOUR phone only. It is what lets a shop be created
   at a counter instead of from a laptop, and it is the one secret in the app —
   so it is never bundled, never defaulted, and typed in once per phone. */
const KEY_ADMIN = "dt.admin.key";

/* localStorage throws outright in some privacy modes rather than returning
   null, and an exception here would take the whole app down on launch. */
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
};

export const deviceToken = () => read(KEY_DEVICE);
export const ownerToken = () => read(KEY_OWNER);
export const setDeviceToken = (t) => write(KEY_DEVICE, t);
export const setOwnerToken = (t) => write(KEY_OWNER, t);
export const signedInAsOwner = () => Boolean(read(KEY_OWNER));

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function call(method, path, { body, as, timeout = 12000 } = {}) {
  if (!BASE) throw new ApiError(0, "no server configured");

  const token = as === "owner" ? ownerToken()
              : as === "device" ? deviceToken() : null;
  const admin = as === "admin" ? adminKey() : null;

  /* A hung request must not leave a button spinning forever on a shop floor
     with one bar of signal. */
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      signal: abort.signal,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(admin ? { "x-admin-key": admin } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, e.name === "AbortError"
      ? "the server did not answer" : "no connection");
  } finally { clearTimeout(timer); }

  let json = null;
  try { json = await res.json(); } catch {}

  if (res.status === 401 && as === "owner") setOwnerToken(null);
  if (!res.ok) throw new ApiError(res.status, json?.error || `request failed (${res.status})`);
  return json;
}

/* ------------------------------------------------------------- the phone --- */

export const pushKey = () => call("GET", "/v1/push-key");

/** Register this phone. Keeps the token it gets back. */
export async function registerDevice(sub = {}) {
  const r = await call("POST", "/v1/device", { body: sub });
  setDeviceToken(r.token);
  return r;
}

/**
 * Make sure this phone has an identity, with or without notifications.
 *
 * Following must never depend on push. Someone who declines notifications, or
 * whose iPhone is not on the home screen yet, still wants to follow a shop and
 * open the app to see what's on — and the server counts them as unreachable
 * until they do subscribe, so the shop's number stays honest either way.
 */
export async function ensureDevice() {
  if (deviceToken()) return deviceToken();
  await registerDevice({});
  await shareWithWorker();
  return deviceToken();
}

/** Tell the server the browser rotated our subscription. Follows stay put. */
export const moveDevice = (sub) =>
  call("PATCH", "/v1/device", { body: sub, as: "device" });

/** A short code this phone can hand to another install of itself. */
export const claimCode = () =>
  call("POST", "/v1/device/claim-code", { as: "device" });

/**
 * Become the device that code belongs to, inheriting its follows.
 *
 * This is how a follow made in Safari survives being added to the home screen
 * — the installed app has its own storage and would otherwise arrive blank.
 */
export async function redeemClaim(code, sub = {}) {
  const r = await call("POST", "/v1/device/claim", { body: { code, ...sub } });
  setDeviceToken(r.token);
  await shareWithWorker();
  return r;
}

/* ------------------------------------------------------------- age gate --- */
/* The bar this phone has cleared, remembered locally so the gate is asked once
   rather than every time the app reopens. The server holds the same number
   against the device; this copy is only so the UI knows before it has asked.
   The date of birth itself is never written anywhere, here included. */
const KEY_AGE = "dt.age.ok";

export const ageCleared = () => {
  const v = Number(read(KEY_AGE));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** Record that this device confirmed it meets `minAge`. */
export async function confirmAge(minAge) {
  await ensureDevice();
  await call("POST", "/v1/device/age", { body: { min_age: minAge }, as: "device" });
  /* Highest bar wins, matching the server — clearing 21 also clears 18. */
  if (minAge > ageCleared()) write(KEY_AGE, String(minAge));
  return minAge;
}

/* Shops within `radius` miles of a ZIP. The server owns the distance maths and
   the filtering; the app only asks and renders what comes back. */
/* as: "device" so the server knows which shops THIS phone follows and can
   measure the ones outside the radius. The route works without it — which is
   how it shipped without it, silently returning an empty followed list and
   leaving those shops on screen with no distance. */
export const shopsNear = (zip, radius = 5) =>
  call("GET", `/v1/shops?zip=${encodeURIComponent(zip)}`
            + `&radius=${encodeURIComponent(radius)}`, { as: "device" });
export const shop = (slug) => call("GET", `/v1/shops/${slug}`);

export const follow = (slug, aisles = []) =>
  call("POST", `/v1/shops/${slug}/follow`, { body: { aisles }, as: "device" });
export const setAisles = (slug, aisles) =>
  call("PATCH", `/v1/shops/${slug}/follow`, { body: { aisles }, as: "device" });
export const setMuted = (slug, muted) =>
  call("PATCH", `/v1/shops/${slug}/follow`, { body: { muted }, as: "device" });
export const unfollow = (slug) =>
  call("DELETE", `/v1/shops/${slug}/follow`, { as: "device" });

export const myFollows = () => call("GET", "/v1/me/follows", { as: "device" });
export const myFeed = () => call("GET", "/v1/me/feed", { as: "device" });
export const markOpened = (postId) =>
  call("POST", `/v1/posts/${postId}/opened`, { as: "device" });

/* ------------------------------------------------------------- the owner --- */

/** Sends a sign-in link. Resolves whether or not that email has a shop —
    telling a stranger which emails are registered is a free gift to them. */
export const requestLink = (email) =>
  call("POST", "/v1/auth/request", { body: { email } });

export async function verifyLink(token) {
  const r = await call("POST", "/v1/auth/verify", { body: { token } });
  setOwnerToken(r.token);
  return r;
}

/**
 * Sign in with a code instead of an emailed link.
 *
 * This exists for App Store review: the person testing the app has no inbox of
 * ours, so the emailed link is a dead end and the app comes back rejected as
 * unreviewable. The server only honours one address, and only when it has been
 * given a code to expect, so for everyone else this road is closed.
 */
export async function signInWithCode(email, code) {
  const r = await call("POST", "/v1/auth/code", { body: { email, code } });
  setOwnerToken(r.token);
  return r;
}

/** Pick up a shop invited to this address since signing in. */
export const claimInvites = () => call("POST", "/v1/owner/claim", { as: "owner" });

export const signOut = () => setOwnerToken(null);

/* ------------------------------------------------------------- operator --- */
/* Creating a shop is the one thing no shop owner and no shopper may ever do,
   so it is guarded by a key rather than by a role on an account. Entered once
   on your own phone; everything below refuses without it. */

export const adminKey = () => read(KEY_ADMIN);
export const setAdminKey = (k) => write(KEY_ADMIN, k && k.trim() ? k.trim() : null);
export const hasAdminKey = () => Boolean(read(KEY_ADMIN));

/** A shop name becomes its printed card's address, so it has to be clean. */
export function slugify(name) {
  const base = String(name).toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38);
  /* The server demands at least three characters and no leading or trailing
     dash. A short name like "Jo's" would otherwise be rejected after you have
     already typed everything else in front of the owner. */
  return base.length >= 3 ? base : `${base || "shop"}-store`.slice(0, 38);
}

export const createShop = (shop) =>
  call("POST", "/v1/admin/shops", { body: shop, as: "admin" });

export const inviteOwner = (slug, email) =>
  call("POST", "/v1/admin/invites", { body: { slug, email }, as: "admin" });

/** Wipe every shop, owner, follower and post. Only answered when the server
    has ALLOW_RESET switched on, so the key alone cannot do this. */
export const resetEverything = () =>
  call("POST", "/v1/admin/reset", { body: { confirm: "RESET" }, as: "admin" });

/** Will this server accept a reset at all? Keeps the app from offering it. */
export async function resetAvailable() {
  const h = await health();
  return h?.reset_enabled === true;
}

/** Take a shop off the app. Its history stays; shoppers simply stop seeing it. */
export const removeShop = (slug) =>
  call("DELETE", `/v1/admin/shops/${encodeURIComponent(slug)}`, { as: "admin" });

/** What the server says about itself. Used to tell a missing operator key
    apart from a wrong one, and to check which build is actually deployed. */
export const health = () => call("GET", "/v1/health");

/** Is an operator key configured on the server at all? null if we can't tell —
    an older server doesn't report it, and a guess would be worse than silence. */
export async function adminKeyConfigured() {
  const h = await health();
  return typeof h?.admin_key === "boolean" ? h.admin_key : null;
}

/** Does this key actually work? Asked before a shop is typed in, not after. */
export async function checkAdminKey() {
  try {
    /* A deliberately invalid shop: a wrong key is refused with 403 before the
       body is ever looked at, a right one gets as far as complaining about the
       body. Either answer tells us what we need without creating anything. */
    await call("POST", "/v1/admin/shops", { body: {}, as: "admin" });
    return true;
  } catch (e) {
    if (e.status === 403) return false;
    if (e.status === 400) return true;
    throw e;
  }
}

export const myShops = () => call("GET", "/v1/owner/shops", { as: "owner" });

/** Publish and fan out. Returns { post, sent, withheld }. */
export const publish = (slug, post) =>
  call("POST", `/v1/owner/shops/${slug}/posts`, { body: post, as: "owner" });

export const posts = (slug) =>
  call("GET", `/v1/owner/shops/${slug}/posts`, { as: "owner" });
export const endPost = (slug, id) =>
  call("PATCH", `/v1/owner/shops/${slug}/posts/${id}`,
       { body: { status: "ended" }, as: "owner" });

export const reach = (slug) => call("GET", `/v1/owner/shops/${slug}/reach`, { as: "owner" });

/* ------------------------------------------------------------------ wants ---
 * An item a shopper is hoping to see. `as: "device"` matters on the GET too —
 * without the token the server can still return the counts, but not `mine`,
 * and the screen would forget what this phone had already asked for. */

/** { wants: [{norm,label,shoppers,aisle}], suggest: [{label,aisle}], mine: [] } */
export const wants = (slug) =>
  call("GET", `/v1/shops/${slug}/wants`, { as: "device" });

export const askFor = (slug, label, aisle) =>
  call("POST", `/v1/shops/${slug}/wants`,
       { body: { label, ...(aisle ? { aisle } : {}) }, as: "device" });

export const unask = (slug, norm) =>
  call("DELETE", `/v1/shops/${slug}/wants/${encodeURIComponent(norm)}`, { as: "device" });

/** The owner's side of the same list: real demand, most-wanted first. */
export const demand = (slug) =>
  call("GET", `/v1/owner/shops/${slug}/wants`, { as: "owner" });

/** What this shop already knows about a barcode. 404 means it is new here. */
export async function lookupGtin(slug, gtin) {
  try { return await call("GET", `/v1/owner/shops/${slug}/catalog/${gtin}`, { as: "owner" }); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

/* ----------------------------------------------------- push subscription --- */

const urlB64 = (s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};

/**
 * Get a real Web Push subscription for this browser and register it.
 *
 * Returns { ok: true } or { ok: false, why } where `why` is something the UI
 * can explain in words rather than a stack trace. Permission must already have
 * been granted — asking is a separate, user-initiated step.
 */
export async function enablePush() {
  if (!live) return { ok: false, why: "no-server" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    return { ok: false, why: "unsupported" };
  if (typeof Notification !== "undefined" && Notification.permission !== "granted")
    return { ok: false, why: "no-permission" };

  let key;
  try { key = (await pushKey()).key; }
  catch { return { ok: false, why: "no-push-key" }; }
  if (!key) return { ok: false, why: "no-push-key" };

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  /* A subscription made against a different VAPID key cannot receive our
     messages. Replace it rather than quietly keeping a dead one. */
  if (sub) {
    const held = sub.options?.applicationServerKey;
    const same = held && btoa(String.fromCharCode(...new Uint8Array(held)))
      === btoa(String.fromCharCode(...urlB64(key)));
    if (!same) { try { await sub.unsubscribe(); } catch {} sub = null; }
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlB64(key),
      });
    } catch { return { ok: false, why: "subscribe-failed" }; }
  }

  const j = sub.toJSON();
  const payload = { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth };

  try {
    /* Already known here? Attach the subscription to the identity this phone
       already has, so the follows it made before switching notifications on
       come with it. Otherwise register fresh. */
    if (deviceToken()) await moveDevice(payload);
    else await registerDevice(payload);
  } catch (e) {
    if (e.status === 401) { setDeviceToken(null); await registerDevice(payload); }
    else return { ok: false, why: "register-failed" };
  }

  await shareWithWorker(key);
  return { ok: true };
}

/**
 * The App Store / Play Store equivalent of enablePush().
 *
 * In a native build there is no service worker and no VAPID key — the phone
 * hands us an APNs or FCM token and that token IS the address. Everything
 * after that is identical to the web path, deliberately: attach it to the
 * identity this phone already has so the follows it made before notifications
 * were switched on come across with it, rather than starting a second,
 * duplicate follower.
 *
 * `platform` is Capacitor's "ios" or "android".
 */
export async function registerNativePush(token, platform) {
  if (!live) return { ok: false, why: "no-server" };
  if (!token) return { ok: false, why: "no-token" };

  const kind = platform === "ios" ? "apns" : "fcm";
  const payload = { endpoint: token, kind };

  try {
    if (deviceToken()) await moveDevice(payload);
    else await registerDevice(payload);
  } catch (e) {
    /* An unknown device token means this install's identity is gone from the
       server — start a fresh one rather than leaving the phone unreachable. */
    if (e.status === 401) { setDeviceToken(null); await registerDevice(payload); }
    else return { ok: false, why: "register-failed" };
  }
  return { ok: true };
}

/**
 * Leave the API address, this device's token and the push key where the
 * service worker can find them. A notification is usually tapped with no page
 * open, so the worker cannot ask the app for them.
 */
export async function shareWithWorker(vapid = null) {
  try {
    const c = await caches.open("dealtitude-cfg");
    await c.put("/__cfg", new Response(JSON.stringify({
      api: BASE, token: deviceToken(), vapid,
    }), { headers: { "content-type": "application/json" } }));
  } catch {}
}
