/* Dealtitude service worker.
 *
 * The shell is cached so the app opens offline, but the code is fetched from
 * the network FIRST. An earlier version was cache-first for everything, which
 * meant a redeploy could keep serving the old bundle to anyone who already had
 * the app installed. Icons stay cache-first — they never change.
 */
const BUILD = "2026-10-15d";
const CACHE = "dealtitude-" + BUILD;
const SHELL = ["./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

/* Anything here must be the freshest copy available, not whatever we saw last. */
const isCode = (url) => url.pathname.endsWith("/") ||
  /\/(index\.html|app\.js|config\.js|manifest\.webmanifest)$/.test(url.pathname);

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})            // a missing file must not block the update
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  /* Navigations and code: network first, cache only as the offline fallback. */
  if (req.mode === "navigate" || isCode(url)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  /* Everything else (icons, images): cache first. */
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
    )
  );
});

/* Lets the page ask which build is actually running. */
self.addEventListener("message", (e) => {
  if (e.data === "build" && e.source) e.source.postMessage({ build: BUILD });
});

/* ---------------------------------------------------------------------------
 * Receiving an alert.
 *
 * This is the product. Everything else is scaffolding around the moment a
 * notification lands on a lock screen.
 * ------------------------------------------------------------------------- */

/* The page leaves the API address and this device's token where the worker can
   read them, because a notification is usually tapped with no page open. */
const CFG = "dealtitude-cfg";
async function cfg() {
  try {
    const hit = await caches.open(CFG).then((c) => c.match("/__cfg"));
    return hit ? await hit.json() : null;
  } catch { return null; }
}

self.addEventListener("push", (e) => {
  /* Never let a malformed payload swallow the notification silently: the
     browser shows its own "site updated in the background" box if we end the
     event without showing anything, which is worse than a plain fallback. */
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Dealtitude" }; }

  const title = d.title || "Dealtitude";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/badge-72.png",
    /* One notification per post. A retry must replace, not stack. */
    tag: d.postId ? "post-" + d.postId : undefined,
    renotify: false,
    data: { postId: d.postId || null, shop: d.shop || null, kind: d.kind || null },
  }));
});

/* Tapping focuses the app on that shop, and tells the API the alert was read.
   That number is the honest answer to "is this app bringing me business" —
   so it is recorded here, where the tap actually happens, rather than being
   inferred later. */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { postId, shop } = e.notification.data || {};
  const target = shop ? `./${shop}` : "./index.html";

  e.waitUntil((async () => {
    if (postId) {
      const c = await cfg();
      if (c?.api && c?.token) {
        try {
          await fetch(`${c.api}/v1/posts/${postId}/opened`, {
            method: "POST", keepalive: true,
            headers: { authorization: `Bearer ${c.token}` },
          });
        } catch { /* the tap still has to open the app */ }
      }
    }

    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) {
      if ("focus" in client) {
        client.postMessage({ open: { shop, postId } });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

/* A browser may rotate a push subscription on its own. Without this the
   follower goes quiet and nobody finds out — they are still counted as a
   follower while hearing nothing. Re-subscribe and tell the API, keyed on the
   device token so the existing follows stay attached. */
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const c = await cfg();
    if (!c?.api || !c?.token || !c?.vapid) return;
    const b64 = (s) => {
      const pad = "=".repeat((4 - (s.length % 4)) % 4);
      const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
      return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    };
    try {
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: b64(c.vapid),
      });
      const j = fresh.toJSON();
      await fetch(`${c.api}/v1/device`, {
        method: "PATCH",
        headers: { "content-type": "application/json",
                   authorization: `Bearer ${c.token}` },
        body: JSON.stringify({ endpoint: j.endpoint,
                               p256dh: j.keys.p256dh, auth: j.keys.auth }),
      });
    } catch { /* nothing useful to do here; the page retries on next open */ }
  })());
});
