/* ---------------------------------------------------------------------------
 * The one place that knows whether we're running as a real app or in a browser.
 *
 * Everything above this file calls the same four functions. Inside the App
 * Store / Play Store build they go through APNs and FCM; on the web they fall
 * back to the browser Notification API, so the same codebase still deploys as
 * a PWA. Nothing else in the app imports Capacitor directly.
 * ------------------------------------------------------------------------- */

import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { LocalNotifications } from "@capacitor/local-notifications";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { App as CapApp } from "@capacitor/app";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform();           // "ios" | "android" | "web"

/* The device token the backend will send pushes to. Null until registration
   succeeds; the UI shows the reason when it doesn't. */
let deviceToken = null;
export const getDeviceToken = () => deviceToken;

/* --------------------------------------------------------------- permission */

/**
 * Ask for notification permission. Returns "granted", or a reason string the
 * UI can explain: "denied", "unsupported", "not-installed", "not-allowed".
 */
export async function askNotificationPermission() {
  if (isNative) {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") return "denied";

    await LocalNotifications.requestPermissions();
    await PushNotifications.register();          // token arrives on the listener
    return "granted";
  }

  /* --- browser --- */
  if (typeof Notification === "undefined") return "unsupported";
  /* iOS Safari only allows this from a home-screen install. */
  const installed = window.matchMedia?.("(display-mode: standalone)").matches ||
                    window.navigator.standalone === true;
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (iOS && !installed) return "not-installed";
  try {
    const res = await Notification.requestPermission();
    return res === "granted" ? "granted" : res === "denied" ? "denied" : "not-allowed";
  } catch { return "unsupported"; }
}

export function notificationState() {
  if (isNative) return { installed: true, api: true, permission: "native" };
  const installed = window.matchMedia?.("(display-mode: standalone)").matches ||
                    window.navigator.standalone === true;
  return {
    installed,
    api: typeof Notification !== "undefined",
    permission: typeof Notification !== "undefined" ? Notification.permission : "none",
  };
}

/* ------------------------------------------------------------------ sending */

/**
 * Show a notification now. In the real product the server sends these through
 * APNs/FCM; this is for the prototype's own alerts and for the test button.
 * Returns true, or a reason string.
 */
export async function notify(title, body, data = {}) {
  if (isNative) {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== "granted") return "denied";
    await LocalNotifications.schedule({
      notifications: [{
        id: Math.floor(Math.random() * 2147483647),
        title, body, extra: data,
        smallIcon: "ic_stat_dealtitude",
        iconColor: "#FF9F1C",
        schedule: { at: new Date(Date.now() + 120) },
      }],
    });
    return true;
  }

  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "granted") {
    const st = notificationState();
    return st.installed ? "not-allowed" : "not-installed";
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", data };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
    return true;
  } catch { return "unsupported"; }
}

/* ------------------------------------------------------------------ startup */

/**
 * Called once on boot. Wires the native listeners and paints the system bars.
 * `on` receives { type, ...payload } for things the app should react to:
 *   token      — the APNs/FCM token, to register with the backend
 *   tokenError — registration failed
 *   opened     — the user tapped a notification
 *   deeplink   — the app was opened by a dealtitude:// or https:// link
 *   back       — Android hardware back button
 */
export async function initNative(on = () => {}) {
  if (!isNative) return;
  try { await bootNative(on); }
  catch (err) { console.warn("[dealtitude] native init failed:", err); }
}

