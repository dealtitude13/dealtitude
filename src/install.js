/* ---------------------------------------------------------------------------
 * Where is this running, and what can it actually do?
 *
 * The whole reason this file exists is one Apple rule: on an iPhone, a website
 * cannot ask for notification permission at all until it has been added to the
 * home screen. Android has no such rule — Chrome will ask straight away, and
 * installing is optional.
 *
 * So the two platforms need genuinely different first runs, and guessing wrong
 * means either a dead permission prompt on iOS or a pointless extra step on
 * Android. Everything here is about telling them apart honestly.
 * ------------------------------------------------------------------------- */

const ua = () => (typeof navigator === "undefined" ? "" : navigator.userAgent || "");

/**
 * Running inside the real App Store / Play Store build.
 *
 * Read off the global Capacitor puts on the window rather than importing the
 * native module, because everything else in this file is deliberately web-only
 * and must keep working in a plain browser with no native code present.
 *
 * Every question below has a different answer in a native build, and getting
 * that wrong is not subtle: an installed app that asks you to install it.
 */
export function isNativeApp() {
  try { return window.Capacitor?.isNativePlatform?.() === true; }
  catch { return false; }
}

/** Running from the home screen rather than in a browser tab. */
export function isStandalone() {
  try {
    /* A native build is as installed as an app can be. Reporting otherwise is
       what made the installed app offer to install itself. */
    if (isNativeApp()) return true;
    return window.matchMedia?.("(display-mode: standalone)").matches === true
        || window.navigator.standalone === true;   // iOS's older, own flag
  } catch { return false; }
}

export function isIOS() {
  const s = ua();
  /* iPadOS reports itself as a Mac, and has done since iPadOS 13 — the touch
     point count is the only reliable way to tell it from a desktop. */
  return /iPad|iPhone|iPod/.test(s)
      || (/Macintosh/.test(s) && (navigator.maxTouchPoints || 0) > 1);
}

export const isAndroid = () => /Android/.test(ua());

/** Safari's share button sits bottom-centre on an iPhone, top-right on an
    iPad — so the arrow has to know which one it is pointing at. */
export const isIPad = () =>
  /iPad/.test(ua()) || (/Macintosh/.test(ua()) && (navigator.maxTouchPoints || 0) > 1);

/** Safari proper, rather than Chrome or Firefox wearing an iOS skin. */
export const isIOSSafari = () =>
  isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua());

/**
 * What this device needs before it can receive an alert.
 *
 *   "native"       — the App Store / Play Store build: ask the OS directly
 *   "ready"        — a browser that can ask for permission right now
 *   "install"      — iPhone in a browser tab: must go to the home screen first
 *   "ios-browser"  — iPhone, but not in Safari: Add to Home Screen lives in
 *                    Safari only, so send them there rather than to a dead end
 *   "unsupported"  — no push at all (old browser, some desktop configs)
 */
export function pushPath() {
  /* FIRST, before anything else is asked. A native build has no PushManager
     and no service worker — it goes through APNs and FCM instead — so every
     test below would come to the wrong conclusion about it. Checked here once
     rather than guarded at each call site, where it would eventually be
     forgotten. */
  if (isNativeApp()) return "native";

  const hasSW = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const hasPush = typeof window !== "undefined" && "PushManager" in window;

  if (isIOS()) {
    if (isStandalone()) return hasPush ? "ready" : "unsupported";
    return isIOSSafari() ? "install" : "ios-browser";
  }
  return hasSW && hasPush ? "ready" : "unsupported";
}

/** Granted / denied / default — without throwing where Notification is absent. */
export function permission() {
  try { return typeof Notification === "undefined" ? "unsupported" : Notification.permission; }
  catch { return "unsupported"; }
}

/* ------------------------------------------------- Android's own prompt --- */
/* Chrome fires beforeinstallprompt when it decides the app is installable, and
   that event is the ONLY way to show the real install dialog. It fires once and
   early — often before React has mounted — so it is captured here, at import
   time, and handed over later. */

let deferred = null;
let onChange = () => {};

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();          // stop Chrome's own mini-banner
    deferred = e;
    onChange(true);
  });
  window.addEventListener("appinstalled", () => { deferred = null; onChange(false); });
}

export const canPromptInstall = () => deferred !== null;
export const watchInstallable = (fn) => { onChange = fn; return () => { onChange = () => {}; }; };

/** Show Chrome's install dialog. Returns true if they accepted. */
export async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  onChange(false);
  try {
    e.prompt();
    const { outcome } = await e.userChoice;
    return outcome === "accepted";
  } catch { return false; }
}

/* ------------------------------------------- carrying a follow across ----- */
/* An iPhone's home-screen app gets its own storage and cannot see anything
   Safari saved, so a follow made in the tab would be stranded. Add to Home
   Screen bookmarks the CURRENT url — including its hash — so a claim code
   parked there travels across with them and the installed app redeems it. */

const CLAIM_KEY = "c";

export function parkClaimCode(code) {
  try {
    const url = new URL(window.location.href);
    url.hash = `${CLAIM_KEY}=${code}`;
    window.history.replaceState({}, "", url.toString());
    return true;
  } catch { return false; }
}

export function takeClaimCode() {
  try {
    const h = (window.location.hash || "").replace(/^#/, "");
    const m = new URLSearchParams(h).get(CLAIM_KEY);
    return m && /^[A-Z0-9]{6,40}$/.test(m) ? m : null;
  } catch { return null; }
}

/** Once redeemed the code is spent — take it out of the address bar. */
export function clearClaimCode() {
  try {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState({}, "", url.toString().replace(/#$/, ""));
  } catch {}
}