async function bootNative(on) {
  try {
    await StatusBar.setStyle({ style: Style.Dark });           // dark text on paper
    if (platform === "android") await StatusBar.setBackgroundColor({ color: "#F5EFE4" });
  } catch {}

  /* One plugin failing to register must never take the app down with it —
     a shopper who can't receive pushes should still be able to use the app
     and see why. Each listener is attached on its own. */
  const listen = (owner, event, fn) => {
    try { owner.addListener(event, fn); }
    catch (err) { console.warn("[dealtitude] listener failed:", event, err); }
  };

  listen(PushNotifications, "registration", (t) => {
    deviceToken = t.value;
    on({ type: "token", token: t.value, platform });
  });
  listen(PushNotifications, "registrationError", (e) =>
    on({ type: "tokenError", error: String(e?.error || e) }));

  /* arrived while the app is open */
  listen(PushNotifications, "pushNotificationReceived", (n) =>
    on({ type: "received", title: n.title, body: n.body, data: n.data }));

  /* the user tapped it */
  listen(PushNotifications, "pushNotificationActionPerformed", (a) =>
    on({ type: "opened", data: a.notification?.data || {} }));
  listen(LocalNotifications, "localNotificationActionPerformed", (a) =>
    on({ type: "opened", data: a.notification?.extra || {} }));

  /* a QR code or a shared link opened the app */
  listen(CapApp, "appUrlOpen", ({ url }) => {
    try {
      const u = new URL(url);

      /* An owner's sign-in link. This was not handled at all, so a shopkeeper
         who tapped their invite on a phone with the app installed got the app
         opening at its front door with the token thrown away — no way into
         their shop, and nothing saying why. */
      const token = u.searchParams.get("token");
      if (token && /\/owner\b/.test(u.pathname)) {
        on({ type: "owner-link", token });
        return;
      }

      /* /<slug> straight to a shop, or the older ?s= form. */
      const path = (u.pathname || "").replace(/^\/+|\/+$/g, "");
      const shop = u.searchParams.get("s")
                || (u.hash || "").replace(/^#s=/, "")
                || (/^[a-z0-9][a-z0-9-]{1,38}$/.test(path) ? path : "");
      if (shop) on({ type: "deeplink", shop });
    } catch {}
  });

  listen(CapApp, "backButton", ({ canGoBack }) => on({ type: "back", canGoBack }));

  try { await SplashScreen.hide(); } catch {}
}

/** A small tap when something is published or followed. Silent on the web. */
export async function tap(style = "light") {
  if (!isNative) return;
  try {
    await Haptics.impact({ style: style === "medium" ? ImpactStyle.Medium : ImpactStyle.Light });
  } catch {}
}

/* ------------------------------------------------------------------ scanning
 * One call, three realities:
 *   native build  -> the phone camera, through ML Kit
 *   web + Chrome  -> BarcodeDetector, which Android has and Safari does not
 *   anything else -> null, and the caller offers the shelf-tag picker instead
 *
 * Returns { raw, format } on a read, { cancelled: true } when they back out,
 * { error } when it genuinely failed, or null when there is no native scanner.
 * Never throws: a scanner that fails has to fall back to typing, not break the
 * post the owner is in the middle of. */
export async function scanBarcode() {
  if (!isNative) return null;   // the web path is the caller's own camera view
  try {
    /* Capacitor's own scanner, not ML Kit's.
     *
     * The ML Kit plugin ships no Package.swift, so in a Swift Package Manager
     * project — which this is — it cannot be linked at all. Everything looked
     * wired up: the plugin in package.json, the camera permission in the
     * Info.plist, the JS import resolving. It just silently was not in the app,
     * and the only symptom was a camera button that did nothing. */
    const { CapacitorBarcodeScanner } = await import("@capacitor/barcode-scanner");
    const res = await CapacitorBarcodeScanner.scanBarcode({
      /* 17 is ALL. It reads as a magic number, so: the plugin's format values
         come from html5-qrcode's enum, where 0 is QR_CODE — which is what this
         used to pass. A shelf tag is a UPC or EAN barcode, never a QR code, so
         the scanner was being told to look for the one thing it would never
         see. ALL is a separate value the plugin adds on top of that enum. */
      hint: 17,
      /* Stated rather than left to the plugin's JS defaults, because the iOS
         side decodes both as required fields. */
      cameraDirection: 1,      // back camera
      scanOrientation: 3,      // adaptive — a shelf tag may be sideways
      scanInstructions: "Point the camera at the barcode on the shelf tag",
      scanButton: false,
    });
    const raw = res?.ScanResult;
    return raw ? { raw, format: null } : { cancelled: true };
  } catch (err) {
    /* Cancelling throws too, and that is not a failure: the sheet stays open
       and they type the code. Anything else is a real fault, and it has to
       reach the screen — swallowing it into "camera unavailable" is what made
       a parameter mistake look like broken hardware for a whole afternoon. */
    const msg = String(err?.message || err || "");
    const code = String(err?.code || "");
    if (/cancel/i.test(msg) || /0006$/.test(code)) return { cancelled: true };
    return { error: msg || "The scanner stopped without saying why." };
  }
}

/** Does this browser have a barcode reader we can use without a native build? */
export function webScanSupported() {
  return !isNative && typeof window !== "undefined" && "BarcodeDetector" in window;
}

/* A seam for the test that checks what the barcode plugin is actually called
   with. Every earlier test either took the web path or stubbed the bridge
   without inspecting the arguments, which is how hint: 0 — QR codes only —
   shipped in a scanner meant for shelf tags. Not referenced by any screen. */
if (typeof window !== "undefined") window.__dtScan = scanBarcode;
