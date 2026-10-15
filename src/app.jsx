import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as Native from "./native.js";
import * as API from "./api.js";
import { toStore, toProduct, toFollows, toPostBody, toReach, describeSend } from "./live.js";
import * as Install from "./install.js";
import * as Share from "./share.js";

/* =====================================================================
   Dealtitude

   Identity model: nobody chooses a role. You sign in, and the system
   works out what you are:
       invite accepted for a store  -> owner
       platform admin flag          -> admin
       neither                      -> shopper (the default)
   There is no "sign up as a store owner" path, so there is nothing to
   forge. Owner access is granted by invitation only.

   Two modes, decided by whether www/config.js names a server:

     LIVE  — real shops, real follows, real notifications to real phones.
             A shopper has no account at all: the push subscription is the
             identity, so following costs one tap. Owners sign in by email.

     DEMO  — the whole thing runs in memory on this device. This is what
             goes on a counter at a shop visit: it works with no signal,
             and nothing it does reaches a real follower.
   ===================================================================== */

/* Marigold — the same palette as the site and the explainer, so the three
   pieces read as one product. */
const T = {
  floor: "#F5EFE4", card: "#FFFDF8", ink: "#1A1410", leaf: "#2E7D5B",
  tag: "#FF9F1C", cut: "#BF4722", mute: "#7A6E62", line: "#DED3C2", dim: "#F2ECE1",
};
const FONT = `"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif`;

/* Shown on the landing screen, so a stale cached build is obvious at a glance.
   Bump it together with the CACHE string in sw.js on every redeploy. */
const BUILD = "2026-10-15d";

/* True once a server is configured. Everything live-mode does is additive:
   the screens still render from local state, so a slow network shows a stale
   number rather than an empty one. */
const LIVE = API.live;
/* The public web address a shared link points at. Shown on printed cards too,
   so the two cannot drift apart. */
const PUBLIC_BASE = (typeof window !== "undefined" && window.DEALTITUDE_WEB)
  || "https://dealtitude.com";

/* ---------------------------------------------------------------- barcodes
   A shop's catalogue is keyed by GTIN-14 so the same product scanned as a
   12-digit UPC in one shop and a 13-digit EAN in another lands on one entry.
   Check digit verified, because a misread barcode that silently becomes a new
   catalogue entry is worse than a scan that says "try again". */
const toGtin14 = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length < 8 || d.length > 14) return null;
  return d.padStart(14, "0");
};
const checkDigitValid = (gtin) => {
  if (!gtin || gtin.length !== 14) return false;
  const body = gtin.slice(0, 13), want = Number(gtin[13]);
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === want;
};

/* Shelf tags for the demo, so the flow is walkable without a real camera.
   The last one is deliberately not in any catalogue — the first-scan path is
   the one that has to feel good, because every item starts there. */
const SHELF = [
  { code: "00011110380104", name: "Basmati rice, 20 lb",   cat: "pantry",  was: "32.99", now: "24.99" },
  { code: "00074676301112", name: "Toor dal, 4 lb",        cat: "pantry",  was: "9.99",  now: "6.99"  },
  { code: "00021000658527", name: "Paneer, 400 g",         cat: "dairy",   was: "6.49",  now: "4.99"  },
  { code: "00038000138416", name: "Frozen samosas, 20 ct", cat: "frozen",  was: "8.99",  now: "5.99"  },
  { code: "00076808512038", name: "Kaju katli, 500 g",     cat: "sweets",  was: "18.99", now: "14.99" },
  { code: "00099482434250", name: "",                      cat: null,      was: "",      now: ""      },
];

/* The printed shop codes. A card says dealtitude.com/aum; this is the only
   place that mapping lives, so changing a slug never means reprinting. Keep it
   in step with www/_redirects. */
const SLUGS = {
  "aum":         "s1",
  "shore":       "s2",
  "crescent":    "s3",
  "ridgeline":   "s4",
};

const ADMIN_EMAIL = "urvik.trivedi@gmail.com";

/* The Dealtitude mark: a hanging shelf tag with two arcs off the punch hole. */
const Mark = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"
    style={{ display: "block", flexShrink: 0 }}>
    <rect width="48" height="48" rx="11" fill={T.ink} />
    <g transform="rotate(-38 24 25)">
      <path d="M17.5 9h11a4.2 4.2 0 0 1 4.2 4.2v17.1L23 40.5 13.3 30.3V13.2A4.2 4.2 0 0 1 17.5 9z"
        fill={T.tag} />
      <circle cx="23" cy="16.6" r="3.1" fill={T.ink} />
    </g>
    <path d="M33.6 12.2a7.4 7.4 0 0 1 0 9.6" stroke={T.tag} strokeWidth="2.6"
      strokeLinecap="round" fill="none" />
    <path d="M38.1 8.6a12.4 12.4 0 0 1 0 16.8" stroke={T.tag} strokeWidth="2.6"
      strokeLinecap="round" fill="none" opacity=".5" />
  </svg>
);

const CATEGORIES = [
  { id: "produce", name: "Fresh vegetables" }, { id: "dairy", name: "Paneer & dairy" },
  { id: "sweets", name: "Sweets" }, { id: "frozen", name: "Frozen & snacks" },
  { id: "pantry", name: "Spices & dry goods" }, { id: "meat", name: "Meat & Seafood" },
  { id: "bakery", name: "Bakery" }, { id: "prepared", name: "Ready to eat" },
  { id: "household", name: "Household" }, { id: "hardware", name: "Home & Garden" },
];
const catName = (id) => CATEGORIES.find((c) => c.id === id)?.name ?? id;
const CAT_ICON = { produce: "🥬", dairy: "🧈", sweets: "🍬", frozen: "🥟",
  pantry: "🫙", meat: "🐟", bakery: "🥖", prepared: "🥘", household: "🧽", hardware: "🔧" };

/* A shop has more to tell its regulars than a price. All four kinds run through
   the same machinery — tagged, filtered, capped — but the two store-wide ones
   skip the aisle filter, because "we're closed Tuesday" matters to everybody. */
const KINDS = {
  sale:    { label: "Sale",          verb: "On sale",      icon: "🏷",
             tone: "#FF9F1C", aisle: true,  price: true },
  arrival: { label: "Just arrived",  verb: "Just arrived", icon: "📦",
             tone: "#2E7D5B", aisle: true,  price: false },
  hours:   { label: "Hours",         verb: "Hours change", icon: "🕒",
             tone: "#B5751A", aisle: false, price: false },
  notice:  { label: "Announcement",  verb: "From the shop", icon: "📣",
             tone: "#6B5B4E", aisle: false, price: false },
};
const kindOf = (p) => KINDS[p.kind] || KINDS.sale;
const storeWide = (p) => !kindOf(p).aisle;

const STORES = [
  { id: "s1", name: "Brown Brothers Grocery", addr: "418 Applegate Road", town: "Monroe Township",
    hours: "8:00 AM – 9:00 PM", x: 30, y: 34,
    cats: ["produce", "dairy", "sweets", "pantry", "frozen"],
    broadcast: true, cap: 3, baseFollowers: 41 },
  { id: "s2", name: "Shore Fish & Meat", addr: "9 Depot Street", town: "Monroe Township",
    hours: "9:00 AM – 7:00 PM", x: 66, y: 22, cats: ["meat", "prepared"],
    broadcast: true, cap: 4, baseFollowers: 23 },
  { id: "s3", name: "Crescent Bakery", addr: "77 Linden Avenue", town: "Edison",
    hours: "6:30 AM – 4:00 PM", x: 48, y: 62, cats: ["bakery", "sweets", "prepared"],
    broadcast: true, cap: 2, baseFollowers: 58 },
  { id: "s4", name: "Ridgeline Hardware", addr: "1240 Route 9 North", town: "Edison",
    hours: "7:00 AM – 8:00 PM", x: 76, y: 74, cats: ["hardware", "household"],
    broadcast: true, cap: 3, baseFollowers: 12 },
];

/* Zip centroids on the same abstract plane as the map. Real build uses
   Census ZCTA centroids — public domain, a few hundred rows for Middlesex. */
const ZIPS = {
  "08831": { town: "Monroe Township", x: 38, y: 30 },
  "08820": { town: "Edison", x: 58, y: 66 },
  "08837": { town: "Edison", x: 62, y: 60 },
  "08850": { town: "Milltown", x: 12, y: 86 },
  "08512": { town: "Cranbury", x: 20, y: 14 },
  "07067": { town: "Colonia", x: 88, y: 92 },
};
const RADIUS_UNITS = 35;
const MI_PER_UNIT = 0.14;

const SEED = [
  { id: "p1", kind: "sale", store: "s1", cat: "produce", name: "Methi bunches",
    unit: "each", was: 299, now: 149, ends: "Today, 9:00 PM", status: "active" },
  { id: "p2", kind: "sale", store: "s1", cat: "dairy", name: "Fresh paneer, 400g",
    unit: "each", was: 749, now: 499, ends: "Today, 9:00 PM", status: "active" },
  { id: "p3", kind: "arrival", store: "s1", cat: "produce", name: "Alphonso mangoes",
    note: "First crate of the season. Limited, while they last.",
    ends: "This week", status: "active" },
  { id: "p4", kind: "hours", store: "s1", name: "Closed Tuesday for Diwali",
    note: "Back open Wednesday at 8:00 AM.", ends: "Tue", status: "active" },
  { id: "p5", kind: "sale", store: "s1", cat: "sweets", name: "Kaju katli, 500g box",
    unit: "box", was: 1899, now: 1299, ends: "Sun, 9:00 PM", status: "expired" },
  { id: "p6", kind: "sale", store: "s2", cat: "meat", name: "Wild-caught cod fillet",
    unit: "per lb", was: 1499, now: 899, ends: "Today, 7:00 PM", status: "active" },
  { id: "p7", kind: "notice", store: "s2", name: "Now taking catering orders",
    note: "Fish fry and biryani trays for parties. Ask at the counter.",
    ends: "Ongoing", status: "active" },
  { id: "p8", kind: "sale", store: "s3", cat: "bakery", name: "Almond croissants, 4-pack",
    unit: "pack", was: 1200, now: 600, ends: "Today, 4:00 PM", status: "active" },
  { id: "p9", kind: "hours", store: "s3", name: "Open till 8:00 PM this weekend",
    note: "Extra hours Saturday and Sunday for the festival.",
    ends: "Sun", status: "active" },
];


/* Simulated account chooser. Each lands somewhere different — which is the
   whole point: same button, role derived from who you turn out to be. */
const ACCOUNTS = [
  { name: "Priya Shah", email: "priya.shah@gmail.com", initial: "P",
    hint: "No store access — lands as a shopper" },
  { name: "Brown Brothers Grocery", email: "owner@brownbrosgrocery.com", initial: "B",
    hint: "Has a pending invite from you" },
  { name: "Urvik Trivedi", email: ADMIN_EMAIL, initial: "U",
    hint: "Platform admin" },
];

/* Prices are integer cents everywhere — server, wire, screen. A missing one
   prints nothing rather than "$NaN", which is the sort of thing a shopper
   screenshots and a shop owner never forgets. */
const money = (c) => (c == null || Number.isNaN(Number(c)) ? "" : `$${(Number(c) / 100).toFixed(2)}`);
const pct = (was, now) =>
  (was && now != null && was > now ? Math.round(((was - now) / was) * 100) : null);
const uid = () => Math.random().toString(36).slice(2, 9);
const stamp = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const miles = (u) => `${(u * MI_PER_UNIT).toFixed(1)} mi`;

/* Sunday first, matching how the days come back from a Date. */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* 24-hour input, 12-hour display — a shopkeeper reads "8:00 PM", not "20:00". */
const prettyTime = (hhmm) => {
  if (!hhmm) return "";
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h)) return String(hhmm);
  const ampm = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m || 0).padStart(2, "0")} ${ampm}`;
};

/* Turns the picker's answer into the one line a shopper sees. Runs of days are
   collapsed — "Mon–Sat" rather than six names — and a shop open every day just
   says so. */
const describeHours = (days, open, close) => {
  if (!days?.length || !open || !close) return "";
  const when = `${prettyTime(open)} – ${prettyTime(close)}`;
  if (days.length === 7) return `Every day, ${when}`;

  const sorted = [...days].sort((a, b) => a - b);
  const runs = [];
  for (const d of sorted) {
    const last = runs.at(-1);
    if (last && d === last.at(-1) + 1) last.push(d);
    else runs.push([d]);
  }
  const label = runs
    .map((r) => r.length > 2 ? `${DAY_NAMES.at(r[0])}–${DAY_NAMES.at(r.at(-1))}`
                             : r.map((d) => DAY_NAMES.at(d)).join(", "))
    .join(", ");
  return `${label}, ${when}`;
};

/* datetime-local speaks the phone's local clock, not UTC. Building it from the
   parts avoids toISOString, which would silently shift a 9pm sale by hours. */
const localNow = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* Back into something a shopper reads on a lock screen. */
const humanEnds = (v) => {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  const tomorrow = new Date(today.getTime() + 864e5);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
};

/* Opening hours are free text a shopkeeper typed, so anything may be in there.
   Takes the part after a dash of any kind, and gives back nothing rather than
   "open till undefined" when there isn't one. */
const closingTime = (hours) => {
  if (!hours) return "";
  const parts = String(hours).split(/\s[–—-]\s/);
  return parts.length > 1 ? parts.at(-1).trim() : "";
};

/* ---- real OS notifications ----
   In the App Store / Play Store build these go through APNs and FCM and the
   home-screen step doesn't exist. On the web the old PWA path still applies,
   so one codebase serves both. src/native.js is the only file that knows
   which one is running. */
const NATIVE = Native.isNative;

const isStandalone = () => {
  if (NATIVE) return true;                  // an installed app always counts
  try {
    return window.matchMedia("(display-mode: standalone)").matches ||
           window.navigator.standalone === true;
  } catch { return false; }
};

/* Kept synchronous for every caller. The native path resolves a moment later
   and reports a failure through onNotifyFail. */
let onNotifyFail = () => {};
const notify = (title, body, tag) => {
  if (NATIVE) {
    Native.notify(title, body, { tag })
      .then((r) => { if (r !== true) onNotifyFail(r); })
      .catch(() => onNotifyFail("error"));
    return "ok";
  }
  try {
    if (typeof Notification === "undefined")
      return isStandalone() ? "unsupported" : "not-installed";
    if (Notification.permission === "denied") return "denied";
    if (Notification.permission !== "granted") return "not-allowed";
    const opts = { body, tag: tag || "dealtitude", icon: "icons/icon-192.png",
      badge: "icons/icon-192.png", renotify: true };
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => {});
    } else {
      new Notification(title, opts);
    }
    return "ok";
  } catch { return "error"; }
};

const NOTIF_HELP = {
  "not-installed": "Add this app to your home screen first — iOS only allows notifications from an installed app, never from a Safari tab.",
  "not-allowed": NATIVE ? "Tap below and choose Allow when your phone asks."
                        : "Tap below and choose Allow when iOS asks.",
  denied: NATIVE
    ? "Notifications are blocked for Dealtitude. Turn them back on in your phone's Settings → Notifications → Dealtitude."
    : "Notifications are blocked. Turn them back on in iOS Settings → Notifications → Dealtitude.",
  unsupported: "This browser can't show notifications. Open the installed app on iOS 16.4 or later.",
  /* Your phone is willing; we failed to record where to reach it. Said plainly
     because the fix is to retry, not to go digging in phone settings. */
  server: "Your phone is ready, but we couldn't reach the server to save it. Check your connection and reopen the app.",
  error: "Something went wrong sending that one.",
};

/* ============================ chrome ============================ */

function PriceTag({ was, now, size = 1, tilt = true }) {
  const off = pct(was, now);
  /* A "was" price is optional — plenty of shops post a price without claiming
     a discount. Only show the comparison when there is a real saving to show;
     otherwise this rendered "% off / $NaN" on the first screen after a scan. */
  const showOff = off != null && off > 0;
  return (
    <div style={{ display: "inline-flex", transform: tilt ? "rotate(-2.2deg)" : "none" }}>
      <div style={{ background: T.tag, color: T.ink, padding: `${5 * size}px ${9 * size}px`,
        fontWeight: 800, fontSize: 20 * size, lineHeight: 1, letterSpacing: "-0.04em",
        fontVariantNumeric: "tabular-nums",
        borderRadius: showOff ? "2px 0 0 2px" : 2 }}>{money(now)}</div>
      {showOff && (
        <div style={{ background: T.ink, color: T.tag, padding: `${5 * size}px ${7 * size}px`,
          fontWeight: 700, fontSize: 11 * size, lineHeight: 1.1, borderRadius: "0 2px 2px 0",
          display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{off}% off</span>
          <span style={{ opacity: 0.6, textDecoration: "line-through",
            fontWeight: 500 }}>{money(was)}</span>
        </div>
      )}
    </div>
  );
}

/* iOS's share glyph, drawn rather than described. People recognise the shape
   long before they read the word "Share". */
const ShareGlyph = ({ size = 20, color = "#0A84FF" }) => (
  <svg width={size} height={size * 1.22} viewBox="0 0 18 22" aria-hidden="true"
    style={{ display: "block", flexShrink: 0 }}>
    <path d="M9 1.6v12.2" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
    <path d="M5.1 5.3 9 1.4l3.9 3.9" stroke={color} strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M4.2 8.6H2.9v11.3h12.2V8.6h-1.3" stroke={color} strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

/* ---------------------------------------------------------------------------
 * The iPhone step.
 *
 * Apple does not allow a website to send notifications until it has been added
 * to the home screen. That is not a flaw in this app and it should not read
 * like one — so this is a short, visual instruction that ends with the shop's
 * icon on their phone, not an apology for a missing feature.
 *
 * The arrow points DOWN because Safari's share button sits in the bottom bar
 * on an iPhone. On an iPad it is top-right, so the arrow flips.
 * ------------------------------------------------------------------------- */
function AddToHomeScreen({ store, onClose, bottomBar = true }) {
  const step = { display: "flex", gap: 11, alignItems: "flex-start", marginBottom: 13 };
  const num = {
    width: 21, height: 21, borderRadius: 999, background: T.ink, color: T.tag,
    fontSize: 11.5, fontWeight: 800, display: "grid", placeItems: "center",
    flexShrink: 0, marginTop: 1,
  };
  const body = { fontSize: 13.5, lineHeight: 1.45, color: T.ink };

  return (
    <>
      <style>{`@keyframes dtNudge{0%,100%{transform:translateY(0);opacity:.55}
        50%{transform:translateY(9px);opacity:1}}`}</style>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 60,
        background: "rgba(22,33,28,.62)", animation: "fade .22s ease" }} />

      <div style={{ position: "absolute", left: 0, right: 0,
        [bottomBar ? "bottom" : "top"]: 0, zIndex: 61, padding: "0 10px 10px",
        animation: "rise .3s cubic-bezier(.2,.9,.3,1.05)" }}>

        <div style={{ background: T.card, borderRadius: 20, padding: "20px 18px 16px",
          boxShadow: "0 18px 50px rgba(22,33,28,.4)" }}>

          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
            <Mark size={42} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 17.5, fontWeight: 800, letterSpacing: "-0.02em",
                lineHeight: 1.15 }}>Put {store?.name || "this shop"} on your phone</div>
              <div style={{ fontSize: 12.5, color: T.mute, marginTop: 3 }}>
                Takes about ten seconds. Then the alerts work.</div>
            </div>
          </div>

          <div style={{ background: T.dim, borderRadius: 13, padding: "14px 14px 3px" }}>
            <div style={step}>
              <div style={num}>1</div>
              <div style={body}>Tap <b>Share</b> <span style={{ display: "inline-flex",
                verticalAlign: "-4px", margin: "0 1px" }}><ShareGlyph size={15} /></span>
                {bottomBar ? " at the bottom of the screen" : " at the top right"}</div>
            </div>
            <div style={step}>
              <div style={num}>2</div>
              <div style={body}>Scroll down and tap <b>Add to Home Screen</b></div>
            </div>
            <div style={step}>
              <div style={num}>3</div>
              <div style={body}>Open it from your home screen and tap
                <b> Turn on alerts</b></div>
            </div>
          </div>

          <div style={{ fontSize: 11.5, color: T.mute, lineHeight: 1.5,
            margin: "13px 2px 0" }}>
            You're already following — this is only so {store?.name || "the shop"} can
            reach you. Apple requires it for any app that isn't from the App Store.
          </div>

          <button onClick={onClose} style={{ width: "100%", marginTop: 14,
            background: "transparent", border: `1.5px solid ${T.line}`, borderRadius: 11,
            padding: "11px 0", fontFamily: FONT, fontSize: 14, fontWeight: 700,
            color: T.mute, cursor: "pointer" }}>I'll do it later</button>
        </div>

        {/* the nudge toward Safari's own share button, just below this card */}
        {bottomBar && (
          <div style={{ display: "grid", placeItems: "center", paddingTop: 8 }}>
            <svg width="30" height="34" viewBox="0 0 30 34" aria-hidden="true"
              style={{ animation: "dtNudge 1.5s ease-in-out infinite" }}>
              <path d="M15 2v23" stroke={T.tag} strokeWidth="3.4" strokeLinecap="round" />
              <path d="M6.5 18.5 15 27l8.5-8.5" stroke={T.tag} strokeWidth="3.4"
                strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </div>
        )}
      </div>
    </>
  );
}

const Chip = ({ on, children, onClick, disabled, title }) => (
  <button onClick={disabled ? undefined : onClick} disabled={disabled} title={title}
    style={{
      border: `1.5px solid ${disabled ? T.dim : on ? T.leaf : T.line}`,
      background: disabled ? T.dim : on ? T.leaf : "transparent",
      color: disabled ? T.mute : on ? "#fff" : T.mute,
      borderRadius: 999, padding: "6px 12px", fontSize: 12.5, fontWeight: 600,
      fontFamily: FONT, whiteSpace: "nowrap",
      opacity: disabled ? 0.55 : 1,
      cursor: disabled ? "not-allowed" : "pointer",
    }}>{children}</button>
);

function Btn({ children, onClick, kind = "solid", full, disabled }) {
  const kinds = {
    solid: { background: T.leaf, color: "#fff" },
    ghost: { background: "transparent", color: T.ink, borderColor: T.line },
    tag: { background: T.tag, color: T.ink },
    dark: { background: T.ink, color: "#fff" },
    white: { background: "#fff", color: T.ink, borderColor: T.line },
    onDark: { background: "transparent", color: "rgba(255,255,255,.85)",
              borderColor: "rgba(255,255,255,.28)" },
  };
  return <button disabled={disabled} onClick={onClick} style={{
    fontFamily: FONT, fontSize: 14.5, fontWeight: 700, borderRadius: 10, padding: "12px 16px",
    cursor: disabled ? "not-allowed" : "pointer", width: full ? "100%" : undefined,
    opacity: disabled ? 0.45 : 1, border: "1.5px solid transparent", ...kinds[kind],
  }}>{children}</button>;
}

/* On a real device the app IS the phone: no drawn bezel, no mock status bar,
   full bleed, and real safe-area insets for the notch and home indicator.
   The frame is only the desktop/demo presentation. */
/* ---------------------------------------------------------------------------
 * Full screen on a phone, framed on a desktop.
 *
 * The phone frame — bezel, drop shadow, the little "7:34 PM · LTE · 82%" bar —
 * is a demo device. On a laptop it reads as a product shot and it is what makes
 * the walk-in demo land. On an actual phone it is a disaster: a toy phone
 * floating inside a real one, with a fake battery indicator sitting under the
 * real battery indicator. That single detail would tell every customer at the
 * register that this is a mock-up.
 *
 * So the frame is for wide screens only. Anything phone-sized, installed, or
 * native gets the whole screen, like any other app.
 * ------------------------------------------------------------------------- */
const FRAME_ABOVE = 560;      // px of viewport width

function useFramed() {
  const [framed, setFramed] = useState(() => {
    try {
      return !NATIVE && !isStandalone() && window.innerWidth >= FRAME_ABOVE;
    } catch { return false; }
  });
  useEffect(() => {
    const read = () => {
      try {
        setFramed(!NATIVE && !isStandalone() && window.innerWidth >= FRAME_ABOVE);
      } catch {}
    };
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);
  return framed;
}

function Phone({ children, banner, sheet }) {
  const framed = useFramed();
  if (NATIVE || !framed) {
    return (
      <div style={{ position: "fixed", inset: 0, background: T.dim, display: "flex",
        flexDirection: "column", overflow: "hidden",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)" }}>
        {banner}
        {children}
        {sheet}
      </div>
    );
  }
  return (
    <div style={{ width: "min(372px, 100%)", background: T.ink, borderRadius: 38, padding: 10,
      boxShadow: "0 24px 48px -18px rgba(22,33,28,.45)", flexShrink: 0 }}>
      <div style={{ background: T.dim, borderRadius: 29, height: "min(730px, 78vh)",
        overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
        <div style={{ height: 30, display: "flex", alignItems: "center",
          justifyContent: "space-between", padding: "0 20px", fontSize: 11.5,
          fontWeight: 700, flexShrink: 0 }}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{stamp()}</span>
          <span style={{ opacity: 0.45 }}>LTE ▂▄▆ 82%</span>
        </div>
        {banner}
        {children}
        {sheet}
      </div>
    </div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", borderTop: `1px solid ${T.line}`, background: T.card, flexShrink: 0 }}>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          flex: 1, padding: "11px 0 16px", border: "none", background: "none", cursor: "pointer",
          fontFamily: FONT, display: "flex", flexDirection: "column", alignItems: "center",
          gap: 3, position: "relative", color: active === t.id ? T.leaf : T.mute,
          borderTop: `2.5px solid ${active === t.id ? T.leaf : "transparent"}`, marginTop: -1,
        }}>
          <span style={{ fontSize: 17 }}>{t.icon}</span>
          <span style={{ fontSize: 10.5, fontWeight: 700 }}>{t.label}</span>
          {t.badge > 0 && <span style={{ position: "absolute", top: 6, right: "50%",
            marginRight: -22, background: T.cut, color: "#fff", fontSize: 9.5, fontWeight: 800,
            borderRadius: 999, padding: "1px 5px" }}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

const Scroll = ({ children }) => (
  /* overflowX hidden and minWidth 0: a single long word — a slug, an address,
     a shop name a shopkeeper typed — used to be able to push the whole pane
     sideways, and the sideways scroll then applies to every screen rather than
     the one element that caused it. */
  <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minWidth: 0,
    padding: 16, background: T.dim, WebkitOverflowScrolling: "touch" }}>{children}</div>
);

const Head = ({ title, sub, right, onBack }) => (
  <div style={{ background: T.card, borderBottom: `1px solid ${T.line}`, flexShrink: 0 }}>
    {onBack && <button onClick={onBack} style={{ border: "none", background: "none",
      color: T.mute, fontFamily: FONT, fontSize: 13, fontWeight: 700,
      padding: "8px 14px 0", cursor: "pointer" }}>‹ Back</button>}
    <div style={{ padding: onBack ? "4px 16px 12px" : "10px 16px 12px", display: "flex",
      alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: "-0.02em" }}>{title}</div>
        {sub && <div style={{ fontSize: 12.5, color: T.mute, marginTop: 2 }}>{sub}</div>}
      </div>
      {right}
    </div>
  </div>
);

const Avatar = ({ session, onClick, size = 30 }) => (
  <button onClick={onClick} style={{ width: size, height: size, borderRadius: 999,
    border: "none", background: session ? T.leaf : T.line, color: "#fff", fontFamily: FONT,
    fontSize: size * 0.42, fontWeight: 800, cursor: "pointer", flexShrink: 0 }}>
    {session ? session.initial : "?"}
  </button>
);

function NotifCard({ notifState, standalone, lastFail, onEnable, onTest, who, token,
                    onInstall, onAndroidInstall, canInstall, debug }) {
  const ok = notifState === "granted";
  const blocked = notifState === "denied";
  /* On an iPhone in Safari there is nothing to allow yet — Apple won't offer
     the prompt until the app is on the home screen. So this card must lead to
     the install, not to a greyed-out button that looks broken. */
  const needsInstall = !NATIVE && Install.pushPath() === "install";
  const line = ok
    ? `On. ${who} alerts will buzz this phone even with the app closed.`
    : needsInstall ? NOTIF_HELP["not-installed"]
    : blocked ? NOTIF_HELP.denied : NOTIF_HELP["not-allowed"];
  return (
    <div style={{ background: ok ? T.card : T.ink, color: ok ? T.ink : "#fff",
      border: `1px solid ${ok ? T.line : T.ink}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, flexShrink: 0,
          background: ok ? T.leaf : blocked ? T.cut : T.tag }} />
        <div style={{ fontSize: 14, fontWeight: 800 }}>
          {ok ? "Notifications are on" : "Notifications are off"}</div>
      </div>
      <div style={{ fontSize: 12, color: ok ? T.mute : "rgba(255,255,255,.7)",
        margin: "6px 0 11px", lineHeight: 1.45 }}>{line}</div>
      <div style={{ display: "flex", gap: 8 }}>
        {!ok && <div style={{ flex: 1 }}>
          {needsInstall
            ? <Btn kind="tag" full onClick={onInstall}>Add to home screen</Btn>
            : <Btn kind="tag" full disabled={blocked} onClick={onEnable}>
                Allow notifications</Btn>}
        </div>}
        {/* Proving delivery matters to a shopkeeper who is about to rely on it.
            A shopper has nothing to test and no reason to send themselves one,
            so this is passed in only on the owner's side. */}
        {onTest && <div style={{ flex: 1 }}>
          <Btn kind={ok ? "dark" : "ghost"} full onClick={onTest}>Send a test alert</Btn></div>}
      </div>
      {/* Alerts already work on Android without installing — this is only so
          the shop ends up with an icon like any other app. */}
      {ok && canInstall && (
        <div style={{ marginTop: 9 }}>
          <Btn kind="ghost" full onClick={onAndroidInstall}>
            Add Dealtitude to your home screen</Btn>
        </div>
      )}
      {lastFail && lastFail !== "ok" && (
        <div style={{ fontSize: 11.5, color: ok ? T.cut : T.tag, marginTop: 10, lineHeight: 1.45 }}>
          Last alert didn't appear: {NOTIF_HELP[lastFail] || lastFail}</div>
      )}
      {debug && <div style={{ fontSize: 10.5, color: ok ? T.mute : "rgba(255,255,255,.45)",
        marginTop: 10, paddingTop: 9,
        borderTop: `1px solid ${ok ? T.dim : "rgba(255,255,255,.12)"}`,
        fontFamily: "ui-monospace, Menlo, monospace", lineHeight: 1.6 }}>
        {NATIVE
          ? <>app {Native.platform} · permission {notifState} ·{" "}
              push token {token ? token.slice(0, 10) + "…" : "none yet"}</>
          : <>web · installed {standalone ? "yes" : "no"} · permission {notifState} ·{" "}
              api {typeof Notification === "undefined" ? "missing" : "present"}</>}
      </div>}
    </div>
  );
}

const WHY = {
  delivered: ["Delivered", "The alert went out and should be on the lock screen."],
  nobody_follows: ["Nobody follows this shop yet",
    "The post is saved and reaches anyone who follows from here on. Shoppers "
    + "find the shop by searching its ZIP, or by opening the address on its card."],
  category_off: ["That category is switched off", "You turned this category off on the store page, so the alert was held back."],
  all_held: ["Nobody was alerted", "This shop has followers, but none of them could be "
    + "reached by this post. The reason for each one is above."],
  daily_cap: ["Daily cap reached", "Maximum alerts from this store today. Raise the cap in owner settings."],
  duplicate: ["Already sent recently", "The same item was broadcast moments ago."],
};

/* The server answers with phrases like "1 aisle switched off". Printing that
   alone leaves the owner holding a symptom, and printing the raw reason code
   is worse — it is the fastest way to look unfinished. Each phrase is matched
   to the one thing that would actually change the outcome. */
const FIX = [
  [/without this aisle picked/,
   "They haven't picked this aisle, so only shop-wide news reaches them. Post in an aisle they follow — or ask them to add this one."],
  [/with alerts switched off/,
   "They follow the shop but haven't allowed alerts yet, so they'll see this in the app's feed and not on the lock screen. On an iPhone that means adding the app to the home screen and allowing notifications."],
  [/alert keys aren't set up/,
   "This one is on us, not on them — Dealtitude's notification keys aren't set up on the server yet, so no alert could leave the building. The post is saved and the follower sees it in their feed."],
  [/refused by the alert service/,
   "Apple or Google turned the alert away this time. The post is saved; try again shortly, and tell us if it keeps happening."],
  [/no longer using the app/,
   "They removed the app or revoked notifications, so this follower is no longer reachable and won't be counted in your reach figure."],
  [/age not confirmed/,
   "They haven't confirmed they're old enough for this shop, so nothing from it reaches them until they do."],
  [/at today's limit/,
   "They've already had the most alerts this shop sends in a day. Raise the cap in settings."],
  [/muting this shop/,
   "They've muted this shop, so nothing reaches them until they unmute it."],
];

function DecisionCard({ decision }) {
  if (!decision) return null;
  const [fallbackTitle, fallbackDetail] = WHY[decision.reason] || WHY.all_held;
  const good = decision.recipients > 0;
  const held = decision.held || [];

  /* De-duplicated, because two withheld followers for the same reason need
     telling once. */
  const fixes = [...new Set(held
    .map((h) => (FIX.find(([re]) => re.test(h)) || [])[1])
    .filter(Boolean))];

  return (
    <div style={{ background: T.card, border: `1px solid ${good ? T.leaf : T.cut}`,
      borderLeft: `3px solid ${good ? T.leaf : T.cut}`, borderRadius: 10, padding: 13, marginBottom: 14 }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, color: good ? T.leaf : T.cut }}>
        {good ? `Sent to ${decision.recipients} follower${decision.recipients === 1 ? "" : "s"}` : fallbackTitle}
      </div>
      <div style={{ fontSize: 12, color: T.mute, marginTop: 5, lineHeight: 1.45 }}>
        {decision.product} · {decision.cat} · {decision.store}</div>

      {decision.askedReached > 0 && (
        <div style={{ fontSize: 12.5, fontWeight: 700, color: T.leaf, marginTop: 7,
          lineHeight: 1.45 }}>
          {decision.askedReached === 1
            ? "One of them had asked for this item."
            : `${decision.askedReached} of them had asked for this item.`}
        </div>
      )}

      {held.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 7, fontWeight: 700, lineHeight: 1.45 }}>
          Held back: {held.join(", ")}.
        </div>
      )}
      {!good && (fixes.length
        ? fixes.map((f, i) => (
            <div key={i} style={{ fontSize: 12, color: T.mute, marginTop: 6, lineHeight: 1.45 }}>{f}</div>
          ))
        : <div style={{ fontSize: 12, marginTop: 7, lineHeight: 1.45 }}>{fallbackDetail}</div>)}
    </div>
  );
}

/* ====================== onboarding / identity ====================== */

function Landing({ zip, setZip, onGo, err, onSignIn, signedInAs }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.dim,
      padding: "22px 20px 18px", overflowY: "auto" }}>
      {/* The logo leads, rather than sitting under a sign-in link a shopper
          will never use. */}
      <div style={{ marginBottom: 26 }}><Mark size={68} /></div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <h1 style={{ fontSize: 31, fontWeight: 800, letterSpacing: "-0.035em",
          lineHeight: 1.08, margin: "0 0 10px" }}>
          Hear it from the<br />shops you already<br />walk into.</h1>
        <p style={{ fontSize: 14, color: T.mute, lineHeight: 1.5, margin: "0 0 20px", maxWidth: 310 }}>
          Something on sale, something that just came in, a change of hours, a word
          from the counter. Follow the shops you use, pick the aisles you buy from,
          and hear nothing else.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 24 }}>
          {Object.values(KINDS).map((k) => (
            <span key={k.label} style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em",
              color: k.tone, border: `1.5px solid ${k.tone}`, borderRadius: 999,
              padding: "4px 9px", textTransform: "uppercase" }}>{k.label}</span>
          ))}
        </div>

        <label style={{ fontSize: 11.5, fontWeight: 800, color: T.mute, display: "block",
          marginBottom: 6 }}>Your ZIP code</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
            onKeyDown={(e) => e.key === "Enter" && onGo()}
            placeholder="Enter ZIP" inputMode="numeric" style={{ flex: 1, padding: "13px 14px",
              borderRadius: 10, border: `1.5px solid ${err ? T.cut : T.line}`, fontFamily: FONT,
              fontSize: 17, fontWeight: 700, letterSpacing: "0.04em", background: T.card,
              boxSizing: "border-box", minWidth: 0 }} />
          <Btn onClick={onGo} disabled={zip.length !== 5}>See shops</Btn>
        </div>
        {err && <div style={{ fontSize: 12, color: T.cut, marginTop: 8 }}>{err}</div>}
        {!LIVE && <div style={{ fontSize: 11.5, color: T.mute, marginTop: 12, lineHeight: 1.5 }}>
          No account needed to look. You only sign in when you follow a shop, so we have
          somewhere to send the alert.
        </div>}
      </div>

      {/* The shopkeeper's door, out of a shopper's way. Labelled in full, because
          "Shop owner" alone reads like a filter rather than a way in. */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center",
        gap: 12, paddingTop: 10 }}>
        <span style={{ fontSize: 10, color: T.mute, opacity: .7,
          letterSpacing: ".04em" }}>BUILD {BUILD}</span>
        <button onClick={onSignIn} style={{ border: `1px solid ${T.line}`, background: T.card,
          color: T.mute, fontFamily: FONT, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          padding: "8px 13px", borderRadius: 99 }}>
          {signedInAs ? "My shop" : LIVE ? "Shop Owner Login" : "Sign in"}</button>
      </div>
    </div>
  );
}

/* How far away a shop is, in words a person would use.
 *
 * The distance comes from ZIP centroids, which are accurate to about a mile —
 * so "0.0 mi away" is false precision and "0 mi" reads as "inside the shop".
 * Under a mile is said as such; beyond that one decimal is as much as the
 * underlying data can honestly carry. */
const awayText = (mi) => {
  if (mi == null || !Number.isFinite(mi)) return "";
  if (mi < 1) return "under a mile away";
  return `${mi.toFixed(1)} mi away`;
};

function StoreList({ zip, stores, products, nearest, onOpen, onChangeZip, follows,
                     onNotifyMe, notified, radius, onRadius, followedElsewhere }) {
  const live = (id) => products.filter((p) => p.store === id && p.status === "active").length;
  const zipInfo = ZIPS[zip];

  const Row = ({ s }) => (
    <button onClick={() => onOpen(s.id)} style={{ width: "100%", textAlign: "left",
      background: T.card, border: `1px solid ${follows[s.id] ? T.leaf : T.line}`,
      borderRadius: 12, padding: 14, marginBottom: 9, cursor: "pointer", fontFamily: FONT }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 800 }}>{s.name}</div>
          <div style={{ fontSize: 12, color: T.mute, marginTop: 3, lineHeight: 1.4 }}>
            {s.addr}, {s.town}
            {/* The distance is the SERVER's, measured from real ZIP centroids,
                and absent when it could not be worked out — an unknown
                distance is left blank rather than guessed at. Closing time is
                read out of free text a shopkeeper typed, so it is shown only
                when it actually parses. */}
            {(awayText(s.miles ?? s._d_mi) || closingTime(s.hours)) && <><br />
              {awayText(s.miles ?? s._d_mi)}
              {awayText(s.miles ?? s._d_mi) && closingTime(s.hours) ? " · " : ""}
              {closingTime(s.hours) ? `open till ${closingTime(s.hours)}` : ""}</>}
          </div>
          <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
            {s.cats.slice(0, 3).map((c) => (
              <span key={c} style={{ fontSize: 10.5, fontWeight: 700, color: T.mute,
                border: `1px solid ${T.line}`, borderRadius: 4, padding: "2px 6px" }}>
                {catName(c)}</span>
            ))}
            {s.cats.length > 3 && <span style={{ fontSize: 10.5, color: T.mute,
              padding: "2px 2px" }}>+{s.cats.length - 3}</span>}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {live(s.id) > 0 ? (
            <>
              <div style={{ fontSize: 26, fontWeight: 800, color: T.leaf,
                fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{live(s.id)}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.mute }}>on sale</div>
            </>
          ) : <div style={{ fontSize: 11, color: T.mute }}>nothing today</div>}
          {follows[s.id] && <div style={{ fontSize: 10, fontWeight: 800, color: T.leaf,
            marginTop: 7 }}>FOLLOWING</div>}
        </div>
      </div>
    </button>
  );

  return (
    <>
      {/* The heading states the radius actually searched. It used to say
          "within 5 miles" regardless, which was how a shop 42 miles away came
          to sit underneath those words. */}
      <Head title={zipInfo ? zipInfo.town : zip}
        sub={`${stores.length} shop${stores.length === 1 ? "" : "s"} within `
           + `${radius} miles of ${zip}`}
        right={<button onClick={onChangeZip} style={{ border: `1.5px solid ${T.line}`,
          background: "none", borderRadius: 8, padding: "6px 10px", fontFamily: FONT,
          fontSize: 12, fontWeight: 700, color: T.mute, cursor: "pointer" }}>Change</button>} />
      <Scroll>
        {/* How far they are willing to go. Theirs to set, because "near me" in
            Monroe Township and in Queens are not the same distance. */}
        {onRadius && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, color: T.mute }}>WITHIN</span>
            {[2, 5, 10, 25].map((r) => (
              <Chip key={r} on={radius === r} onClick={() => onRadius(r)}>{r} mi</Chip>
            ))}
          </div>
        )}

        {stores.length === 0 ? (
          <>
            <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
              padding: 18, marginBottom: 16, textAlign: "center" }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>🏷</div>
              <div style={{ fontSize: 16, fontWeight: 800 }}>
                No shops within {radius} miles of {zip}</div>
              <div style={{ fontSize: 13, color: T.mute, margin: "7px 0 15px", lineHeight: 1.5 }}>
                We're signing up independent grocers one town at a time. Tell us you're here
                and you'll hear the moment one joins.
              </div>
              {notified
                ? <div style={{ fontSize: 13, fontWeight: 700, color: T.leaf }}>
                    Noted — we'll be in touch about {zip}.</div>
                : <Btn kind="tag" full onClick={onNotifyMe}>Tell me when {zip} has a shop</Btn>}
            </div>
            {/* Only when there is actually something to show. Live, there is
                not: offering a shop 42 miles away as "nearest anyway" is the
                same mistake as calling it nearby. */}
            {nearest.length > 0 && (
              <>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: T.mute,
                  marginBottom: 9 }}>Nearest shops anyway</div>
                {nearest.map((s) => <Row key={s.id} s={s} />)}
              </>
            )}
          </>
        ) : (
          <>
            {/* Named, so it is obvious which list is which once a second one
                appears below it. */}
            {(followedElsewhere || []).length > 0 && (
              <div style={{ fontSize: 11.5, fontWeight: 800, color: T.mute,
                letterSpacing: ".04em", marginBottom: 9 }}>
                NEAR {zip.toUpperCase()}
              </div>
            )}
            {stores.map((s) => <Row key={s.id} s={s} />)}
          </>
        )}

        {/* Shops followed from somewhere else. On screen, because losing sight
            of a followed shop reads as a lost follow — but under their own
            heading, with their real distance, and never counted as nearby.
            A shop that is both followed AND nearby appears once, above. */}
        {(followedElsewhere || []).length > 0 && (
          <div style={{ marginTop: 22, paddingTop: 18,
            borderTop: `1px solid ${T.line}` }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: T.mute,
              letterSpacing: ".04em" }}>SHOPS YOU FOLLOW</div>
            <div style={{ fontSize: 11.5, color: T.mute, margin: "3px 0 11px",
              lineHeight: 1.45 }}>
              Outside {zip} — you keep hearing from these wherever you search.
            </div>
            {followedElsewhere.map((s) => <Row key={s.id} s={s} />)}
          </div>
        )}
      </Scroll>
    </>
  );
}

/* The real owner sign-in: an emailed link, nothing to remember.
 *
 * No password, because a shopkeeper will not keep one and a weak one on an
 * account that can notify a thousand phones is the worst trade in the product.
 * No Google or Apple button either — they look reassuring but they are a second
 * identity provider to maintain, and the address the invitation went to is the
 * one that proves who this is.
 *
 * Note what it never says: whether that email has a shop. Telling a stranger
 * which addresses are registered hands them the list for free. */
function OwnerSignIn({ onSend, onCode, onClose, sent, busy, err, devLink }) {
  const [email, setEmail] = useState("");
  /* The code road is for App Store review, where there is no inbox to send a
     link to. Folded away behind a line of text so a shopkeeper never wonders
     where their code was supposed to come from. */
  const [useCode, setUseCode] = useState(false);
  const [code, setCode] = useState("");
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50,
        background: "rgba(22,33,28,.45)", animation: "fade .2s ease" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 51,
        background: T.card, borderRadius: "20px 20px 29px 29px", padding: "18px 18px 24px",
        animation: "rise .28s cubic-bezier(.2,.9,.3,1.05)" }}>
        <div style={{ width: 36, height: 4, borderRadius: 99, background: T.line,
          margin: "0 auto 16px" }} />

        {sent ? (
          <>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>
              Check your email</div>
            <div style={{ fontSize: 13, color: T.mute, margin: "6px 0 16px", lineHeight: 1.5 }}>
              If <b style={{ color: T.ink }}>{sent}</b> manages a shop on Dealtitude, a
              sign-in link is on its way. It works once and lasts 20 minutes.
            </div>
            {devLink && (
              <div style={{ background: T.dim, border: `1px solid ${T.line}`, borderRadius: 10,
                padding: 11, marginBottom: 14 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: T.mute,
                  marginBottom: 5 }}>DEVELOPMENT — NO MAIL SENDER WIRED YET</div>
                <a href={devLink} style={{ fontSize: 11.5, color: T.leaf, wordBreak: "break-all",
                  fontFamily: "ui-monospace, Menlo, monospace" }}>{devLink}</a>
              </div>
            )}
            <Btn kind="ghost" full onClick={onClose}>Done</Btn>
          </>
        ) : (
          <>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>
              Sign in to your shop</div>
            <div style={{ fontSize: 13, color: T.mute, margin: "6px 0 16px", lineHeight: 1.5 }}>
              Use the email address your invitation went to. We'll send a link —
              no password to remember.
            </div>
            <input value={email} onChange={(e) => setEmail(e.target.value)}
              type="email" inputMode="email" autoComplete="email"
              autoCapitalize="off" spellCheck={false}
              placeholder="you@yourshop.com"
              onKeyDown={(e) => { if (e.key === "Enter" && valid && !busy) onSend(email.trim()); }}
              style={{ width: "100%", padding: "12px 13px", borderRadius: 10, fontSize: 16,
                border: `1.5px solid ${T.line}`, fontFamily: FONT, background: T.card,
                boxSizing: "border-box", marginBottom: 10 }} />
            {err && <div style={{ fontSize: 12, color: T.cut, fontWeight: 700,
              marginBottom: 10, lineHeight: 1.45 }}>{err}</div>}
            {useCode && (
              <input value={code} onChange={(e) => setCode(e.target.value)}
                autoCapitalize="off" spellCheck={false} autoComplete="one-time-code"
                placeholder="Sign-in code"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid && code.trim() && !busy)
                    onCode(email.trim(), code.trim());
                }}
                style={{ width: "100%", padding: "12px 13px", borderRadius: 10, fontSize: 16,
                  border: `1.5px solid ${T.line}`, fontFamily: FONT, background: T.card,
                  boxSizing: "border-box", marginBottom: 10 }} />
            )}
            <Btn full disabled={!valid || busy || (useCode && !code.trim())}
              onClick={() => useCode ? onCode(email.trim(), code.trim()) : onSend(email.trim())}>
              {busy ? (useCode ? "Signing in…" : "Sending…")
                    : useCode ? "Sign in" : "Email me a link"}</Btn>

            <button onClick={() => { setUseCode(!useCode); setCode(""); }}
              style={{ display: "block", margin: "12px auto 0", border: "none",
                background: "none", color: T.mute, fontFamily: FONT, fontSize: 12,
                fontWeight: 700, cursor: "pointer", padding: 4 }}>
              {useCode ? "Email me a link instead" : "Use a sign-in code instead"}</button>

            <div style={{ fontSize: 10.5, color: T.mute, marginTop: 10, lineHeight: 1.5,
              textAlign: "center" }}>
              Shoppers don't need an account at all. Shop access comes from an invitation.
            </div>
          </>
        )}
      </div>
    </>
  );
}

function SignInSheet({ step, onPick, onProvider, onClose, reason }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50,
        background: "rgba(22,33,28,.45)", animation: "fade .2s ease" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 51,
        background: T.card, borderRadius: "20px 20px 29px 29px", padding: "18px 18px 24px",
        animation: "rise .28s cubic-bezier(.2,.9,.3,1.05)" }}>
        <div style={{ width: 36, height: 4, borderRadius: 99, background: T.line,
          margin: "0 auto 16px" }} />

        {step === "providers" ? (
          <>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>
              Sign in to continue</div>
            <div style={{ fontSize: 12.5, color: T.mute, margin: "5px 0 18px", lineHeight: 1.45 }}>
              {reason || "We need somewhere to send your alerts."} One account works for
              shoppers and shop owners alike.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <Btn kind="white" full onClick={() => onProvider("google")}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#4285F4" }}>G</span>
                  Continue with Google</span></Btn>
              <Btn kind="dark" full onClick={() => onProvider("apple")}>
                 Continue with Apple</Btn>
              <Btn kind="ghost" full onClick={() => onProvider("phone")}>
                Use my phone number</Btn>
            </div>
            <div style={{ fontSize: 10.5, color: T.mute, marginTop: 15, lineHeight: 1.5,
              textAlign: "center" }}>
              Shop owners don't sign up here. Access to a shop comes from an invitation.
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>
              Choose an account</div>
            <div style={{ fontSize: 12.5, color: T.mute, margin: "5px 0 16px", lineHeight: 1.45 }}>
              Simulated for the prototype. Each one lands somewhere different — the app works
              out your role, you never pick it.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ACCOUNTS.map((a) => (
                <button key={a.email} onClick={() => onPick(a)} style={{ display: "flex",
                  alignItems: "center", gap: 12, textAlign: "left", background: T.dim,
                  border: `1px solid ${T.line}`, borderRadius: 11, padding: 12,
                  cursor: "pointer", fontFamily: FONT }}>
                  <div style={{ width: 34, height: 34, borderRadius: 999, background: T.ink,
                    color: "#fff", display: "grid", placeItems: "center", fontSize: 15,
                    fontWeight: 800, flexShrink: 0 }}>{a.initial}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{a.name}</div>
                    <div style={{ fontSize: 11.5, color: T.mute, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.email}</div>
                    <div style={{ fontSize: 10.5, color: T.leaf, fontWeight: 700,
                      marginTop: 2 }}>{a.hint}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function InviteLanding({ invite, store, onAccept, onDecline }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.ink,
      color: "#fff", padding: "26px 22px", overflowY: "auto" }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, color: T.tag, marginBottom: 18 }}>
        DEALTITUDE · INVITATION</div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ fontSize: 27, fontWeight: 800, letterSpacing: "-0.03em",
          lineHeight: 1.12, marginBottom: 12 }}>
          You've been invited to manage {store.name}</div>
        <div style={{ fontSize: 14, color: "rgba(255,255,255,.72)", lineHeight: 1.55,
          marginBottom: 22 }}>
          {/* Never "see who's following you". Followers give no name, no email
              and no phone — there is no account at all — so the shop sees how
              many are listening and which aisles they want, never who they are.
              Promising otherwise on the first screen an owner reads would be a
              promise the product is built to refuse. */}
          Urvik Trivedi set up a Dealtitude page for your shop at {store.addr}. Accept and
          you'll be able to post sales and see how many people are listening.
        </div>
        <div style={{ background: "rgba(255,255,255,.07)", borderRadius: 12, padding: 14,
          marginBottom: 22, fontSize: 12.5, lineHeight: 1.7 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "rgba(255,255,255,.55)" }}>Shop</span>
            <span style={{ fontWeight: 700 }}>{store.name}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "rgba(255,255,255,.55)" }}>Sent to</span>
            <span style={{ fontWeight: 700 }}>{invite.email}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "rgba(255,255,255,.55)" }}>Role</span>
            <span style={{ fontWeight: 700 }}>Owner</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "rgba(255,255,255,.55)" }}>Link expires</span>
            <span style={{ fontWeight: 700 }}>in 14 days</span></div>
        </div>
        <Btn kind="tag" full onClick={onAccept}>Accept and sign in</Btn>
        <div style={{ marginTop: 10 }}>
          <Btn kind="onDark" full onClick={onDecline}>Not now</Btn></div>
        <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", marginTop: 16,
          lineHeight: 1.5, textAlign: "center" }}>
          Single-use link. Whoever accepts is recorded, so if a family member sets this
          up for you, that's fine — Urvik can see who it was.
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The age gate.
 *
 * A liquor shop's alerts are alcohol marketing, and both app stores require
 * this in front of them. It is an attestation — the same one every drinks
 * website asks for — and the product never calls it anything more.
 *
 * The date of birth is typed here and goes NOWHERE. It is not sent, not
 * stored, not kept in this component after the answer is worked out. All that
 * leaves the phone is the bar it cleared: "this device has confirmed 21+".
 * That is deliberate. The shops were promised Dealtitude knows how many
 * followers they have and never who, and a birth date on the server would be
 * the first crack in that.
 * ------------------------------------------------------------------------- */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function ageOn(year, month) {
  /* Month is 1-12. Treated as the LAST day of that month, which is the
     generous reading — we are not asking for a day and must not refuse
     someone who turned 21 three weeks ago. */
  const now = new Date();
  let years = now.getFullYear() - year;
  if (now.getMonth() + 1 < month) years -= 1;
  return years;
}

function AgeGate({ store, minAge, onPass, onClose }) {
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);

  const thisYear = new Date().getFullYear();
  const yearOk = /^\d{4}$/.test(year) &&
    Number(year) >= thisYear - 120 && Number(year) <= thisYear;
  const ready = month !== "" && yearOk && !busy;

  const submit = async () => {
    if (!ready) return;
    if (ageOn(Number(year), Number(month)) < minAge) { setRefused(true); return; }
    setBusy(true);
    /* Only the bar leaves this screen. */
    try { await onPass(minAge); } finally { setBusy(false); }
  };

  const field = {
    width: "100%", padding: "12px 13px", borderRadius: 10, fontFamily: FONT,
    fontSize: 15, border: `1.5px solid ${T.line}`, background: "#fff", color: T.ink,
    boxSizing: "border-box",
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50,
        background: "rgba(22,33,28,.55)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 51,
        background: T.card, borderRadius: "20px 20px 29px 29px", padding: "18px 18px 24px",
        animation: "rise .26s cubic-bezier(.2,.9,.3,1.05)" }}>
        <div style={{ width: 36, height: 4, borderRadius: 99, background: T.line,
          margin: "0 auto 16px" }} />

        {refused ? (
          <>
            <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>
              Sorry — you need to be {minAge} or over
            </div>
            <div style={{ fontSize: 13.5, color: T.mute, lineHeight: 1.55, marginBottom: 18 }}>
              {store?.name} sells alcohol, so we can't send you its alerts. Every other
              shop on Dealtitude is still open to you.
            </div>
            <Btn kind="ghost" full onClick={onClose}>Back to the shops</Btn>
          </>
        ) : (
          <>
            <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>
              Confirm your age
            </div>
            <div style={{ fontSize: 13.5, color: T.mute, lineHeight: 1.55, marginBottom: 16 }}>
              {store?.name} sells alcohol, so we have to check you're {minAge} or over
              before following it.
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <select value={month} onChange={(e) => setMonth(e.target.value)}
                aria-label="Birth month" style={{ ...field, flex: 1.4 }}>
                <option value="">Month</option>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="Year" inputMode="numeric" aria-label="Birth year"
                style={{ ...field, flex: 1 }} />
            </div>

            <div style={{ background: T.dim, borderRadius: 10, padding: 12, fontSize: 11.5,
              color: T.mute, lineHeight: 1.55, marginBottom: 16 }}>
              Your date of birth stays on this phone. We only record that you confirmed
              you're {minAge} or over — never the date itself, and never anything the
              shop can see.
            </div>

            <Btn full disabled={!ready} onClick={submit}>
              {busy ? "One moment…" : "Confirm"}
            </Btn>
            <div style={{ marginTop: 10 }}>
              <Btn kind="ghost" full onClick={onClose}>Not now</Btn>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function AccountSheet({ session, roles, onSignOut, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50,
        background: "rgba(22,33,28,.45)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 51,
        background: T.card, borderRadius: "20px 20px 29px 29px", padding: "18px 18px 24px",
        animation: "rise .26s cubic-bezier(.2,.9,.3,1.05)" }}>
        <div style={{ width: 36, height: 4, borderRadius: 99, background: T.line,
          margin: "0 auto 16px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <Avatar session={session} size={44} onClick={() => {}} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{session.name}</div>
            <div style={{ fontSize: 12, color: T.mute }}>{session.email}</div>
            <div style={{ fontSize: 11, color: T.leaf, fontWeight: 700, marginTop: 2 }}>
              {roles.join(" · ")}</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: T.mute, lineHeight: 1.5, marginBottom: 14,
          paddingTop: 12, borderTop: `1px solid ${T.dim}` }}>
          Signed in with {session.provider === "google" ? "Google"
            : session.provider === "apple" ? "Apple" : "your phone number"}. Your role
          isn't stored on your account — it's worked out from which shops you've been
          given access to.
        </div>
        <Btn kind="ghost" full onClick={onSignOut}>Sign out</Btn>
      </div>
    </>
  );
}

/* One card renders all four kinds. A sale shows its price tag; the others
   carry a tinted kind chip so the feed stays scannable at a glance. */
/* Putting an announcement on the shop's own accounts.
 *
 * Labels rather than the platforms' logos: those are their trademarks, and a
 * hand-drawn approximation of one is both wrong and theirs. The word is also
 * clearer at this size.
 *
 * Instagram sits apart because it genuinely is apart — there is no address
 * that opens Instagram with a post ready to publish, so it goes through the
 * phone's own share sheet, which offers Instagram when it is installed. */
function ShareRow({ post, shopName, slug, onSaid }) {
  const t = Share.shareTargets(post, shopName, slug, PUBLIC_BASE);
  const sheet = Share.canUseSheet();
  const go = (href) => window.open(href, "_blank", "noopener,noreferrer");
  const btn = {
    border: `1px solid ${T.line}`, background: T.card, color: T.mute,
    borderRadius: 999, padding: "5px 11px", fontSize: 11.5, fontWeight: 700,
    fontFamily: FONT, cursor: "pointer", whiteSpace: "nowrap",
  };
  return (
    <div style={{ marginTop: 11, paddingTop: 10, borderTop: `1px solid ${T.dim}` }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: T.mute,
        letterSpacing: ".05em", marginBottom: 7 }}>SHARE THIS</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button style={btn} onClick={() => go(t.whatsapp)}>WhatsApp</button>
        <button style={btn} onClick={() => go(t.x)}>X</button>
        <button style={btn} onClick={() => go(t.facebook)}>Facebook</button>
        {sheet && (
          <button style={btn} onClick={async () => {
            const r = await Share.openSheet(post, shopName, slug, PUBLIC_BASE);
            if (r === "unavailable") onSaid?.("This phone wouldn't open its share sheet.");
          }}>Instagram & more</button>
        )}
        <button style={btn} onClick={async () => {
          try { await navigator.clipboard.writeText(`${t.text}\n${t.url}`);
                onSaid?.("Copied — paste it wherever you like."); }
          catch { onSaid?.("Couldn't copy on this device."); }
        }}>Copy</button>
      </div>
      {!sheet && (
        <div style={{ fontSize: 11, color: T.mute, marginTop: 7, lineHeight: 1.4 }}>
          Instagram has no way to open a post from a link. Copy the text and
          paste it there, or share from the phone app.
        </div>
      )}
    </div>
  );
}

function PostCard({ p, showStore, storeName, shareAs, onSaid }) {
  const k = kindOf(p);
  const wide = storeWide(p);
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`,
      borderLeft: `3px solid ${k.tone}`, borderRadius: 12, padding: 13, marginBottom: 9,
      display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ width: 46, height: 46, borderRadius: 9, background: T.dim, flexShrink: 0,
        display: "grid", placeItems: "center", fontSize: 21 }}>
        {wide ? k.icon : (CAT_ICON[p.cat] || k.icon)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
          marginBottom: 4 }}>
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".06em",
            color: "#fff", background: k.tone, borderRadius: 4, padding: "2px 6px" }}>
            {k.label.toUpperCase()}</span>
          {/* The name is handed in. Looking it up in the built-in demo list meant
              a real shop's listing showed no name at all. */}
          {showStore && storeName && <span style={{ fontSize: 12, fontWeight: 800,
            color: T.leaf }}>{storeName}</span>}
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.28 }}>{p.name}</div>
        {p.note && <div style={{ fontSize: 12.5, color: T.mute, marginTop: 4,
          lineHeight: 1.4 }}>{p.note}</div>}
        <div style={{ fontSize: 11.5, color: T.mute, marginTop: 5 }}>
          {!wide && p.cat ? `${catName(p.cat)} · ` : ""}
          {wide ? "Everyone following this shop" : ""}
          {p.ends ? `${wide ? " · " : ""}${k.price ? "ends " : ""}${p.ends}` : ""}
        </div>
        {k.price && p.now != null && (
          <div style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 10,
            flexWrap: "wrap" }}>
            <PriceTag was={p.was} now={p.now} size={1} tilt={false} />
            {/* Both prices, said in words beside the tag. A shopper deciding
                whether to walk over is comparing two numbers, and squeezing the
                old one into 9px inside the tag made it unreadable. */}
            {pct(p.was, p.now) > 0 && (
              <div style={{ fontSize: 13, lineHeight: 1.3 }}>
                <div style={{ color: T.mute, textDecoration: "line-through",
                  fontVariantNumeric: "tabular-nums" }}>was {money(p.was)}</div>
                <div style={{ color: T.cut, fontWeight: 800 }}>{pct(p.was, p.now)}% OFF</div>
              </div>
            )}
          </div>
        )}
        {shareAs && <ShareRow post={p} shopName={shareAs.name} slug={shareAs.slug}
          onSaid={onSaid} />}
      </div>
    </div>
  );
}

/* Scanned a code at the register. No ZIP, no browsing, no map — the only
   question on screen is whether they want to hear from this shop. */
function JoinScreen({ store, products, followed, onFollow, onBrowse, session }) {
  const live = products.filter((x) => x.store === store.id && x.status === "active");
  const sale = live.find((x) => x.kind === "sale");
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.dim,
      overflowY: "auto" }}>
      <div style={{ background: T.ink, color: "#fff", padding: "26px 22px 24px" }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, color: T.tag, marginBottom: 14 }}>
          DEALTITUDE</div>
        <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-.03em",
          lineHeight: 1.1 }}>{store.name}</div>
        <div style={{ fontSize: 14, color: "rgba(255,255,255,.65)", marginTop: 7,
          lineHeight: 1.45 }}>{store.addr}, {store.town}</div>
      </div>

      <div style={{ padding: "22px 22px 26px", flex: 1, display: "flex",
        flexDirection: "column" }}>
        {followed ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em" }}>
              You're following {store.name}.</div>
            <div style={{ fontSize: 14, color: T.mute, margin: "8px 0 18px", lineHeight: 1.5 }}>
              One thing left: <b style={{ color: T.ink }}>pick the aisles you buy from.</b>{" "}
              Nothing is switched on yet, so right now you'd only hear shop-wide news like
              a change of hours.</div>
            <Btn kind="tag" full onClick={onBrowse}>Pick my aisles</Btn>
          </>
        ) : (
          <>
            <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: "-.02em",
              lineHeight: 1.2 }}>
              Get told when {store.name} has something on.</div>
            <div style={{ fontSize: 14.5, color: T.mute, margin: "10px 0 20px",
              lineHeight: 1.5 }}>
              Sales, new arrivals, and the days they're closed. You choose which aisles,
              and they can only reach you {store.cap} times a day.</div>

            {/* Said before the tap, not after it. A shopper who is under age
                should find that out from a line of text, not from a form that
                takes their birth date first and then turns them away. */}
            {store.minAge && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18,
                background: T.card, border: `1px solid ${T.line}`, borderRadius: 11,
                padding: "11px 13px" }}>
                <div style={{ fontSize: 12, fontWeight: 900, color: T.ink, background: T.tag,
                  borderRadius: 6, padding: "4px 7px", flexShrink: 0 }}>{store.minAge}+</div>
                <div style={{ fontSize: 12, color: T.mute, lineHeight: 1.45 }}>
                  This shop sells alcohol, so you'll confirm your age first.</div>
              </div>
            )}

            {sale && (
              <div style={{ background: T.card, border: `1px solid ${T.line}`,
                borderLeft: `3px solid ${T.tag}`, borderRadius: 12, padding: 13,
                marginBottom: 20, display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ width: 44, height: 44, borderRadius: 9, background: T.dim,
                  display: "grid", placeItems: "center", fontSize: 20, flexShrink: 0 }}>
                  {CAT_ICON[sale.cat] || "🏷"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: T.mute }}>ON RIGHT NOW</div>
                  <div style={{ fontSize: 14.5, fontWeight: 700, marginTop: 2 }}>{sale.name}</div>
                </div>
                <PriceTag was={sale.was} now={sale.now} size={0.72} tilt={false} />
              </div>
            )}

            <Btn kind="tag" full onClick={onFollow}>Follow {store.name}</Btn>
            <div style={{ fontSize: 12, color: T.mute, marginTop: 14, lineHeight: 1.5,
              textAlign: "center" }}>
              {LIVE ? "One tap. No account, no email, nothing to remember."
                    : session ? "One tap — you're already signed in."
                    : "Takes about twenty seconds. No account needed to look first."}
            </div>
            <button onClick={onBrowse} style={{ marginTop: "auto", paddingTop: 22,
              border: "none", background: "none", color: T.mute, fontFamily: FONT,
              fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
              See other shops near me</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================ shopper ============================ */

/* "Hoping for something else?"
 *
 * This was the shop's own aisle list, rendered a second time directly under
 * the aisle list — so a shopper picked from the same five chips twice, and the
 * screen had to grey out the overlap and then explain the greying. The tally
 * never left the device, so the owner's demand panel was showing one phone its
 * own taps.
 *
 * An aisle is not a want. A shopkeeper knows what departments he has; what he
 * cannot know is that six people are waiting for Kaju Katli. So this asks for
 * an ITEM, and gives something back for it: the ask becomes a standing alert
 * for that one thing, which arrives even if its aisle is switched off. Aisles
 * are a filter — "don't bother me with that". An ask is a pull — "I want
 * this". Nothing overlaps.
 *
 * Typing is matched against what the shop has posted before and what other
 * shoppers have already asked for, so "kaju katli", "Kaju Katli" and
 * "Kaju  Katli!" land on one countable row rather than three. */
function AskBox({ store, wants, onAsk, onUnask }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  /* `field` is declared locally inside three different screens and nowhere
     globally, so it is spelled out here rather than borrowed. 16px, because
     anything smaller makes iOS Safari zoom the page on focus. */
  const box = { width: "100%", padding: "11px 12px", borderRadius: 9,
    border: `1.5px solid ${T.line}`, fontFamily: FONT, fontSize: 16,
    background: "#fff", color: T.ink, boxSizing: "border-box" };

  const rows   = wants?.wants || [];
  const mine   = wants?.mine || [];
  const asked  = (norm) => mine.some((m) => m.norm === norm);
  const normOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  /* Suggestions come from the shop's catalogue and from what others have
     asked for, minus whatever this phone has already asked. */
  const typed = normOf(text);
  const pool = [
    ...rows.map((r) => ({ label: r.label, aisle: r.aisle, shoppers: Number(r.shoppers) })),
    ...(wants?.suggest || []).map((x) => ({ label: x.label, aisle: x.aisle, shoppers: 0 })),
  ];
  const seen = new Set();
  const matches = pool.filter((x) => {
    const n = normOf(x.label);
    if (!n || seen.has(n) || asked(n)) return false;
    if (typed && !n.includes(typed)) return false;
    seen.add(n);
    return true;
  }).slice(0, 6);

  const submit = async (label, aisle) => {
    const l = (label ?? text).trim();
    if (l.length < 2 || busy) return;
    setBusy(true);
    try { await onAsk(l, aisle); setText(""); } finally { setBusy(false); }
  };

  return (
    <div style={{ background: T.card, border: `1px dashed ${T.line}`, borderRadius: 12,
      padding: 14, marginTop: 5 }}>
      <div style={{ fontSize: 13.5, fontWeight: 800 }}>Hoping for something else?</div>
      <div style={{ fontSize: 12, color: T.mute, margin: "4px 0 11px", lineHeight: 1.45 }}>
        Name the thing you want and {store.name} will hear that someone is waiting
        for it. You'll get an alert when it goes on sale — even if its aisle is
        switched off. They see the count, never your name.
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="Kaju Katli, Amul butter, fresh methi…"
          aria-label="What are you hoping to see?"
          style={{ ...box, flex: 1, minWidth: 0 }} />
        <Btn kind="tag" onClick={() => submit()}
          disabled={text.trim().length < 2 || busy}>Ask</Btn>
      </div>

      {/* Joining an existing ask is one tap and carries the social proof with
          it, which is the thing that makes someone bother at all. */}
      {matches.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".05em",
            color: T.mute, marginBottom: 6 }}>
            {typed ? "CLOSEST MATCHES" : "OTHERS ARE ASKING FOR"}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {matches.map((m) => (
              <button key={m.label} onClick={() => submit(m.label, m.aisle)}
                disabled={busy}
                style={{ fontFamily: FONT, cursor: busy ? "default" : "pointer",
                  textAlign: "left", background: T.dim, border: `1px solid ${T.line}`,
                  borderRadius: 9, padding: "8px 10px", display: "flex",
                  justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.ink,
                  overflowWrap: "anywhere" }}>{m.label}</span>
                <span style={{ fontSize: 11.5, color: T.mute, flexShrink: 0 }}>
                  {m.shoppers > 0
                    ? `${m.shoppers} waiting · join`
                    : "ask for this"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {mine.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 11, borderTop: `1px solid ${T.dim}` }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".05em",
            color: T.mute, marginBottom: 6 }}>YOU ASKED FOR</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {mine.map((m) => {
              const row = rows.find((r) => r.norm === m.norm);
              const n = row ? Number(row.shoppers) : 1;
              return (
                <div key={m.norm} style={{ display: "flex", justifyContent: "space-between",
                  alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.leaf,
                    overflowWrap: "anywhere", minWidth: 0 }}>
                    ✓ {m.label}
                    {n > 1 && <span style={{ color: T.mute, fontWeight: 400 }}>
                      {" "}· you and {n - 1} {n === 2 ? "other" : "others"}</span>}
                  </span>
                  <button onClick={() => onUnask(m.norm)}
                    style={{ fontFamily: FONT, cursor: "pointer", background: "none",
                      border: "none", color: T.mute, fontSize: 11.5, padding: "2px 0",
                      textDecoration: "underline", flexShrink: 0 }}>take back</button>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: T.mute, marginTop: 8, lineHeight: 1.45 }}>
            You'll be told the moment any of these goes on sale here.
          </div>
        </div>
      )}
    </div>
  );
}

function StoreScreen({ store, products, follow, followers, onFollow, onUnfollow,
                       onToggleCat, onBack, wants, onAsk, onUnask }) {
  const live = products.filter((p) => p.store === store.id && p.status === "active");
  const pinned = live.filter(storeWide);
  const items = live.filter((p) => !storeWide(p));
  const followed = !!follow;
  const on = (c) => !follow || follow.cats === null || follow.cats.includes(c);
  return (
    <>
      <Head title={store.name} onBack={onBack}
        sub={`${store.addr}, ${store.town} · ${followers} ${
          followers === 1 ? "follower" : "followers"}`} />
      <Scroll>
        <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
          padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, color: T.mute, lineHeight: 1.5, marginBottom: 12 }}>
            Open today {store.hours}</div>
          {followed
            ? <Btn kind="ghost" full onClick={onUnfollow}>Following · tap to stop</Btn>
            : <Btn full onClick={onFollow}>Follow this shop</Btn>}
        </div>

        {followed && (
          <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
            padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>Tell me about</div>
            <div style={{ fontSize: 12, color: T.mute, margin: "3px 0 11px", lineHeight: 1.45 }}>
              {store.cats.filter(on).length === 0
                ? <><b style={{ color: T.ink }}>Nothing picked yet.</b> Tap the aisles you
                    actually buy from — you'll only hear about those.</>
                : <>Tap to add an aisle or switch one back off. You'll only hear about
                    the ones lit up.</>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {store.cats.map((c) => (
                <Chip key={c} on={on(c)} onClick={() => onToggleCat(c)}>
                  {CAT_ICON[c]} {catName(c)}</Chip>
              ))}
            </div>
            {store.cats.filter(on).length > 0 && (
              <div style={{ fontSize: 11.5, fontWeight: 700, color: T.leaf, marginTop: 10 }}>
                On: {store.cats.filter(on).map(catName).join(", ")}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: T.mute, marginTop: 11, paddingTop: 10,
              borderTop: `1px solid ${T.dim}`, lineHeight: 1.5 }}>
              {store.cats.filter(on).length === 0
                ? `Until you pick one, you'll only get shop-wide news from here — hours
                   changes and announcements. At most ${store.cap} a day.`
                : `At most ${store.cap} alerts a day from here.`}
            </div>
          </div>
        )}

        {pinned.length > 0 && (
          <>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 9 }}>
              From the shop</div>
            {pinned.map((p) => <PostCard key={p.id} p={p} />)}
          </>
        )}

        <div style={{ fontSize: 13, fontWeight: 800, margin: "16px 0 9px" }}>
          {items.length} live update{items.length === 1 ? "" : "s"}</div>
        {items.length === 0 && (
          <div style={{ fontSize: 12.5, color: T.mute, background: T.card,
            border: `1px dashed ${T.line}`, borderRadius: 12, padding: 16,
            textAlign: "center", lineHeight: 1.5 }}>
            Nothing on right now. You'll hear when there is.</div>
        )}
        {items.map((p) => <PostCard key={p.id} p={p} />)}

        <AskBox store={store} wants={wants} onAsk={onAsk} onUnask={onUnask} />
      </Scroll>
    </>
  );
}

function FeedScreen({ products, follows, onOpen, storeName, onSaid }) {
  const mine = products.filter((p) => p.status === "active" && follows[p.store]);
  const sales = mine.filter((p) => p.kind === "sale").length;
  return (
    <>
      <Head title="Latest" sub={`${Object.keys(follows).length} ${
        Object.keys(follows).length === 1 ? "shop" : "shops"} followed · ${sales} on sale`} />
      <Scroll>
        {/* Two very different empty states, and telling a follower they follow
            nothing is the one that costs you. Someone who reopens the app,
            lands here and reads "No shops followed yet" concludes the app lost
            their follows — while the line directly above says they follow one. */}
        {mine.length === 0 && (
          <div style={{ textAlign: "center", padding: "52px 24px", color: T.mute }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>
              {Object.keys(follows).length === 0 ? "🛒" : "🌙"}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>
              {Object.keys(follows).length === 0
                ? "No shops followed yet"
                : "Nothing on right now"}</div>
            <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              {Object.keys(follows).length === 0
                ? "Open Shops and follow one to see its sales and news here."
                : "You'll get a notification the moment one of your shops posts something."}</div>
          </div>
        )}
        {mine.map((p) => (
          <div key={p.id} onClick={() => onOpen(p.store)} style={{ cursor: "pointer" }}>
            <PostCard p={p} showStore storeName={storeName(p.store)}
              shareAs={{ name: storeName(p.store), slug: p.store }} onSaid={onSaid} />
          </div>
        ))}
      </Scroll>
    </>
  );
}

function AlertsScreen({ inbox, held, notif, decision }) {
  /* A shopper's Alerts tab is a record of what reached their phone, and the
     one place to see whether notifications are switched on at all. It carries
     no test button and no internal readout — both of those belong to the shop
     owner, who has something to prove before they rely on it. */
  const { onTest, debug, ...shopperNotif } = notif;
  return (
    <>
      <Head title="Alerts" sub="What's reached your phone" />
      <Scroll>
        <NotifCard {...shopperNotif} who="Deal" />
        <DecisionCard decision={decision} />
        {inbox.length === 0 && held.length === 0 && (
          <div style={{ textAlign: "center", padding: "30px 24px", color: T.mute }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🔔</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>
              Nothing yet</div>
            <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              Anything a shop you follow sends will appear here, as well as on your lock
              screen. Following a shop doesn't send one on its own.</div>
          </div>
        )}
        {inbox.map((a) => (
          <div key={a.id} style={{ background: T.card, border: `1px solid ${T.line}`,
            borderLeft: `3px solid ${T.leaf}`, borderRadius: 10, padding: 13, marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{a.title}</div>
            <div style={{ fontSize: 12.5, color: T.mute, marginTop: 4 }}>{a.body}</div>
            <div style={{ fontSize: 11, color: T.mute, marginTop: 7, opacity: 0.75 }}>{a.at}</div>
          </div>
        ))}
        {held.length > 0 && (
          <>
            <div style={{ fontSize: 12, fontWeight: 800, color: T.mute, margin: "16px 0 8px" }}>
              Held back for you</div>
            {held.map((a) => (
              <div key={a.id} style={{ border: `1px dashed ${T.line}`, borderRadius: 10,
                padding: 12, marginBottom: 7 }}>
                <div style={{ fontSize: 13, color: T.mute, lineHeight: 1.35 }}>{a.title}</div>
                <div style={{ fontSize: 11, color: T.cut, fontWeight: 700, marginTop: 5 }}>
                  {a.why}</div>
              </div>
            ))}
          </>
        )}
      </Scroll>
    </>
  );
}

/* ============================ owner ============================ */

function ShopSwitch({ shops, current, onPick }) {
  if (shops.length < 2) return null;
  return (
    <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "10px 16px 0",
      background: T.dim, flexShrink: 0 }}>
      {shops.map((sh) => (
        <button key={sh.id} onClick={() => onPick(sh.id)} style={{
          flexShrink: 0, fontFamily: FONT, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          borderRadius: 999, padding: "7px 13px", whiteSpace: "nowrap",
          background: sh.id === current ? T.ink : T.card,
          color: sh.id === current ? "#fff" : T.mute,
          border: `1.5px solid ${sh.id === current ? T.ink : T.line}`,
        }}>{sh.name}</button>
      ))}
    </div>
  );
}

function OwnerSales({ store, products, followers, onExpire, onNew, sentToday, decision,
                     onSaid }) {
  const mine = products.filter((p) => p.store === store.id);
  const active = mine.filter((p) => p.status === "active");
  const count = (kind) => active.filter((p) => p.kind === kind).length;
  return (
    <>
      <Head title={store.name} sub="Owner portal" right={
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.leaf,
            fontVariantNumeric: "tabular-nums" }}>{followers}</div>
          <div style={{ fontSize: 10.5, color: T.mute, fontWeight: 700 }}>followers</div>
        </div>} />
      <Scroll>
        <DecisionCard decision={decision} />

        <div style={{ background: T.ink, color: "#fff", borderRadius: 12, padding: 14,
          marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {active.length} live · {sentToday} alerts sent today</div>
            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.6)" }}>
              cap {store.cap}/day</div>
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 11, paddingTop: 11,
            borderTop: "1px solid rgba(255,255,255,.14)" }}>
            {Object.entries(KINDS).map(([id, k]) => (
              <div key={id} style={{ flex: 1 }}>
                <div style={{ fontSize: 19, fontWeight: 800, color: k.tone,
                  fontVariantNumeric: "tabular-nums" }}>{count(id)}</div>
                <div style={{ fontSize: 9.5, fontWeight: 700,
                  color: "rgba(255,255,255,.55)", marginTop: 1 }}>
                  {k.label.toUpperCase()}</div>
              </div>
            ))}
          </div>
        </div>

        <Btn kind="tag" full onClick={onNew}>Post an update</Btn>

        <div style={{ fontSize: 12.5, fontWeight: 800, color: T.mute, margin: "18px 0 9px" }}>
          Everything you've posted</div>
        {mine.map((p) => {
          const k = kindOf(p);
          const live = p.status === "active";
          return (
            <div key={p.id} style={{ background: T.card, border: `1px solid ${T.line}`,
              borderLeft: `3px solid ${live ? k.tone : T.line}`, borderRadius: 12,
              padding: 13, marginBottom: 9, opacity: live ? 1 : .55 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".06em",
                    color: "#fff", background: live ? k.tone : T.mute, borderRadius: 4,
                    padding: "2px 6px" }}>{k.label.toUpperCase()}</span>
                  <div style={{ fontSize: 14.5, fontWeight: 700, marginTop: 7 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: T.mute, marginTop: 3 }}>
                    {storeWide(p) ? "Everyone following" : catName(p.cat)}
                    {p.ends ? ` · ${p.ends}` : ""}</div>
                  {p.by && <div style={{ fontSize: 10.5, color: T.mute, marginTop: 6 }}>
                    Posted by {p.by}</div>}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  {k.price && p.now != null &&
                    <PriceTag was={p.was} now={p.now} size={0.78} tilt={false} />}
                  {live && (
                    <button onClick={() => onExpire(p.id)} style={{ display: "block",
                      marginLeft: "auto", marginTop: 9, border: "none", background: "none",
                      color: T.cut, fontSize: 11.5, fontWeight: 700, fontFamily: FONT,
                      cursor: "pointer" }}>Take down</button>
                  )}
                </div>
              </div>
              {/* Only while it is live: sharing a sale that has already ended
                  sends customers to something that is gone. */}
              {live && <ShareRow post={p} shopName={store.name} slug={store.id}
                onSaid={onSaid} />}
            </div>
          );
        })}
      </Scroll>
    </>
  );
}

/* Walks the shelf across sheet opens — component state resets when the sheet
   closes, and a shopkeeper watching three scans should see three products. */
let demoScanSeq = -1;

/* A drawn barcode. Bar widths come from the digits, so each code looks like
   its own product rather than generic stripes. */
function BarcodeArt({ code, found }) {
  const H = 26;                       // short and wide, the way a real EAN sits
  const bars = [];
  let x = 0;
  for (let i = 0; i < code.length; i++) {
    const d = Number(code[i]);
    /* two bars per digit, so twelve digits make a properly dense symbol */
    for (const w of [1 + (d % 3), 1 + ((d + 1) % 2)]) {
      bars.push(<rect key={i + "-" + x} x={x} y={0} width={w} height={H} fill="#111" />);
      x += w + 1;
    }
  }
  const guard = (gx, k) => <rect key={k} x={gx} y={-1.5} width={1.2} height={H + 5} fill="#111" />;
  return (
    <svg viewBox={`-5 -5 ${x + 10} ${H + 15}`}
      style={{ width: "76%", maxHeight: "62%", display: "block",
        filter: found ? "none" : "blur(.3px)" }}>
      <rect x={-5} y={-5} width={x + 10} height={H + 15} rx={1.5} fill="#fff" />
      {guard(-1.5, "g0")}{bars}{guard(x - 0.5, "g1")}
      <text x={x / 2} y={H + 7.5} textAnchor="middle" fill="#111"
        style={{ font: "600 5.5px ui-monospace, Menlo, monospace",
          letterSpacing: ".35px" }}>{code}</text>
    </svg>
  );
}

/* The demo scanner. Pure drawing — no camera — so it works on every phone,
   including iOS Safari where no browser barcode reader exists. It is labelled
   as a demo in the UI: this is for showing a shopkeeper what the real thing
   does, never for pretending a code was actually read. */
function ScanSim({ seq, onFound, onCancel }) {
  const [phase, setPhase] = useState("looking");     // looking | found
  const item = SHELF[seq % SHELF.length];
  useEffect(() => {
    const a = setTimeout(() => setPhase("found"), 1500);
    const b = setTimeout(() => onFound(item.code), 2350);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  const edge = phase === "found" ? T.leaf : T.tag;
  const Corner = (st) => (
    <span style={{ position: "absolute", width: 26, height: 26, borderColor: edge,
      borderStyle: "solid", borderWidth: 0, transition: "border-color .18s", ...st }} />
  );
  return (
    <div style={{ borderRadius: 12, overflow: "hidden", background: "#15110E",
      aspectRatio: "4 / 3", marginBottom: 12, position: "relative",
      display: "grid", placeItems: "center" }}>
      <div style={{ transform: "rotate(-3deg)", width: "100%", display: "grid",
        placeItems: "center" }}>
        <BarcodeArt code={item.code.slice(-12)} found={phase === "found"} />
      </div>

      {/* the reticle */}
      <div style={{ position: "absolute", inset: "17% 11%" }}>
        {Corner({ top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderRadius: "6px 0 0 0" })}
        {Corner({ top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderRadius: "0 6px 0 0" })}
        {Corner({ bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderRadius: "0 0 0 6px" })}
        {Corner({ bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderRadius: "0 0 6px 0" })}
        {phase === "looking" && (
          <div style={{ position: "absolute", left: 6, right: 6, height: 2,
            background: T.tag, boxShadow: `0 0 10px ${T.tag}`, borderRadius: 2,
            animation: "scanline 1.05s ease-in-out infinite alternate" }} />
        )}
      </div>

      {phase === "found" && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0,
          background: T.leaf, color: "#fff", padding: "9px 12px", fontSize: 13,
          fontWeight: 800, animation: "foundpop .22s ease-out both" }}>
          ✓ {item.name || "New item"}
          <span style={{ fontWeight: 400, opacity: .8, fontFamily:
            "ui-monospace, Menlo, monospace", fontSize: 11 }}> · {item.code.slice(-12)}</span>
        </div>
      )}

      <div style={{ position: "absolute", top: 8, left: 10, fontSize: 10,
        fontWeight: 800, letterSpacing: ".08em", color: "rgba(255,255,255,.5)" }}>
        DEMO SCANNER</div>
      <button onClick={onCancel} style={{ position: "absolute", top: 6, right: 8,
        border: "none", background: "none", color: "rgba(255,255,255,.65)",
        fontFamily: FONT, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Stop</button>
    </div>
  );
}

/* The scan sheet. Real camera where the device has one we can reach, the
   shelf-tag picker everywhere else — the owner should never hit a dead end
   mid-post, so every path ends in either an item or a way to type it. */
function ScanSheet({ store, catalog, lookup, onPick, onClose }) {
  const [mode, setMode] = useState("choose");     // choose | camera | sim
  const [err, setErr] = useState(null);
  const [typed, setTyped] = useState("");
  /* Each demo run finds the next tag along, so a shopkeeper watching three in
     a row sees three different products — and eventually the new-item path. */
  const [demoSeq, setDemoSeq] = useState(0);
  const videoRef = useRef(null);
  const stopRef = useRef(null);
  /* Native always can. On the web only Chrome ships BarcodeDetector, so on an
     iPhone we say so up front rather than after a tap that goes nowhere. */
  const canCamera = Native.isNative || Native.webScanSupported();

  const resolve = async (raw) => {
    const gtin = toGtin14(raw);
    if (!gtin) { setErr("That didn't read as a barcode. Try again or type it in."); return; }
    if (!checkDigitValid(gtin)) {
      setErr("That barcode didn't check out — probably a misread. Scan it again.");
      return;
    }

    /* The shop's own catalogue is the authority, and live it lives on the
       server — so the same barcode scanned on the owner's second phone fills
       itself in too. If the server can't be reached, fall back to whatever
       this device has rather than blocking the post. */
    let known = catalog[gtin] || null;
    if (lookup) {
      try { known = (await lookup(gtin)) || known; } catch {}
    }
    /* Live, a barcode is known only if THIS shop has posted it before. The
       built-in shelf is demo data and must never fill a real shop's form. */
    const shelf = LIVE ? null : SHELF.find((x) => x.code === gtin);
    onPick({ gtin, known: known || (shelf && shelf.name ? shelf : null) });
  };

  /* Browser scanning, where BarcodeDetector exists. Cleaned up on unmount so
     the camera light never stays on after the sheet closes. */
  useEffect(() => {
    if (mode !== "camera") return;
    let alive = true;
    (async () => {
      try {
        const Detector = window.BarcodeDetector;
        const det = new Detector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" } });
        stopRef.current = () => stream.getTracks().forEach((t) => t.stop());
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const tick = async () => {
          if (!alive || !videoRef.current) return;
          try {
            const hits = await det.detect(videoRef.current);
            if (hits.length) { stopRef.current?.(); resolve(hits[0].rawValue); return; }
          } catch {}
          setTimeout(tick, 220);
        };
        tick();
      } catch {
        setErr("Couldn't open the camera. Pick a tag below or type the item.");
        setMode("choose");
      }
    })();
    return () => { alive = false; stopRef.current?.(); };
  }, [mode]);

  const startScan = async () => {
    setErr(null);
    if (Native.isNative) {
      const hit = await Native.scanBarcode();
      if (hit?.raw) { resolve(hit.raw); return; }
      /* Backing out of the scanner is a choice, not a fault: say nothing. */
      if (hit?.cancelled) return;
      /* A real failure says what went wrong. "Camera unavailable" was a guess,
         and it sent us looking at camera permissions for a fault that was in
         the options being passed to the scanner. */
      setErr(hit?.error
        ? `Scanner: ${hit.error} — pick a tag below or type the item.`
        : "The scanner didn't start. Pick a tag below or type the item.");
      return;
    }
    if (Native.webScanSupported()) { setMode("camera"); return; }
    setErr("This browser can't use the camera to scan. In the app it will — "
         + "for now, pick a tag below.");
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(26,20,16,.55)",
      display: "flex", flexDirection: "column", justifyContent: "flex-end", zIndex: 40 }}>
      <div style={{ background: T.dim, borderRadius: "18px 18px 0 0", padding: 16,
        maxHeight: "88%", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Scan the shelf tag</div>
          <button onClick={onClose} style={{ marginLeft: "auto", border: "none",
            background: "none", fontFamily: FONT, fontSize: 13.5, fontWeight: 700,
            color: T.mute, cursor: "pointer" }}>Close</button>
        </div>

        {mode === "camera" ? (
          <div style={{ borderRadius: 12, overflow: "hidden", background: "#000",
            aspectRatio: "4 / 3", marginBottom: 12, position: "relative" }}>
            <video ref={videoRef} playsInline muted
              style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <div style={{ position: "absolute", inset: "22% 12%",
              border: `2px solid ${T.tag}`, borderRadius: 8 }} />
          </div>
        ) : mode === "sim" ? (
          <ScanSim seq={demoSeq} onFound={resolve} onCancel={() => setMode("choose")} />
        ) : (
          <>
            {canCamera && <Btn kind="tag" full onClick={startScan}>📷 Open the camera</Btn>}
            {/* The walkthrough is for showing someone how this works with no
                shelf in front of you. On a real counter it is clutter, and the
                invented products look like the shop's own stock. */}
            {!LIVE && (
              <div style={{ marginTop: canCamera ? 8 : 0 }}>
                <Btn kind={canCamera ? "ghost" : "tag"} full
                  onClick={() => { setErr(null); setDemoSeq(++demoScanSeq); setMode("sim"); }}>
                  ▣ Show me how it works
                </Btn>
              </div>
            )}
            {!canCamera && (
              <div style={{ fontSize: 11.5, color: T.mute, lineHeight: 1.5, marginTop: 9 }}>
                {LIVE
                  ? "This browser can't use the camera to scan. Type the number below instead."
                  : "This browser has no barcode reader, so the button above plays the demo. In the installed app it opens the real camera."}
              </div>
            )}
          </>
        )}

        {err && <div style={{ fontSize: 12, color: T.cut, marginTop: 10, lineHeight: 1.45 }}>
          {err}</div>}

        {!LIVE && <div style={{ fontSize: 11.5, fontWeight: 800, color: T.mute,
          margin: canCamera ? "16px 0 7px" : "0 0 7px" }}>
          {canCamera ? "OR PICK A TAG IN FRONT OF YOU" : "PICK A TAG IN FRONT OF YOU"}</div>}
        {!LIVE && SHELF.map((x) => {
          const known = catalog[x.code] || (x.name ? x : null);
          return (
            <button key={x.code} onClick={() => resolve(x.code)} style={{ width: "100%",
              textAlign: "left", display: "flex", alignItems: "center", gap: 11,
              background: T.card, border: `1px solid ${T.line}`, borderRadius: 10,
              padding: "10px 12px", marginBottom: 7, cursor: "pointer", fontFamily: FONT }}>
              <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10.5,
                color: T.mute, flexShrink: 0 }}>{x.code.slice(-12)}</span>
              <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, minWidth: 0 }}>
                {known ? known.name : "Not seen before"}</span>
              {!known && <span style={{ fontSize: 10.5, fontWeight: 800, color: T.tag }}>NEW</span>}
            </button>
          );
        })}

        <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 10, paddingTop: 12 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, color: T.mute, marginBottom: 6 }}>
            NO BARCODE? TYPE THE CODE OR SKIP</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder="4011 or 012345678905" inputMode="numeric"
              style={{ flex: 1, padding: "10px 12px", borderRadius: 9, minWidth: 0,
                border: `1.5px solid ${T.line}`, fontFamily: FONT, fontSize: 15,
                background: T.card, boxSizing: "border-box" }} />
            <Btn kind="ghost" onClick={() => typed.trim() && resolve(typed.trim())}>Use</Btn>
          </div>
          <div style={{ fontSize: 11, color: T.mute, marginTop: 8, lineHeight: 1.5 }}>
            Loose produce has a 4- or 5-digit PLU on the sticker, not a barcode.
            Type that, or close this and write the item in yourself.
          </div>
        </div>
      </div>
    </div>
  );
}

function OwnerNew({ store, actingAs, onCancel, onPublish, catalog, lookup, onLearn,
                   prefill }) {
  const [kind, setKind] = useState("sale");
  /* Nothing is chosen on the owner's behalf. An aisle picked by default means
     a whiskey sale going out to everyone who asked for rum, and the owner never
     sees the mistake — they just see an angry follower later.
     `prefill` is the one exception, and it is not a default: it carries the
     exact item some shoppers asked for, which the owner chose to answer by
     tapping it. The aisle rides along only when the shop itself has it. */
  const [f, setF] = useState({
    name: prefill?.name || "", note: "", was: "", now: "", ends: "",
    cat: prefill?.aisle && store.cats.includes(prefill.aisle) ? prefill.aisle : "",
  });
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(null);   // { gtin, fresh } once a code is in

  /* A scan either recognises the item or starts its record. Either way the
     barcode rides along to publish, so the shop learns it for next time. */
  const tookScan = ({ gtin, known }) => {
    setScanning(false);
    setScanned({ gtin, fresh: !known });
    /* Every scan replaces the item outright. Leaving the previous name in the
       box would let the owner publish the last product against this barcode —
       wrong on the shelf and wrong in the catalogue from then on. */
    setF((x) => ({ ...x,
      name: known ? known.name : "",
      /* The aisle is the one field a scan must NOT overwrite.
         A remembered aisle from last time is a real choice this shop made, and
         an aisle the owner picked moments ago is a realer one — but this line
         used to discard both for any barcode the shop had not posted before,
         which is every barcode the first time. The owner then had a filled-in
         form and a dead "Announce it" with nothing saying why. */
      cat:  x.cat
              || (known && known.cat && store.cats.includes(known.cat) ? known.cat : ""),
      was:  known ? (known.was || "") : "",
      now:  known ? (known.now || "") : "" }));
  };
  const k = KINDS[kind];
  const set = (key) => (e) => setF({ ...f, [key]: e.target.value });
  /* Read every field as text whatever arrives in it. A remembered item came
     back from the server with numbers in the price fields and took the whole
     screen down mid-post; a compose form must bend rather than break. */
  const txt = (v) => (v == null ? "" : String(v));
  const ready = txt(f.name).trim()
    && (!k.price || txt(f.now).trim())
    /* An aisle decides who hears this, so it cannot be left to chance. */
    && (!k.aisle || Boolean(f.cat))
    && Boolean(f.ends);

  const field = { width: "100%", padding: "11px 12px", borderRadius: 9,
    border: `1.5px solid ${T.line}`, fontFamily: FONT, fontSize: 16, background: T.card,
    boxSizing: "border-box" };
  const label = { fontSize: 11.5, fontWeight: 800, color: T.mute, marginBottom: 5,
    display: "block" };

  const PLACE = {
    sale:    ["Basmati rice, 20 lb", "Anything worth saying about it"],
    arrival: ["Alphonso mangoes", "First crate of the season, limited"],
    hours:   ["Closed Tuesday for Diwali", "Back open Wednesday at 8:00 AM"],
    notice:  ["Now taking catering orders", "Trays for parties, ask at the counter"],
  }[kind];

  const ENDS = { sale: "Ends", arrival: "Available", hours: "Which day",
    notice: "Until" }[kind];

  return (
    <>
      <Head title="Post an update" sub={store.name} onBack={onCancel} />
      <Scroll>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Arriving here from the demand list, the item is already typed in
              and the owner should be told why — and that the aisle is the one
              thing still missing, since a want often has no aisle on it. */}
          {prefill?.name && (
            <div style={{ background: T.card, border: `1px solid ${T.leaf}`,
              borderLeft: `3px solid ${T.leaf}`, borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.leaf }}>
                {prefill.shoppers > 1
                  ? `${prefill.shoppers} shoppers asked for this`
                  : "A shopper asked for this"}</div>
              <div style={{ fontSize: 12, color: T.mute, marginTop: 4, lineHeight: 1.45 }}>
                They'll all be told when you post it, whether or not they follow
                the aisle.{!f.cat && " Pick the aisle it belongs in to finish."}</div>
            </div>
          )}
          <div>
            <span style={label}>What kind of update</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {Object.entries(KINDS).map(([id, kk]) => (
                <button key={id} onClick={() => setKind(id)} style={{ textAlign: "left",
                  fontFamily: FONT, cursor: "pointer", borderRadius: 11, padding: "11px 12px",
                  background: kind === id ? kk.tone : T.card, color: kind === id ? "#fff" : T.ink,
                  border: `1.5px solid ${kind === id ? kk.tone : T.line}` }}>
                  <div style={{ fontSize: 17, lineHeight: 1 }}>{kk.icon}</div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 5 }}>{kk.label}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span style={label}>{k.price ? "What's on sale" : "What's the news"}</span>
            {/* Scanning only makes sense where there's a product. Hours and
                announcements have nothing to point a camera at. */}
            {k.aisle ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input value={f.name} onChange={set("name")} placeholder={PLACE[0]}
                  style={{ ...field, flex: 1 }} />
                {/* Named, not just drawn. A glyph with no accessible name is
                    invisible to a screen reader and to anyone who does not
                    recognise the symbol — and this is the button the whole
                    scan-at-the-shelf promise rests on. */}
                <button onClick={() => setScanning(true)} title="Scan the shelf tag"
                  aria-label="Scan the shelf tag"
                  style={{ flexShrink: 0, width: 46, borderRadius: 9, cursor: "pointer",
                    border: `1.5px solid ${T.ink}`, background: T.ink, color: T.tag,
                    fontSize: 19, fontFamily: FONT }}>⛶</button>
              </div>
            ) : (
              <input value={f.name} onChange={set("name")} placeholder={PLACE[0]} style={field} />
            )}
            {scanned && (
              <div style={{ fontSize: 11.5, marginTop: 7, lineHeight: 1.45,
                color: scanned.fresh ? T.tag : T.leaf, fontWeight: 700 }}>
                {scanned.fresh
                  ? "New item — type the name once and this shop will know it next time."
                  : "Scanned. Filled in from the last time you posted it."}
                <div style={{ color: T.mute, fontWeight: 400, marginTop: 2, fontFamily:
                  "ui-monospace, Menlo, monospace" }}>{scanned.gtin.slice(-12)}</div>
              </div>
            )}
          </div>

          <div>
            <span style={label}>Anything else (optional)</span>
            <input value={f.note} onChange={set("note")} placeholder={PLACE[1]} style={field} />
          </div>

          {k.aisle ? (
            <div>
              <span style={label}>Aisle — decides who gets told</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {store.cats.map((c) => (
                  <Chip key={c} on={f.cat === c} onClick={() => setF({ ...f, cat: c })}>
                    {CAT_ICON[c]} {catName(c)}</Chip>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10,
              padding: 12, fontSize: 12.5, color: T.mute, lineHeight: 1.45 }}>
              This goes to <b style={{ color: T.ink }}>everyone following your shop</b>,
              whatever aisles they picked. It still counts against their daily cap, so
              keep these for things that genuinely affect everybody.
            </div>
          )}

          {k.price && (
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}><span style={label}>Was</span>
                <input value={f.was} onChange={set("was")} placeholder="32.99"
                  inputMode="decimal" style={field} /></div>
              <div style={{ flex: 1 }}><span style={label}>Now</span>
                <input value={f.now} onChange={set("now")} placeholder="24.99"
                  inputMode="decimal" style={field} /></div>
            </div>
          )}

          {/* Typed by hand this was "Today, 9:00 PM" — which stops being true
              tomorrow and cannot be compared to anything. datetime-local gives
              iOS its own wheel picker and comes back as a real moment. */}
          <div><span style={label}>{ENDS}</span>
            <input type="datetime-local" value={f.ends} onChange={set("ends")}
              min={localNow()} style={field} /></div>

          <div style={{ background: T.card, border: `1px dashed ${T.line}`, borderRadius: 10,
            padding: 12, fontSize: 12, color: T.mute, lineHeight: 1.5 }}>
            {k.aisle
              ? (f.cat
                  ? <>Tells followers who kept <b style={{ color: T.ink }}>{catName(f.cat)}</b> switched on.</>
                  : <>Pick an aisle above — it decides who hears this.</>)
              : <>Tells every follower of {store.name}.</>}
            {actingAs && <> Shows as <b style={{ color: T.ink }}>posted by {actingAs}</b>.</>}
          </div>

          <Btn full disabled={!ready} onClick={() => {
            if (scanned) onLearn(store.id, scanned.gtin, {
              name: txt(f.name).trim(), cat: k.aisle ? f.cat : null,
              was: txt(f.was).trim(), now: txt(f.now).trim() });
            onPublish({
              id: uid(), kind, store: store.id,
              cat: k.aisle ? f.cat : null,
              name: txt(f.name).trim(), note: txt(f.note).trim() || null,
              gtin: scanned ? scanned.gtin : null,
              unit: k.price ? "each" : null,
              was: k.price ? Math.round(parseFloat(txt(f.was) || txt(f.now)) * 100) : null,
              now: k.price ? Math.round(parseFloat(txt(f.now)) * 100) : null,
              ends: humanEnds(f.ends), status: "active", by: actingAs,
            });
          }}>Announce it</Btn>
          {/* A greyed-out button with no reason is a dead end. Name the one
              thing missing, in the order the form asks for it. */}
          {!ready && (
            <div style={{ fontSize: 11.5, color: T.mute, marginTop: 8,
              lineHeight: 1.45, textAlign: "center" }}>
              {!txt(f.name).trim() ? "Add the item's name to announce it."
               : k.aisle && !f.cat ? "Pick the aisle it belongs to — that decides who hears it."
               : k.price && !txt(f.now).trim() ? "Add the new price."
               : !f.ends ? "Set when it ends."
               : "Fill in the rest to announce it."}
            </div>
          )}
        </div>
      </Scroll>
      {scanning && <ScanSheet store={store} catalog={catalog} lookup={lookup}
        onPick={tookScan} onClose={() => setScanning(false)} />}
    </>
  );
}

function OwnerActivity({ store, activity, followers, demand, onPostFor,
                        onSimulate, notif, reach }) {
  const icon = { follow: "＋", unfollow: "－", prefs: "✎" };
  const tone = { follow: T.leaf, unfollow: T.mute, prefs: "#2B6CB0" };
  /* Straight from the server, most-wanted first. This used to be
     Object.entries() over the shopper app's own component state, keyed by
     aisle and not even by shop — so an owner saw his own taps, and a "sweets"
     ask at one shop surfaced in another's panel. */
  const reqList = demand || [];
  return (
    <>
      {/* "How many", never "who" — the shop is never told who a follower is. */}
      <Head title="Activity" sub="How many are following, and what they want" />
      <Scroll>
        <NotifCard {...notif} who="Follower" debug />

        {/* The number being sold: people who can actually be reached. */}
        <div style={{ background: T.ink, color: "#fff", borderRadius: 12, padding: 16,
          marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, color: "rgba(255,255,255,.55)" }}>
            PEOPLE YOU CAN REACH</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: T.tag, lineHeight: 1,
              fontVariantNumeric: "tabular-nums" }}>{reach.reachable}</div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,.65)" }}>
              of {followers} following</div>
          </div>
          <div style={{ display: "flex", height: 7, borderRadius: 99, overflow: "hidden",
            background: "rgba(255,255,255,.14)", marginTop: 14 }}>
            <div style={{ width: `${(reach.reachable / Math.max(followers,1)) * 100}%`,
              background: T.tag }} />
            <div style={{ width: `${(reach.muted / Math.max(followers,1)) * 100}%`,
              background: "rgba(255,255,255,.4)" }} />
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 11.5,
            color: "rgba(255,255,255,.65)", flexWrap: "wrap" }}>
            <span><b style={{ color: T.leaf }}>+{reach.newThisWeek}</b> this week</span>
            <span><b style={{ color: "#fff" }}>{reach.muted}</b> muted you</span>
            <span><b style={{ color: "#fff" }}>{reach.noPush}</b> no notifications</span>
          </div>
          {reach.muted > 0 && (
            <div style={{ fontSize: 11.5, color: T.tag, marginTop: 11, paddingTop: 10,
              borderTop: "1px solid rgba(255,255,255,.14)", lineHeight: 1.45 }}>
              Muted followers still show in your total. They are not hearing from you.</div>
          )}
        </div>

        <div style={{ display: "flex", gap: 9, marginBottom: 16 }}>
          {[["Followers", followers, T.leaf],
            ["Requests", reqList.reduce((n, r) => n + r[1], 0), T.ink]].map(([l, v, c]) => (
            <div key={l} style={{ flex: 1, background: T.card, border: `1px solid ${T.line}`,
              borderRadius: 12, padding: "13px 11px" }}>
              <div style={{ fontSize: 25, fontWeight: 800, color: c,
                fontVariantNumeric: "tabular-nums" }}>{v}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: T.mute, marginTop: 2 }}>{l}</div>
            </div>
          ))}
        </div>

        {reqList.length > 0 && (
          <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
            padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>What shoppers are waiting for</div>
            <div style={{ fontSize: 12, color: T.mute, margin: "4px 0 11px", lineHeight: 1.45 }}>
              Named items, asked for by shoppers here. Post one and everyone who
              asked hears about it — whether or not they follow that aisle.</div>
            {reqList.map((w) => {
              const n = Number(w.shoppers);
              return (
                <div key={w.norm} style={{ display: "flex", justifyContent: "space-between",
                  alignItems: "center", gap: 10, padding: "9px 0",
                  borderTop: `1px solid ${T.dim}` }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>
                      {w.aisle ? `${CAT_ICON[w.aisle] || ""} ` : ""}{w.label}</div>
                    <div style={{ fontSize: 11.5, color: T.leaf, fontWeight: 700,
                      marginTop: 2 }}>
                      {n} {n === 1 ? "shopper waiting" : "shoppers waiting"}</div>
                  </div>
                  {onPostFor && (
                    <button onClick={() => onPostFor(w.label, w.aisle)}
                      style={{ fontFamily: FONT, cursor: "pointer", flexShrink: 0,
                        background: T.tag, color: "#fff", border: "none", borderRadius: 999,
                        padding: "7px 12px", fontSize: 11.5, fontWeight: 800 }}>
                      Post a sale</button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 9 }}>Recent activity</div>
        {activity.length === 0 && (
          <div style={{ fontSize: 13, color: T.mute, background: T.card,
            border: `1px dashed ${T.line}`, borderRadius: 10, padding: 16,
            textAlign: "center", lineHeight: 1.5 }}>
            Nothing yet. Follow this shop from the shopper side and watch it land here.</div>
        )}
        {activity.map((a) => (
          <div key={a.id} style={{ background: T.card, border: `1px solid ${T.line}`,
            borderRadius: 10, padding: 12, marginBottom: 8, display: "flex", gap: 11,
            alignItems: "flex-start" }}>
            <div style={{ width: 26, height: 26, borderRadius: 999, flexShrink: 0,
              display: "grid", placeItems: "center", background: tone[a.type], color: "#fff",
              fontSize: 13, fontWeight: 800 }}>{icon[a.type]}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.35 }}>{a.text}</div>
              {a.detail && <div style={{ fontSize: 11.5, color: T.mute, marginTop: 3 }}>
                {a.detail}</div>}
              <div style={{ fontSize: 11, color: T.mute, marginTop: 5, opacity: 0.75 }}>{a.at}</div>
            </div>
          </div>
        ))}

        {/* Walkthrough only. Inventing a follower on a real shop's activity
            log would corrupt the one number the shop is paying for. */}
        {!LIVE && onSimulate && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px dashed ${T.line}` }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: T.mute, marginBottom: 8 }}>
              Prototype control</div>
            <Btn kind="ghost" full onClick={onSimulate}>
              Simulate a nearby shopper following</Btn>
          </div>
        )}
      </Scroll>
    </>
  );
}

/* What the shop owner sees about money, which on the App Store is nothing.
 *
 * Apple requires that anything bought and used inside an app is bought through
 * Apple, who take a share. Dealtitude is not sold inside the app at all — shops
 * are invited, invoiced and paid outside it, and nothing here takes a payment.
 * But a screen showing "$49 per shop per month", a monthly total and a Manage
 * payment method button reads exactly like the thing that rule is about, and a
 * reviewer decides in a minute or two.
 *
 * So the native build states the plan and leaves the money out. The shop owner
 * loses nothing: they know what they pay, because the invoice says so. On the
 * web, where no such rule exists, the full billing card stays. */
function PlanSummary({ shops, subs }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
      padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>Your shops</div>
      <div style={{ fontSize: 12, color: T.mute, margin: "3px 0 12px", lineHeight: 1.45 }}>
        Post as often as you like — what protects your followers is the daily cap,
        not a quota.
      </div>
      {shops.map((sh) => {
        const founding = (subs[sh.id]?.plan || "paid") === "founding";
        return (
          <div key={sh.id} style={{ display: "flex", justifyContent: "space-between",
            alignItems: "center", gap: 10, padding: "9px 0",
            borderTop: `1px solid ${T.dim}` }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{sh.name}</div>
            <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
              color: founding ? T.leaf : T.mute }}>
              {founding ? "Founding shop" : "Active"}</div>
          </div>
        );
      })}
      <div style={{ fontSize: 11.5, color: T.mute, marginTop: 11, lineHeight: 1.45,
        paddingTop: 11, borderTop: `1px solid ${T.dim}` }}>
        Billing is handled directly with Dealtitude — nothing is charged through this app.
      </div>
    </div>
  );
}

function Billing({ shops, subs, price }) {
  const paid = shops.filter((sh) => (subs[sh.id]?.plan || "paid") === "paid");
  const total = paid.length * price;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
      padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>Your plan</div>
      <div style={{ fontSize: 12, color: T.mute, margin: "3px 0 12px", lineHeight: 1.45 }}>
        ${price} per shop per month. Post as often as you like — what protects your
        followers is the daily cap, not a quota.
      </div>

      {shops.map((sh) => {
        const sub = subs[sh.id] || { plan: "paid" };
        const founding = sub.plan === "founding";
        return (
          <div key={sh.id} style={{ display: "flex", justifyContent: "space-between",
            alignItems: "center", gap: 10, padding: "9px 0",
            borderTop: `1px solid ${T.dim}` }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{sh.name}</div>
              {founding && <div style={{ fontSize: 11, color: T.leaf, fontWeight: 700,
                marginTop: 2 }}>Founding shop · free until {sub.until}</div>}
            </div>
            <div style={{ fontSize: 14, fontWeight: 800, whiteSpace: "nowrap",
              color: founding ? T.leaf : T.ink, fontVariantNumeric: "tabular-nums" }}>
              {founding ? "$0" : `$${price}`}</div>
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
        paddingTop: 11, marginTop: 4, borderTop: `2px solid ${T.ink}` }}>
        <div style={{ fontSize: 13.5, fontWeight: 800 }}>Billed monthly</div>
        <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
          ${total}</div>
      </div>
      <div style={{ fontSize: 11.5, color: T.mute, marginTop: 8, lineHeight: 1.45 }}>
        {paid.length === 0
          ? "Nothing to pay while your shops are on founding terms."
          : `${paid.length} shop${paid.length === 1 ? "" : "s"} at $${price}. Cancel any month; your page stays up until the period ends.`}
      </div>
      <div style={{ marginTop: 12 }}>
        <Btn kind="ghost" full onClick={() => {}}>
          {paid.length === 0 ? "Add a card for later" : "Manage payment method"}</Btn>
      </div>
    </div>
  );
}

function OwnerSettings({ store, onChange, notif, actingAs, onRevoke, shops, subs, price }) {
  return (
    <>
      <Head title="Settings" sub={shops.length > 1
        ? `${shops.length} shops on this login` : store.name} />
      <Scroll>
        {NATIVE ? <PlanSummary shops={shops} subs={subs} />
                : <Billing shops={shops} subs={subs} price={price} />}
        <NotifCard {...notif} who="Follower" debug />

        <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
          padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Who can alert your followers</div>
          <div style={{ fontSize: 12, color: T.mute, margin: "3px 0 11px", lineHeight: 1.45 }}>
            Only the account that holds this shop. Nobody else can send a notification in
            your shop's name — not another shopper, not another shop, not us.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.dim,
            border: `1px solid ${T.line}`, borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ width: 28, height: 28, borderRadius: 99, background: T.ink,
              color: T.tag, display: "grid", placeItems: "center", fontSize: 13,
              fontWeight: 800, flexShrink: 0 }}>{(store.name || "?")[0]}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700 }}>{store.name}</div>
              <div style={{ fontSize: 11, color: T.mute, marginTop: 1 }}>
                This login · nothing to switch on</div>
            </div>
          </div>
        </div>

        <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
          padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Daily alert cap</div>
          <div style={{ fontSize: 12, color: T.mute, margin: "3px 0 12px", lineHeight: 1.45 }}>
            The most alerts one follower can get from you in a day. Lower is safer — people
            mute shops that shout.</div>
          <div style={{ display: "flex", gap: 7 }}>
            {[1, 2, 3, 4, 6].map((n) => (
              <Chip key={n} on={store.cap === n} onClick={() => onChange({ cap: n })}>{n}</Chip>
            ))}
          </div>
        </div>

        {actingAs && (
          <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12,
            padding: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Posting access</div>
            <div style={{ fontSize: 12, color: T.mute, margin: "3px 0 10px", lineHeight: 1.45 }}>
              <b style={{ color: T.ink }}>{actingAs}</b> can post sales for you. Everything
              they add shows their name. Access ends automatically in 45 days.</div>
            <Btn kind="ghost" full onClick={onRevoke}>Remove access</Btn>
          </div>
        )}
      </Scroll>
    </>
  );
}

/* ============================ admin ============================ */

function AdminStores({ stores, invites, members, products, follows, onInvite, onOpenLink,
                       onNew, onRemove, onReset, subs, price }) {
  const [email, setEmail] = useState("");
  /* Typed, not tapped. This is the one control in the app that cannot be
     undone, so it asks for the word in full. */
  const [resetWord, setResetWord] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  /* No shops is a normal state — the first thing you do is clear the demo ones
     out. Reading stores[0].id crashed the whole screen the moment it was. */
  const [target, setTarget] = useState(stores[0]?.id || "");
  const [confirming, setConfirming] = useState(null);
  const statusOf = (id) => {
    if (members.find((m) => m.storeId === id)) return "active";
    if (invites.find((i) => i.storeId === id && !i.accepted)) return "invited";
    return "none";
  };
  const badge = { active: [T.leaf, "Owner active"], invited: [T.tag, "Invite sent"],
    none: [T.mute, "No owner yet"] };

  return (
    <>
      <Head title="Collaborating shops" sub={`${stores.length} shops · ${members.length} owners live`} />
      <Scroll>
        {stores.map((s) => {
          const st = statusOf(s.id);
          const [col, text] = badge[st];
          const inv = invites.find((i) => i.storeId === s.id && !i.accepted);
          return (
            <div key={s.id} style={{ background: T.card, border: `1px solid ${T.line}`,
              borderRadius: 12, padding: 13, marginBottom: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 800 }}>{s.name}</div>
                  <div style={{ fontSize: 11.5, color: T.mute, marginTop: 2 }}>
                    {s.town} · {products.filter((p) => p.store === s.id && p.status === "active").length} live
                    {/* Live, baseFollowers IS the server's count and already
                        includes this phone if it follows — adding one again
                        showed a follower that did not exist, which then
                        contradicted "nobody follows this shop" on the very
                        next screen. Only the demo number needs the local
                        follow added to it. */}
                    · {LIVE ? s.baseFollowers
                            : s.baseFollowers + (follows[s.id] ? 1 : 0)} followers</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: col,
                    border: `1px solid ${col}`, borderRadius: 4, padding: "3px 6px",
                    whiteSpace: "nowrap", display: "inline-block" }}>{text.toUpperCase()}</span>
                  {st === "active" && (
                    <div style={{ fontSize: 11, fontWeight: 700, marginTop: 6,
                      color: (subs[s.id]?.plan === "founding") ? T.leaf : T.ink }}>
                      {(subs[s.id]?.plan === "founding") ? "founding · $0" : `$${price}/mo`}</div>
                  )}
                </div>
              </div>
              {inv && (
                <div style={{ marginTop: 11, paddingTop: 10, borderTop: `1px solid ${T.dim}` }}>
                  <div style={{ fontSize: 11.5, color: T.mute, marginBottom: 8 }}>
                    Sent to {inv.email} · expires in 14 days</div>
                  <Btn kind="ghost" full onClick={() => onOpenLink(inv)}>
                    Open the invite link as the owner</Btn>
                </div>
              )}

              {/* Taking a shop down asks once. Details get mistyped at a
                  counter, and a single tap that removes the wrong shop in front
                  of its owner is not a mistake worth allowing. */}
              {onRemove && (
                <div style={{ marginTop: 11, paddingTop: 10, borderTop: `1px solid ${T.dim}` }}>
                  {confirming === s.id ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ fontSize: 12, color: T.mute, flex: 1, lineHeight: 1.4 }}>
                        Take {s.name} off the app?</div>
                      <button onClick={() => setConfirming(null)} style={{ border: "none",
                        background: "none", fontFamily: FONT, fontSize: 12.5, fontWeight: 700,
                        color: T.mute, cursor: "pointer", padding: 6 }}>Keep</button>
                      <button onClick={() => { setConfirming(null); onRemove(s.id); }}
                        style={{ border: "none", background: T.cut, color: "#fff",
                          borderRadius: 8, padding: "8px 13px", fontFamily: FONT,
                          fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>Remove</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirming(s.id)} style={{ border: "none",
                      background: "none", fontFamily: FONT, fontSize: 12, fontWeight: 700,
                      color: T.mute, cursor: "pointer", padding: 0 }}>Remove this shop</button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Last thing on the screen, deliberately. */}
        {onReset && (
          <div style={{ border: `1px solid ${T.cut}`, borderRadius: 12, padding: 13,
            marginTop: 18, marginBottom: 6 }}>
            {!resetOpen ? (
              <button onClick={() => setResetOpen(true)} style={{ border: "none",
                background: "none", fontFamily: FONT, fontSize: 12.5, fontWeight: 700,
                color: T.cut, cursor: "pointer", padding: 0 }}>
                Start fresh — clear every shop and follower</button>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 800, color: T.cut }}>
                  Clear everything?</div>
                <div style={{ fontSize: 12, color: T.mute, margin: "6px 0 11px",
                  lineHeight: 1.45 }}>
                  Every shop, owner, follower and posted alert is deleted for good.
                  There is no undo. Type RESET to confirm.</div>
                <input value={resetWord} onChange={(e) => setResetWord(e.target.value)}
                  placeholder="RESET" autoCapitalize="characters"
                  style={{ width: "100%", padding: "11px 12px", borderRadius: 9,
                    border: `1px solid ${T.line}`, fontFamily: FONT, fontSize: 14,
                    background: T.card, color: T.ink, boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button onClick={() => { setResetOpen(false); setResetWord(""); }}
                    style={{ flex: 1, border: `1px solid ${T.line}`, background: T.card,
                      color: T.mute, borderRadius: 9, padding: "11px 0", fontFamily: FONT,
                      fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
                  <button disabled={resetWord.trim().toUpperCase() !== "RESET"}
                    onClick={() => { setResetOpen(false); setResetWord(""); onReset(); }}
                    style={{ flex: 1, border: "none",
                      background: resetWord.trim().toUpperCase() === "RESET" ? T.cut : T.dim,
                      color: resetWord.trim().toUpperCase() === "RESET" ? "#fff" : T.mute,
                      borderRadius: 9, padding: "11px 0", fontFamily: FONT, fontSize: 13,
                      fontWeight: 800,
                      cursor: resetWord.trim().toUpperCase() === "RESET"
                        ? "pointer" : "not-allowed" }}>Clear everything</button>
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ background: T.ink, color: "#fff", borderRadius: 12, padding: 14,
          marginTop: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 800 }}>Invite an owner</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.65)", margin: "4px 0 12px",
            lineHeight: 1.45 }}>
            You create the shop; they only ever receive access. There's no owner signup
            form anywhere in the app.</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {stores.map((s) => (
              <Chip key={s.id} on={target === s.id} onClick={() => setTarget(s.id)}>
                {s.name}</Chip>
            ))}
          </div>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="owner@theirshop.com" style={{ width: "100%", padding: "11px 12px",
              borderRadius: 9, border: "1.5px solid rgba(255,255,255,.2)", fontFamily: FONT,
              fontSize: 16, background: "rgba(255,255,255,.08)", color: "#fff",
              boxSizing: "border-box", marginBottom: 10 }} />
          <Btn kind="tag" full disabled={!email.includes("@")}
            onClick={() => { onInvite(target, email); setEmail(""); }}>Send invitation</Btn>
        </div>

        <div style={{ marginTop: 14 }}>
          <Btn kind="ghost" full onClick={onNew}>Add a new shop</Btn>
        </div>
      </Scroll>
    </>
  );
}

/* ---------------------------------------------------------------------------
 * Signing up a shop while standing in it.
 *
 * This is the one screen that has to work on a counter, with the owner
 * watching and a queue behind you. So: every aisle is typed in their words,
 * not picked from a list somebody guessed in advance — a liquor store's aisles
 * are Rum and Whiskey, a butcher's are Lamb and Goat, and a generic "Pantry"
 * chip is how you lose the room.
 *
 * It creates the shop on the server and invites the owner in one go, because a
 * shop that exists but has no owner is a visit you have to repeat.
 * ------------------------------------------------------------------------- */

/* Starting points, not a menu. Tapping one adds it as text you can then edit
   or delete, and shops that fit none of these are the normal case. */
const AISLE_IDEAS = {
  grocery: ["Fresh vegetables", "Fruit", "Paneer & dairy", "Sweets", "Spices & dry goods",
            "Frozen & snacks", "Rice & flour"],
  liquor: ["Whiskey", "Rum", "Vodka", "Gin", "Beer", "Wine", "Tequila"],
  butcher: ["Goat", "Lamb", "Chicken", "Fish", "Marinated & ready"],
  bakery: ["Bread", "Cakes", "Pastries", "Savouries", "Made to order"],
};

/* The operator key, asked for once per phone.
 *
 * Creating a shop is the only action in Dealtitude that no shop owner and no
 * shopper may ever perform, and it is guarded by a key rather than by a role —
 * because a role lives on an account somebody could be talked into granting.
 * The key is typed here, checked against the server before it is trusted, and
 * kept on this phone only. */
function AdminKeyScreen({ onSave, busy, error }) {
  const [key, setKey] = useState("");
  return (
    <>
      <Head title="Operator key" sub="Needed once on this phone" />
      <Scroll>
        <div style={{ fontSize: 13.5, color: T.mute, lineHeight: 1.55, marginBottom: 16 }}>
          Adding a shop is the one thing only you can do. Paste the key from your
          server's settings — it is the value of <b style={{ color: T.ink }}>ADMIN_KEY</b> on
          Render, under Environment.
        </div>
        <input value={key} onChange={(e) => setKey(e.target.value)}
          placeholder="Paste ADMIN_KEY" autoCapitalize="off" spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter" && key.trim() && !busy) onSave(key); }}
          style={{ width: "100%", padding: "12px 13px", borderRadius: 10, fontSize: 15,
            border: `1.5px solid ${T.line}`, fontFamily: FONT, background: T.card,
            boxSizing: "border-box", marginBottom: 12 }} />
        {error && <div style={{ fontSize: 12.5, color: T.cut, fontWeight: 700,
          marginBottom: 12, lineHeight: 1.45 }}>{error}</div>}
        <Btn full disabled={!key.trim() || busy} onClick={() => onSave(key)}>
          {busy ? "Checking…" : "Save key"}</Btn>
        <div style={{ fontSize: 11.5, color: T.mute, marginTop: 14, lineHeight: 1.5 }}>
          Stored on this phone only. It is never sent anywhere except to your own server,
          and never to a shop.
        </div>
      </Scroll>
    </>
  );
}

function AdminNewStore({ onCancel, onCreate, busy, error }) {
  /* Nothing prefilled. A town and ZIP that happen to be right most of the time
     are wrong the first time you sign a shop in the next town, and nobody
     re-reads a field that already has something in it. */
  const [f, setF] = useState({ name: "", addr: "", town: "", zip: "",
    email: "", alcohol: false });
  /* Hours are picked, not typed: days as toggles, open and close as real time
     inputs, so iOS gives its own wheel rather than a free-text box that ends up
     holding "9-8ish". */
  const [days, setDays] = useState([1, 2, 3, 4, 5, 6, 0]);
  const [open, setOpen] = useState("09:00");
  const [close, setClose] = useState("20:00");
  const [aisles, setAisles] = useState([]);
  const [typed, setTyped] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const addAisle = (name) => {
    const v = String(name).trim().slice(0, 40);
    if (!v) return;
    /* Case-insensitive, because "whiskey" and "Whiskey" on one shelf list
       looks like a mistake the shop made. */
    if (aisles.some((a) => a.toLowerCase() === v.toLowerCase())) return;
    if (aisles.length >= 20) return;
    setAisles([...aisles, v]);
    setTyped("");
  };
  const drop = (a) => setAisles(aisles.filter((x) => x !== a));

  const emailOk = !f.email.trim() || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  const hours = describeHours(days, open, close);
  const ready = f.name.trim() && f.addr.trim() && f.town.trim() &&
    /^\d{5}$/.test(f.zip) && aisles.length > 0 && days.length > 0 &&
    open && close && emailOk && !busy;

  const field = { width: "100%", padding: "12px 13px", borderRadius: 9,
    border: `1.5px solid ${T.line}`, fontFamily: FONT, fontSize: 16, background: T.card,
    boxSizing: "border-box" };
  const label = { fontSize: 11.5, fontWeight: 800, color: T.mute, marginBottom: 5,
    display: "block" };

  return (
    <>
      <Head title="Add a shop" sub="Fill this in with the owner" onBack={onCancel} />
      <Scroll>
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          <div><span style={label}>Shop name</span>
            <input value={f.name} onChange={set("name")} placeholder="Name on the sign"
              style={field} /></div>

          {f.name.trim() && (
            <div style={{ fontSize: 11.5, color: T.mute, marginTop: -8,
              overflowWrap: "anywhere", wordBreak: "break-word" }}>
              Their card will say <b style={{ color: T.ink }}>
                dealtitude.com/{API.slugify(f.name)}</b>
            </div>
          )}

          <div><span style={label}>Street address</span>
            <input value={f.addr} onChange={set("addr")}
              placeholder="Street and plaza, if any" style={field} /></div>

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 2 }}><span style={label}>Town</span>
              <input value={f.town} onChange={set("town")} placeholder="Town" style={field} /></div>
            <div style={{ flex: 1 }}><span style={label}>ZIP</span>
              <input value={f.zip} onChange={(e) => setF({ ...f,
                zip: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                inputMode="numeric" placeholder="08831" style={field} /></div>
          </div>

          <div>
            <span style={label}>Which days are they open?</span>
            {/* Wraps on a narrow phone rather than squeezing seven buttons into
                a row that cannot hold them. */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {DAY_NAMES.map((d, i) => {
                const on = days.includes(i);
                return (
                  <button key={d} onClick={() => setDays(on
                      ? days.filter((x) => x !== i)
                      : [...days, i].sort((a, b) => a - b))}
                    style={{ flex: "1 0 38px", minWidth: 38, padding: "10px 0",
                      borderRadius: 8, cursor: "pointer",
                      fontFamily: FONT, fontSize: 12.5, fontWeight: 800,
                      border: `1.5px solid ${on ? T.leaf : T.line}`,
                      background: on ? T.leaf : T.card, color: on ? "#fff" : T.mute }}>
                    {d}</button>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><span style={label}>Opens</span>
              <input type="time" value={open} onChange={(e) => setOpen(e.target.value)}
                style={field} /></div>
            <div style={{ flex: 1 }}><span style={label}>Closes</span>
              <input type="time" value={close} onChange={(e) => setClose(e.target.value)}
                style={field} /></div>
          </div>

          {hours && <div style={{ fontSize: 12, color: T.mute, marginTop: -6 }}>
            Their page will say <b style={{ color: T.ink }}>{hours}</b></div>}

          {/* The part that has to be in their words. */}
          <div>
            <span style={label}>Their aisles — ask them what they sell</span>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={typed} onChange={(e) => setTyped(e.target.value)}
                placeholder="Whiskey"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAisle(typed); } }}
                style={{ ...field, flex: 1 }} />
              <button onClick={() => addAisle(typed)} disabled={!typed.trim()}
                style={{ padding: "0 18px", borderRadius: 9, border: "none",
                  background: typed.trim() ? T.ink : T.line, color: "#fff",
                  fontFamily: FONT, fontSize: 15, fontWeight: 800,
                  cursor: typed.trim() ? "pointer" : "default" }}>Add</button>
            </div>

            {aisles.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 11 }}>
                {aisles.map((a) => (
                  <button key={a} onClick={() => drop(a)} style={{ border: `1.5px solid ${T.leaf}`,
                    background: T.leaf, color: "#fff", borderRadius: 99, padding: "7px 12px",
                    fontFamily: FONT, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                    {a} ✕</button>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11.5, color: T.mute, marginTop: 11, lineHeight: 1.45 }}>
              Tap to remove. Quick starts:
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
              {Object.entries(AISLE_IDEAS).map(([kind, list]) => (
                <button key={kind} onClick={() => list.forEach(addAisle)}
                  style={{ border: `1px solid ${T.line}`, background: T.card, color: T.mute,
                    borderRadius: 99, padding: "6px 11px", fontFamily: FONT, fontSize: 12,
                    fontWeight: 700, cursor: "pointer", textTransform: "capitalize" }}>
                  + {kind}</button>
              ))}
            </div>
          </div>

          <div onClick={() => setF({ ...f, alcohol: !f.alcohol })} style={{
            display: "flex", gap: 11, alignItems: "flex-start", cursor: "pointer",
            background: f.alcohol ? "#FFF6E8" : T.card, padding: 13, borderRadius: 10,
            border: `1.5px solid ${f.alcohol ? T.tag : T.line}` }}>
            <div style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0, marginTop: 1,
              border: `1.5px solid ${f.alcohol ? T.tag : T.line}`,
              background: f.alcohol ? T.tag : "transparent", color: T.ink, fontSize: 13,
              fontWeight: 900, display: "flex", alignItems: "center",
              justifyContent: "center", lineHeight: 1 }}>{f.alcohol ? "✓" : ""}</div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>This shop sells alcohol</div>
              <div style={{ fontSize: 11.5, color: T.mute, marginTop: 3, lineHeight: 1.45 }}>
                Shoppers confirm they're 21 or over before they can follow it. It cannot be
                added later without alerts having already gone out ungated.</div>
            </div>
          </div>

          <div><span style={label}>Owner's email — they'll sign in with this</span>
            <input value={f.email} onChange={set("email")} type="email" inputMode="email"
              autoCapitalize="off" spellCheck={false}
              placeholder="owner@theirshop.com" style={field} />
            <div style={{ fontSize: 11.5, color: T.mute, marginTop: 6, lineHeight: 1.45 }}>
              Leave blank to add the shop now and invite them later.</div>
          </div>

          {!emailOk && <div style={{ fontSize: 12, color: T.cut, fontWeight: 700 }}>
            That email doesn't look right.</div>}
          {error && <div style={{ fontSize: 12.5, color: T.cut, fontWeight: 700,
            lineHeight: 1.45 }}>{error}</div>}

          <Btn full disabled={!ready} onClick={() => onCreate({
            slug: API.slugify(f.name), name: f.name.trim(), address: f.addr.trim(),
            town: f.town.trim(), zip: f.zip, hours: hours || null,
            aisles, daily_cap: 3, min_age: f.alcohol ? 21 : null,
            email: f.email.trim() || null,
          })}>{busy ? "Creating…" : "Create this shop"}</Btn>
        </div>
      </Scroll>
    </>
  );
}
function App() {
  /* identity */
  const [session, setSession] = useState(null);
  const [sheet, setSheet] = useState(null);         // 'providers' | 'accounts' | 'account'
  const [authReason, setAuthReason] = useState(null);
  const [pending, setPending] = useState(null);     // action to resume after sign-in
  const [invites, setInvites] = useState([
    { id: uid(), storeId: "s1", email: "owner@brownbrosgrocery.com", accepted: false },
  ]);

  /* $49 per shop per month, unlimited posts. Founding shops are free for a
     year — the promise already made on the website. */
  const PRICE = 49;
  const [subs, setSubs] = useState({
    s1: { plan: "founding", until: "1 Oct 2027" },
  });
  const [members, setMembers] = useState([]);       // [{storeId, email, role, acceptedBy}]
  const [openInvite, setOpenInvite] = useState(null);
  const [ownerStoreId, setOwnerStoreId] = useState(null);
  const [joinStore, setJoinStore] = useState(null);

  /* data
   *
   * LIVE STARTS EMPTY. The invented shops and posts below are the walkthrough,
   * and seeding them in every mode was the single mistake behind most of a
   * bad day: Brown Brothers Grocery and Shore Fish & Meat appearing in a real
   * operator's shop list, a shop showing 41 followers that do not exist, and a
   * post then correctly reporting that nobody follows it — the app arguing
   * with itself.
   *
   * Every screen that filters by ZIP or by server data happened to hide them;
   * every screen that just lists what it was given showed them. Chasing those
   * one screen at a time was treating symptoms. Real mode has no invented data
   * in it at all. */
  const [stores, setStores] = useState(LIVE ? [] : STORES);
  const [products, setProducts] = useState(LIVE ? [] : SEED);

  /* Each shop's own barcode catalogue, built by using it. No public product
     database carries a 20 lb sack of basmati from a Monroe Township grocer,
     so the shop types a name once and owns it from then on. */
  const [catalog, setCatalog] = useState({});
  const learnItem = (storeId, gtin, item) => {
    if (!gtin || !item.name) return;
    setCatalog((c) => ({ ...c, [storeId]: { ...(c[storeId] || {}), [gtin]: item } }));
  };

  /* Live, the shop's catalogue is on the server, so a barcode the owner named
     on the till phone fills itself in on the stockroom phone too. Cached here
     as well, which is what keeps a scan working when the signal drops. */
  const gtinLookup = (storeId) => async (gtin) => {
    const hit = await API.lookupGtin(storeId, gtin);
    if (!hit) return null;
    /* The server keeps money in cents as a number; the form is a text box in
       dollars. Handing it the raw number did two things at once: the screen
       crashed on f.now.trim(), and on the way to crashing it would have put
       "1250" in the price box and posted a $12.50 jar of pickles at $1,250.
       Both only ever happened on the SECOND scan of a barcode — the first
       scan has nothing remembered — which is why it survived every test. */
    const money = (cents) =>
      cents == null || cents === "" ? "" : (Number(cents) / 100).toFixed(2);
    const item = { name: hit.name, cat: hit.aisle || undefined,
                   was: money(hit.was_cents), now: money(hit.now_cents) };
    learnItem(storeId, gtin, item);
    return item;
  };
  const [follows, setFollows] = useState({});
  const [inbox, setInbox] = useState([]);
  const [held, setHeld] = useState([]);
  const [activity, setActivity] = useState([]);
  /* Item asks, per shop, as the server reports them: { wants, suggest, mine }.
     The old pair of states counted asks on this device and never sent them
     anywhere, which meant an owner's demand panel was reading one phone's own
     taps back to it. In demo mode there is no server, so a local shape stands
     in — but it is the same shape, and nothing downstream knows the
     difference. */
  const [wants, setWants] = useState({});
  /* The owner's side of the same data, and the item they tapped "Post a sale"
     on, which the compose screen opens with. */
  const [demand, setDemand] = useState({});
  const [prefill, setPrefill] = useState(null);
  const [extraFollowers, setExtra] = useState(0);
  const [decision, setDecision] = useState(null);
  const [broadcasts, setBroadcasts] = useState([]);
  const [zipWaitlist, setWaitlist] = useState([]);

  /* navigation */
  const [zip, setZip] = useState("");
  const [zipErr, setZipErr] = useState(null);
  const [screen, setScreen] = useState("landing");  // landing | app | invite
  const [view, setView] = useState("shopper");      // shopper | owner | admin
  const [tab, setTab] = useState("stores");
  const [oTab, setOTab] = useState("sales");
  const [aTab, setATab] = useState("stores");
  const [openStore, setOpenStore] = useState(null);

  /* notifications */
  const [notifState, setNotifState] = useState(
    NATIVE ? "default"
           : typeof Notification !== "undefined" ? Notification.permission : "unsupported");
  const [lastFail, setLastFail] = useState(null);
  const [standalone, setStandalone] = useState(false);
  const [push, setPush] = useState(null);
  const [deviceToken, setDeviceToken] = useState(null);
  useEffect(() => { setStandalone(isStandalone()); }, []);

  /* Native boot: system bars, the push token, notification taps, and links
     from the QR codes. No-ops in a browser. */
  useEffect(() => {
    onNotifyFail = (r) => setLastFail(r);
    Native.initNative((e) => {
      /* The phone has given us an address Apple or Google can deliver to.
         Holding it only in React state — which is all this did before — meant
         the server had no way to reach a single App Store follower: they were
         counted as followers and never heard anything. */
      if (e.type === "token") {
        setDeviceToken(e.token);
        setNotifState("granted");
        if (LIVE) {
          API.registerNativePush(e.token, e.platform)
            .then((r) => { if (!r.ok) setLastFail(r.why === "no-token" ? "error" : "server"); })
            .catch(() => setLastFail("server"));
        }
      }
      if (e.type === "tokenError") setLastFail("error");
      if (e.type === "received" || e.type === "opened") {
        const shop = e.data?.shop;
        if (shop && STORES.some((x) => x.id === shop)) { setOpenStore(shop); setScreen("app"); }
      }
      /* An owner tapped their invite link on a phone with the app installed.
         Sign them in here rather than sending them to a browser. */
      if (e.type === "owner-link" && e.token) {
        (async () => {
          try {
            const v = await API.verifyLink(e.token);
            await adoptOwner();
            setNetErr(v.claimed > 0
              ? `Signed in. ${v.claimed === 1 ? "Your shop is" : `${v.claimed} shops are`} ready.`
              : "Signed in.");
          } catch (err) {
            setSheet("owner-signin");
            setLinkErr(err.status === 401
              ? "That link has been used already, or has expired. Ask for a new one."
              : err.message);
          }
        })();
        return;
      }
      if (e.type === "deeplink" && LIVE) { setOpenStore(e.shop); setScreen("app"); return; }
      if (e.type === "deeplink" && STORES.some((x) => x.id === e.shop)) {
        setJoinStore(e.shop); setScreen("join");
      }
      if (e.type === "back" && e.canGoBack) window.history.back();
    });
  }, []);

  /* A code at the register points at dealtitude.com/<slug>. Land on that shop,
     skip the ZIP.

     The host rewrites /aum to the app WITHOUT changing the address bar, so the
     path is the only place the shop is named — reading just location.search
     would quietly drop every printed card back to the ZIP screen. Path first,
     then ?s= and #s= for links shared by hand. */
  useEffect(() => {
    let path = "";
    try {
      path = window.location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    } catch { return; }
    const qs = new URLSearchParams(window.location.search);
    const hash = (window.location.hash || "").replace(/^#s=/, "");

    /* /owner?token=… is the sign-in link, not a shop. */
    if (path === "owner" || qs.get("token")) return;

    if (!LIVE) {
      const q = SLUGS[path] || qs.get("s") || hash;
      if (q && STORES.some((x) => x.id === q)) { setJoinStore(q); setScreen("join"); }
      return;
    }

    /* Live, the path IS the shop's slug — so a new shop's card works the
       moment the shop exists, with no redeploy and no rewrite rule to add.
       Ask the server; an unknown slug falls through to the ZIP screen rather
       than showing an error to someone who just scanned a code. */
    const slug = (path || qs.get("s") || hash).trim();
    if (!slug || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return;
    let gone = false;
    (async () => {
      try {
        const r = await API.shop(slug);
        if (gone) return;
        const s = toStore(r.shop || r);
        setStores((prev) => (prev.some((x) => x.id === s.id)
          ? prev.map((x) => (x.id === s.id ? { ...x, ...s } : x))
          : [...prev, s]));
        setProducts((ps) => {
          const have = new Set(ps.map((p) => p.id));
          const add = (r.posts || []).map(toProduct)
            .map((p) => ({ ...p, store: s.id }))
            .filter((p) => !have.has(p.id));
          return add.length ? [...add, ...ps] : ps;
        });
        setJoinStore(s.id);
        setScreen("join");
      } catch { /* not a shop — the ZIP screen is the right place to land */ }
    })();
    return () => { gone = true; };
  }, []);
  useEffect(() => {
    if (!push) return;
    const t = setTimeout(() => setPush(null), 5400);
    return () => clearTimeout(t);
  }, [push]);

  /* ---- live mode ---- */
  const [netErr, setNetErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [liveReach, setLiveReach] = useState({});
  /* the shop whose "add to home screen" sheet is open, if any */
  const [installFor, setInstallFor] = useState(null);
  /* Operator state. These MUST live here with every other hook: React requires
     the same hooks in the same order on every render, and a useState declared
     further down — below an early return — crashes the whole app the moment
     that return is taken. It did exactly that on sign-in. */
  const [adminKeyOk, setAdminKeyOk] = useState(() => (LIVE ? API.hasAdminKey() : true));

  /* Whether this server will accept a start-fresh at all, so the control is
     absent rather than present-and-failing.

     Up here with the other hooks, NOT down beside the handler it belongs to.
     Put next to its handler it sat below a branch, so it ran on some renders
     and not others — React counts hooks per render and throws #310 when the
     number changes. That crash blanked the whole screen, and the symptom
     (a dead shop list) pointed nowhere near the cause. Second time. */
  /* A link to hand an owner when the email did not send. Kept so the visit
     can finish either way rather than ending with the owner locked out. */
  const [ownerLink, setOwnerLink] = useState(null);
  const [canReset, setCanReset] = useState(false);
  useEffect(() => {
    if (!LIVE || !adminKeyOk) return;
    let alive = true;
    API.resetAvailable().then((v) => { if (alive) setCanReset(v === true); })
      .catch(() => {});
    return () => { alive = false; };
  }, [adminKeyOk]);
  const [adminErr, setAdminErr] = useState(null);
  /* The slug whose age gate is up, and the highest bar this phone has cleared.
     Seeded from the device's own record so a returning shopper is not asked
     again every time the app opens. */
  const [ageFor, setAgeFor] = useState(null);
  const [ageCleared, setAgeCleared] = useState(() => (LIVE ? API.ageCleared() : 0));
  const [canInstall, setCanInstall] = useState(Install.canPromptInstall());

  /* Chrome decides when an app is installable and tells us once. */
  useEffect(() => Install.watchInstallable(setCanInstall), []);

  /* Coming back from Add to Home Screen: the claim code rode across in the
     bookmarked address. Redeem it and this install becomes the same follower,
     with the shops and aisles they already picked. */
  useEffect(() => {
    if (!LIVE) return;
    const code = Install.takeClaimCode();
    if (!code) return;
    (async () => {
      try {
        const r = await API.redeemClaim(code);
        setFollows(toFollows(r.follows));
        if (r.follows?.length) {
          setScreen((s) => (s === "landing" ? "app" : s));
          setNetErr("Welcome back — you're still following, alerts next.");
        }
      } catch { /* an expired code just means they follow again */ }
      finally { Install.clearClaimCode(); }
    })();
  }, []);

  /* On open, pick up what this phone already follows and what it has missed.
     A failure here must leave the app usable, so it only sets a banner. */
  useEffect(() => {
    if (!LIVE || !API.deviceToken()) return;
    let gone = false;
    (async () => {
      try {
        const [f, feed] = await Promise.all([API.myFollows(), API.myFeed()]);
        if (gone) return;
        setFollows(toFollows(f.follows));
        setProducts(feed.posts.map(toProduct));
        /* Any shop this phone follows belongs in the list whether or not a ZIP
           was typed — otherwise a followed shop has nowhere to render. */
        setStores((prev) => {
          const have = new Set(prev.map((s) => s.id));
          /* Carry min_age and hours through too: without the age limit a
             restored follow of a 21+ shop loses its gate, and without hours
             the shop card renders a blank line. */
          const add = f.follows.filter((x) => !have.has(x.slug)).map((x) => toStore({
            slug: x.slug, name: x.name, address: x.address, town: x.town,
            zip: x.zip, hours: x.hours, min_age: x.min_age,
            aisles: x.aisles, daily_cap: x.daily_cap, followers: 0 }));
          return add.length ? [...prev, ...add] : prev;
        });
        /* Somebody who already follows a shop should not be asked for their ZIP
           again on every open — open on what their shops are saying. */
        if (f.follows.length) {
          setScreen((s) => (s === "landing" ? "app" : s));
          setTab((t) => (t === "stores" ? "deals" : t));
        }
        setNetErr(null);
      } catch (e) {
        if (!gone) setNetErr(e.message);
      }
    })();
    return () => { gone = true; };
  }, []);

  /* The worker needs the API address and this device's token to report a tap,
     and it cannot ask the page for them once the app is closed. */
  useEffect(() => { if (LIVE) API.shareWithWorker(); }, []);

  /* What this shop is being asked for, fetched when its page opens. Kept here
     with the other effects rather than beside the handler that uses it —
     a hook declared next to its handler is how React error #310 got shipped
     twice. */
  useEffect(() => {
    if (!LIVE || !openStore) return;
    let gone = false;
    (async () => {
      try {
        const res = await API.wants(openStore);
        if (!gone) setWants((w) => ({ ...w, [openStore]: res }));
      } catch {
        if (!gone) setWants((w) => ({ ...w,
          [openStore]: { wants: [], suggest: [], mine: [] } }));
      }
    })();
    return () => { gone = true; };
  }, [openStore]);

  /* A tap on a notification, relayed by the worker to an already-open app. */
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (e) => {
      const open = e.data?.open;
      if (!open?.shop) return;
      setOpenStore(open.shop);
      setScreen("app");
      setTab("following");
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);

  const ACTING_AS = "Urvik (Dealtitude)";
  const storeOf = (id) => stores.find((s) => s.id === id);

  /* ---- derived role. Never chosen, never sent by a client. ---- */
  const isAdmin = session?.email === ADMIN_EMAIL;
  const myStores = session ? members.filter((m) => m.email === session.email) : [];
  const isOwner = myStores.length > 0;
  const myShopList = myStores.map((m) => storeOf(m.storeId)).filter(Boolean);
  const ownerStore = isOwner
    ? (myShopList.find((x) => x.id === ownerStoreId) || myShopList[0])
    : null;
  const roles = [...(isAdmin ? ["Platform admin"] : []),
                 ...(isOwner ? [myStores.length > 1
                     ? `Owner · ${myStores.length} shops` : `Owner · ${ownerStore?.name}`] : []),
                 "Shopper"];
  /* A shop owner signs in to run their shop, not to browse other shops. The
     shopper view is there for everyone else; sign out to see it. */
  useEffect(() => {
    /* Accepting an invite while browsing as a shopper would otherwise leave
       the view on a tab that no longer exists, with no way back. */
    if (isOwner && view === "shopper") setView("owner");
  }, [isOwner, view]);

  const availableViews = [
    ...(isAdmin ? [["admin", "Admin"]] : []),
    ...(isOwner ? [["owner", "My shop"]] : []),
    ...(isOwner ? [] : [["shopper", "Shop"]]),
  ];

  /* Baselines so the panel is realistic on first open; live follows add to it. */
  const REACH_BASE = { s1: { muted: 5, noPush: 7, newThisWeek: 9 },
                       s2: { muted: 2, noPush: 4, newThisWeek: 3 },
                       s3: { muted: 6, noPush: 9, newThisWeek: 11 },
                       s4: { muted: 1, noPush: 2, newThisWeek: 1 } };
  const reachOf = (id) => {
    /* Live, these are counted rows, not estimates — which is the point. A shop
       paying for reach is owed the real number even when the real number is
       small and unflattering. */
    if (LIVE) return liveReach[id] || { total: 0, muted: 0, noPush: 0,
                                        newThisWeek: 0, reachable: 0, aisles: [] };
    const total = followerCount(id);
    const b = REACH_BASE[id] || { muted: 0, noPush: 0, newThisWeek: 0 };
    const live = follows[id] ? 1 : 0;
    return { total, muted: b.muted, noPush: b.noPush,
      newThisWeek: b.newThisWeek + live,
      reachable: Math.max(0, total - b.muted - b.noPush) };
  };

  const followerCount = (id) => {
    if (LIVE) return liveReach[id]?.total ?? storeOf(id)?.baseFollowers ?? 0;
    return storeOf(id).baseFollowers + (follows[id] ? 1 : 0) +
           (id === "s1" ? extraFollowers : 0);
  };

  /* ---- notifications ---- */
  const ping = (title, body, tag) => {
    const r = notify(title, body, tag);
    setLastFail(r === "ok" ? null : r);
    return r;
  };
  /* Android ends up with an icon too — Chrome's own install dialog, one tap,
     no browser menu to hunt through. Unlike iOS this is a nicety rather than a
     requirement: notifications already work in the tab. So it is offered after
     alerts are on, never as a gate in front of them. */
  const offerAndroidInstall = async () => {
    if (!Install.canPromptInstall()) return;
    try { await Install.promptInstall(); } catch {}
  };

  const enableNotifications = async () => {
    const r = await Native.askNotificationPermission();
    setNotifState(r === "granted" ? "granted" : r === "denied" ? "denied" : r);
    if (r !== "granted") return;
    setLastFail(null);

    /* Permission alone sends nothing. The phone also has to be registered with
       the server, or it sits there "switched on" and silent — which is exactly
       the failure a shop owner would blame the app for. */
    if (LIVE && NATIVE) {
      /* Native registers through the OS: permission is granted here, the token
         arrives on the listener in initNative, and registerNativePush sends it
         on. Calling the web path here would look for a service worker that a
         native build does not have and report "this browser can't receive
         alerts" inside an app that can. */
      for (const slug of Object.keys(follows)) {
        try { await API.follow(slug, follows[slug]?.cats || []); } catch {}
      }
    } else if (LIVE) {
      const p = await API.enablePush();
      if (!p.ok) {
        setLastFail(p.why);
        setNetErr(p.why === "unsupported"
          ? "This browser can't receive alerts. Add Dealtitude to your home screen first."
          : "Notifications are on, but this phone couldn't be registered. Try again.");
        return;
      }
      /* Attach anything already followed on this device to the fresh identity. */
      for (const slug of Object.keys(follows)) {
        try { await API.follow(slug, follows[slug]?.cats || []); } catch {}
      }
      setNetErr(null);
    }

    ping("Notifications are on", "You'll hear the moment a shop you follow has news.",
      "welcome");

    /* Alerts are working now, so the icon is a bonus rather than a hurdle.
       Asked last, and only where Chrome has said it would be accepted. */
    offerAndroidInstall();
  };
  const notifProps = { notifState, standalone, lastFail, token: deviceToken,
    canInstall: canInstall && !standalone,
    onAndroidInstall: offerAndroidInstall,
    onInstall: () => setInstallFor(Object.keys(follows)[0] || stores[0]?.id),
    onEnable: enableNotifications,
    /* No test alerts in production. A test notification is indistinguishable
       on a lock screen from a real one, and a shopper has nothing to test —
       the first real post is the proof. Kept for the walkthrough, where
       nothing reaches a real phone. */
    onTest: LIVE ? undefined
      : () => ping("Test alert", "If this reached your lock screen, delivery works.",
          "test-" + uid()) };

  const logActivity = (type, text, detail, store) =>
    setActivity((a) => [{ id: uid(), type, text, detail, store, at: stamp() }, ...a].slice(0, 40));
  const ownerPing = (title, body, store) => {
    logActivity("follow", title, body, store);
    ping(title, body, "follow-" + uid());
    if (view === "owner") setPush({ title, body, kind: "owner" });
  };

  /* ---- auth ---- */
  const askSignIn = (reason, action) => {
    /* Live, the only reason to sign in is to run a shop — a shopper never has
       an account. So there is one route, and it is the owner's. */
    if (LIVE) { setSheet("owner-signin"); return; }
    setAuthReason(reason); setPending(action || null); setSheet("providers");
  };

  const [linkSent, setLinkSent] = useState(null);
  const [linkErr, setLinkErr] = useState(null);
  const [devLink, setDevLink] = useState(null);

  const sendOwnerLink = async (email) => {
    setLoading(true); setLinkErr(null);
    try {
      const r = await API.requestLink(email);
      /* Only claim an email was sent if one was. A server with no mail sender
         answered "sent" regardless, so the screen said to check an inbox that
         was never going to receive anything. */
      if (r.can_send === false) {
        setLinkSent(null);
        setLinkErr("This server can't send email yet, so no link has gone out. "
                 + "Sign in with a code instead, or ask whoever set up your shop "
                 + "for your link.");
        setDevLink(r.link || null);
        return;
      }
      setLinkSent(email);
      /* The server hands the link back only when no mail sender is configured,
         so the first pilot is not blocked on wiring one. */
      setDevLink(r.link || null);
    } catch (e) {
      setLinkErr(e.status === 0
        ? "Couldn't reach Dealtitude. Check your connection."
        : e.message);
    } finally { setLoading(false); }
  };

  /* The code road, for App Store review. Lands in exactly the same place as a
     clicked email link — adoptOwner — so a reviewer sees the real owner side,
     not a stripped-down version of it. */
  const signInWithCode = async (email, code) => {
    setLoading(true); setLinkErr(null);
    try {
      await API.signInWithCode(email, code);
      await adoptOwner();
      setSheet(null); setLinkSent(null);
    } catch (e) {
      setLinkErr(e.status === 404
        ? "Code sign-in isn't switched on for this server."
        : e.status === 0
        ? "Couldn't reach Dealtitude. Check your connection."
        : e.message);
    } finally { setLoading(false); }
  };

  /* Adopt an owner session: pull the shops they hold and let the existing role
     derivation do the rest, so nothing downstream has to know how they got in. */
  const adoptOwner = async () => {
    /* Take any invite written to this address first, so a shop added moments
       ago is already ours by the time we ask what we hold. */
    try { await API.claimInvites(); } catch { /* an older server has no route */ }
    const r = await API.myShops();
    const email = r.owner?.email || "";
    const shops = r.shops.map(toStore);
    setStores((prev) => {
      const next = [...prev];
      for (const s of shops) {
        const at = next.findIndex((x) => x.id === s.id);
        if (at === -1) next.push(s); else next[at] = { ...next[at], ...s };
      }
      return next;
    });
    setMembers(shops.map((s) => ({ storeId: s.id, email, role: "owner", acceptedBy: email })));
    setSession({ name: r.owner?.name || email.split("@")[0] || "Shop owner", email,
                 initial: (email[0] || "?").toUpperCase(), provider: "email" });
    if (shops.length) {
      setOwnerStoreId(shops[0].id);
      setView("owner"); setOTab("sales"); setScreen("app");
      shops.forEach((s) => { refreshReach(s.id); refreshDemand(s.id); });

      /* Load what this shop has already posted.
         Nothing fetched these, so an owner opening the app the next morning
         saw an empty "everything you've posted" while their sale was still
         running — no way to take it down, and every reason to post it twice. */
      shops.forEach(async (s) => {
        try {
          const r = await API.posts(s.id);
          const got = (r.posts || []).map((x) => toProduct({ ...x, slug: s.id }));
          setProducts((prev) => {
            const next = [...prev];
            for (const post of got) {
              const at = next.findIndex((y) => y.id === post.id);
              if (at === -1) next.push(post); else next[at] = { ...next[at], ...post };
            }
            return next;
          });
        } catch { /* a shop with nothing posted yet is not an error */ }
      });
    } else {
      /* Signed in, but no shop is attached to this address — which happens to
         the operator before the first shop exists, and to an owner whose shop
         was taken down. Doing nothing here left them on the ZIP screen with a
         "Shop Owner Login" button that looked like it had failed, and no way
         to tell a rejected sign-in from an accepted one. */
      setScreen("app");
      setNetErr(`Signed in as ${email}. No shop is attached to this address yet`
              + `${API.hasAdminKey() ? " — add one from Admin." : "."}`);
    }
    return shops;
  };

  /* The emailed link lands on /owner?token=… — verify it, then scrub the token
     out of the address bar so it can't be shared or sit in history. */
  useEffect(() => {
    if (!LIVE) return;
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;
    (async () => {
      try {
        const v = await API.verifyLink(token);
        await adoptOwner();
        setNetErr(v.claimed > 0
          ? `Signed in. ${v.claimed === 1 ? "Your shop is" : `${v.claimed} shops are`} ready.`
          : null);
      } catch (e) {
        setSheet("owner-signin");
        setLinkErr(e.message);
      } finally {
        try {
          window.history.replaceState({}, "",
            window.location.pathname + window.location.hash);
        } catch {}
      }
    })();
  }, []);

  /* A session from a previous visit — 60 days, so a shopkeeper signs in once
     and then just opens the app. An expired one simply falls through to the
     sign-in sheet next time they need it. */
  useEffect(() => {
    if (!LIVE || !API.signedInAsOwner()) return;
    if (new URLSearchParams(window.location.search).get("token")) return;  // that path wins
    adoptOwner().catch(() => {});
  }, []);
  const signInWith = (provider) => {
    if (provider === "google") { setSheet("accounts"); return; }
    completeSignIn({ ...ACCOUNTS[0], provider });
  };
  const completeSignIn = (acct) => {
    const s = { name: acct.name, email: acct.email, initial: acct.initial,
      provider: acct.provider || "google" };
    setSession(s);
    setSheet(null);

    const inv = invites.find((i) => i.email === acct.email && !i.accepted);
    const already = members.find((m) => m.email === acct.email);

    if (pending?.type === "follow") { doFollow(pending.storeId); setPending(null); }

    if (pending?.type === "accept" && inv) {
      setPending(null); acceptInvite(inv, acct.email); return;
    }
    if (inv) { setOpenInvite(inv); setScreen("invite"); return; }
    if (acct.email === ADMIN_EMAIL) { setView("admin"); setScreen("app"); return; }
    if (already) { setView("owner"); setScreen("app"); return; }
    setView("shopper");
    if (screen === "landing" && zip) setScreen("app");
  };
  const signOut = () => {
    /* Only the owner session goes. The device's follows stay — they belong to
       the phone, not to whoever was signed in, and silently unsubscribing a
       shopper because the owner signed out would be indefensible. */
    if (LIVE) { API.signOut(); setMembers([]); }
    setSession(null); setSheet(null); setView("shopper"); setScreen(zip ? "app" : "landing");
  };

  const acceptInvite = (inv, email) => {
    setInvites((is) => is.map((i) => i.id === inv.id
      ? { ...i, accepted: true, acceptedBy: email } : i));
    setMembers((ms) => [...ms, { storeId: inv.storeId, email, role: "owner",
      acceptedBy: email }]);
    logActivity("prefs", "Owner accepted the invitation",
      `${email} now manages ${storeOf(inv.storeId).name}`, inv.storeId);

    /* A chain owner gets one invite per location. Offer the next one straight
       away rather than making them dig out a second email. */
    const next = invites.find((i) => i.email === email && !i.accepted && i.id !== inv.id);
    if (next) { setOpenInvite(next); setScreen("invite"); return; }

    setOpenInvite(null); setOwnerStoreId(inv.storeId);
    setView("owner"); setOTab("sales"); setScreen("app");
  };

  const openInviteLink = (inv) => {
    setSession(null); setOpenInvite(inv); setScreen("invite");
  };

  /* ---- zip ---- */
  /* How far the shopper is willing to go. Theirs to choose, because "near me"
     means something different in Monroe Township than in Queens. */
  const [radius, setRadius] = useState(5);
  /* Followed shops outside the searched radius, as the SERVER measured them.
     Held separately so they can never be counted among the nearby ones. */
  const [farFollowed, setFarFollowed] = useState([]);

  /* The slugs the SERVER returned for the ZIP and radius showing right now.
     This is the whole of what "nearby" means.

     It used to be worked out by filtering the local shop list on a cached
     `miles` value. That value went stale the moment the ZIP changed: a shop
     found near 11367 kept its distance, so it stayed in the list under 08831
     and only vanished when the radius was touched, because changing the radius
     was the one path that cleared it. Identity from the server's own answer
     cannot go stale that way. */
  const [nearbyIds, setNearbyIds] = useState([]);

  /* One road for every search, so the ZIP box and the radius chips can never
     drift apart — two paths doing nearly the same thing is what let one of
     them forget to clear the last result. */
  const searchZip = async (z, r) => {
    if (!/^\d{5}$/.test(z)) { setZipErr("That doesn't look like a ZIP code."); return; }
    setLoading(true); setZipErr(null);
    try {
      const res = await API.shopsNear(z, r);
      const found = res.shops.map(toStore);
      const far = (res.followed_outside || []).map(toStore);

      /* Keep every shop we know about — a followed one must never vanish —
         but refresh each with what the server just said about it. */
      setStores((prev) => {
        const next = [...prev];
        for (const sh of [...found, ...far]) {
          const at = next.findIndex((x) => x.id === sh.id);
          if (at === -1) next.push(sh); else next[at] = { ...next[at], ...sh };
        }
        return next;
      });
      setNearbyIds(found.map((sh) => sh.id));
      setFarFollowed(far);
      setZipErr(found.length ? null
        : `No shops on Dealtitude within ${r} miles of ${z} yet.`);
      return found.length;
    } catch (e) {
      /* A failed search must not leave the last ZIP's shops on screen looking
         like results for this one. */
      setNearbyIds([]); setFarFollowed([]);
      setZipErr(e.status === 0
        ? "Couldn't reach Dealtitude. Check your connection and try again."
        : e.message);
      return 0;
    } finally { setLoading(false); }
  };

  const goZip = async () => {
    if (!LIVE) {
      if (!ZIPS[zip]) {
        setZipErr(`${zip} isn't covered by this prototype. Try 08831, 08820 or 08850.`);
        return;
      }
      setZipErr(null); setScreen("app"); setTab("stores");
      return;
    }
    await searchZip(zip, radius);
    setScreen("app"); setTab("stores");
  };

  /* Changing the radius re-asks with the same ZIP; changing the ZIP re-asks
     with the same radius. Same function either way. */
  const changeRadius = (r) => { setRadius(r); if (LIVE) searchZip(zip, r); };

  const zipStores = () => {
    if (LIVE) {
      const near = new Map(stores.map((s) => [s.id, s]));
      return nearbyIds.map((id) => near.get(id)).filter(Boolean);
    }
    /* Demo only. The coordinates here are an invented plane, so the mileage is
       invented too — it exists to make the walkthrough legible, and it is
       carried in its own field so it can never be mistaken for the server's
       measured distance. */
    const o = ZIPS[zip];
    if (!o) return [];
    return stores.map((s) => ({ ...s, _d: dist(o, s), _d_mi: dist(o, s) * MI_PER_UNIT }))
      .filter((s) => s._d <= RADIUS_UNITS).sort((a, b) => a._d - b._d);
  };

  const followedElsewhere = () => {
    if (!LIVE) return [];
    /* The server's own list of followed shops outside the radius, with the
       distance it measured. Anything followed that it did not mention is
       appended without one rather than dropped. */
    const inNearby = new Set(nearbyIds);
    const out = farFollowed.filter((s) => !inNearby.has(s.id));
    const named = new Set(out.map((s) => s.id));
    const rest = stores.filter((s) => follows[s.id] && !inNearby.has(s.id)
                                      && !named.has(s.id));
    return [...out, ...rest];
  };

  const nearestStores = () => {
    /* "Nearest anyway" is a walkthrough comfort. Live, an empty answer is the
       honest one — offering a shop 42 miles away as the nearest thing is what
       made a distant shop look local in the first place. */
    if (LIVE) return [];
    const o = ZIPS[zip];
    if (!o) return [];
    return stores.map((s) => ({ ...s, _d: dist(o, s), _d_mi: dist(o, s) * MI_PER_UNIT }))
      .sort((a, b) => a._d - b._d).slice(0, 2);
  };

  /* ---- follow ----
     Optimistic throughout. A tap on Follow has to land instantly — the shopper
     is standing at a counter looking at a printed card — so the screen moves
     first and the server catches up. If it refuses, the tap is rolled back and
     said so, rather than leaving a follow that only exists on this screen. */
  const doFollow = async (id) => {
    const before = follows[id];
    /* A new follower starts with every aisle OFF and opts in to what they
       want. Until they pick at least one, only shop-wide news — hours and
       announcements — reaches them. (null still means "all", for any follow
       created before this; [] genuinely means none.) */
    setFollows((f) => ({ ...f, [id]: { cats: [] } }));
    ownerPing(`New follower at ${storeOf(id).name}`,
      "A shopper nearby just followed your shop.", id);

    if (!LIVE) return;
    try {
      /* The follow comes first and never waits on notifications — a shopper who
         has declined them, or hasn't been asked yet, still gets the shop in
         their list. Switching alerts on later attaches to this same identity. */
      await API.ensureDevice();
      const r = await API.follow(id, []);
      setFollows((f) => ({ ...f, [id]: { cats: r.aisles || [], muted: r.muted } }));
      await API.shareWithWorker();
      setNetErr(null);

      /* Now get them reachable, by whichever route this phone allows.
       *
       * EVERYTHING BELOW IS BEST-EFFORT. The follow is already saved on the
       * server; notifications are an enhancement on top of it. An error here
       * used to fall through to the catch below and roll the follow back in
       * the UI — leaving the server following and the screen saying "Follow
       * this shop", which is the worst possible disagreement between the two
       * and reads as the app losing your follows. */
      try {
        await attachNotifications(id);
      } catch (e) {
        setLastFail("error");
      }
    } catch (e) {
      setFollows((f) => {
        const n = { ...f };
        if (before) n[id] = before; else delete n[id];
        return n;
      });
      setNetErr(`Couldn't follow ${storeOf(id)?.name || "that shop"} — ${e.message}`);
    }
  };

  /* How this particular phone comes to be reachable. Separated from doFollow
     so that failing here can never undo a follow that already succeeded. */
  const attachNotifications = async (id) => {
      const path = Install.pushPath();

      if (path === "native") {
        /* The real app. Ask the OS straight away — there is nothing to
           install and no home screen step to explain. */
        if (Install.permission() !== "denied") await enableNotifications();
      } else if (path === "install") {
        /* iPhone in Safari. Apple won't let us even ask until the app is on
           the home screen — so park a claim code in the address bar, which
           Add to Home Screen carries across, and show them how. */
        try {
          const { code } = await API.claimCode();
          Install.parkClaimCode(code);
        } catch { /* worst case they re-follow once installed */ }
        setInstallFor(id);
      } else if (path === "ready" && Install.permission() === "default") {
        /* Android, or an iPhone already installed: ask straight away. The tap
           on Follow is the user gesture that earns us the prompt. */
        await enableNotifications();
      }
  };
  const follow = (id) => {
    /* A shopper needs no account. In live mode the follow IS the sign-up, and
       asking for one here is the single biggest place a follower is lost. */
    if (!LIVE && !session) {
      askSignIn("Follow this shop and we'll tell you when something is on.",
        { type: "follow", storeId: id });
      return;
    }
    /* An age-restricted shop asks once, before the follow rather than after.
       The server refuses the follow outright if this is skipped, so the gate
       is the explanation rather than the enforcement. */
    const bar = storeOf(id)?.minAge;
    if (bar && ageCleared < bar) { setAgeFor(id); return; }
    doFollow(id);
  };
  const unfollow = async (id) => {
    const before = follows[id];
    setFollows((f) => { const n = { ...f }; delete n[id]; return n; });
    logActivity("unfollow", "A follower left", storeOf(id).name, id);
    if (!LIVE) return;
    try { await API.unfollow(id); setNetErr(null); }
    catch (e) {
      setFollows((f) => ({ ...f, [id]: before }));
      setNetErr(`Couldn't unfollow — ${e.message}`);
    }
  };
  const toggleCat = async (id, cat) => {
    const before = follows[id];
    const all = storeOf(id).cats;
    const base = before?.cats == null ? [...all] : [...before.cats];
    const next = base.includes(cat) ? base.filter((c) => c !== cat) : [...base, cat];

    setFollows((f) => ({ ...f, [id]: { ...f[id], cats: next } }));
    logActivity("prefs", "A follower changed what they want",
      next.length === 0 ? "Every aisle switched off — only shop-wide news now"
                        : "Still on: " + next.map(catName).join(", "), id);

    if (!LIVE) return;
    try {
      const r = await API.setAisles(id, next);
      setFollows((f) => ({ ...f, [id]: { ...f[id], cats: r.aisles || [] } }));
      setNetErr(null);
    } catch (e) {
      setFollows((f) => ({ ...f, [id]: before }));
      setNetErr(`That didn't save — ${e.message}`);
    }
  };
  /* ---- item asks ---- */

  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const loadWants = async (storeId) => {
    if (!LIVE) return;
    try { setWants((w) => ({ ...w, [storeId]: null }));
          const res = await API.wants(storeId);
          setWants((w) => ({ ...w, [storeId]: res })); }
    catch { setWants((w) => ({ ...w, [storeId]: { wants: [], suggest: [], mine: [] } })); }
  };

  /* Demo mode keeps its own copy in the same shape, so the screen is honest
     about what it would do without inventing a server. */
  const demoAsk = (storeId, label, aisle, drop) => {
    setWants((w) => {
      const cur = w[storeId] || { wants: [], suggest: [], mine: [] };
      const n = norm(label);
      const rows = [...cur.wants];
      const at = rows.findIndex((r) => r.norm === n);
      if (drop) {
        if (at >= 0) {
          const left = Number(rows[at].shoppers) - 1;
          if (left <= 0) rows.splice(at, 1); else rows[at] = { ...rows[at], shoppers: left };
        }
        return { ...w, [storeId]: { ...cur, wants: rows,
          mine: cur.mine.filter((m) => m.norm !== n) } };
      }
      if (at >= 0) rows[at] = { ...rows[at], shoppers: Number(rows[at].shoppers) + 1 };
      else rows.unshift({ norm: n, label, shoppers: 1, aisle: aisle || null });
      return { ...w, [storeId]: { ...cur,
        wants: rows.sort((x, y) => Number(y.shoppers) - Number(x.shoppers)),
        mine: [...cur.mine, { norm: n, label, aisle: aisle || null, alert: true }] } };
    });
  };

  const ask = async (storeId, label, aisle) => {
    if (!LIVE) {
      demoAsk(storeId, label, aisle, false);
      logActivity("prefs", "A shopper asked for an item", label, storeId);
      return;
    }
    try { await API.askFor(storeId, label, aisle); await loadWants(storeId);
          /* The server creates the follow if there isn't one — you cannot be
             told about the thing you asked for otherwise — so reflect that
             here rather than leaving the screen showing "Follow this shop"
             for someone who has just subscribed to an item in it. The aisle
             list stays empty on purpose: an ask adds to what someone chose
             and never quietly edits it. */
          setFollows((f) => f[storeId] ? f : { ...f, [storeId]: { cats: [] } });
          setNetErr(null); }
    catch (e) { setNetErr(e.status === 403
      ? "Confirm your age on this shop's page before asking for something."
      : `That didn't send — ${e.message}`); }
  };

  const unask = async (storeId, n) => {
    if (!LIVE) {
      const row = (wants[storeId]?.mine || []).find((m) => m.norm === n);
      if (row) demoAsk(storeId, row.label, null, true);
      return;
    }
    try { await API.unask(storeId, n); await loadWants(storeId); setNetErr(null); }
    catch (e) { setNetErr(`That didn't save — ${e.message}`); }
  };

  /* ---- broadcast ---- */
  function broadcast(product) {
    const store = storeOf(product.store);
    const decide = (reason, recipients) => {
      setDecision({ at: stamp(), store: store.name, product: product.name,
        cat: storeWide(product) ? kindOf(product).label : catName(product.cat),
        reason, recipients });
      return recipients;
    };
    if (broadcasts.find((b) => b.productId === product.id && Date.now() - b.at < 20000))
      return decide("duplicate", 0);

    const f = follows[product.store];
    let recipients = 0, why = null;
    if (!f) why = "nobody_follows";
    else {
      /* hours and announcements reach every follower; sales and arrivals
         respect the aisles that follower kept switched on */
      const subscribed = storeWide(product) ||
        f.cats === null || f.cats.includes(product.cat);
      const sentToday = inbox.filter((a) => a.store === product.store).length;
      if (!subscribed) {
        why = "category_off";
        setHeld((h) => [{ id: uid(), title: `${product.name} at ${store.name}`,
          why: `${catName(product.cat)} is switched off` }, ...h]);
        /* store-wide kinds never land here — they skip the aisle filter */
      } else if (sentToday >= store.cap) {
        why = "daily_cap";
        setHeld((h) => [{ id: uid(), title: `${product.name} at ${store.name}`,
          why: `Daily cap reached (${store.cap})` }, ...h]);
      } else {
        recipients = 1;
        const k = kindOf(product);
        const off = k.price ? pct(product.was, product.now) : null;
        const title = k.price
          ? `${product.name} — ${money(product.now)} at ${store.name}`
          : `${store.name}: ${product.name}`;
        const body = k.price
          ? (off ? `${off}% off, ends ${product.ends}.` : `On sale in ${catName(product.cat)}.`)
          : (product.note || `${k.verb} · ${product.ends}`);
        setInbox((i) => [{ id: uid(), store: product.store, title, body, at: "Just now" }, ...i]);
        ping(title, body, "deal-" + product.id);
        setPush({ title, body, kind: "shopper" });
      }
    }
    setBroadcasts((b) => [...b, { productId: product.id, at: Date.now() }]);
    return decide(why || "delivered", recipients);
  }

  /* Publishing.

     In demo mode `broadcast` simulates the fan-out on this device, which is
     what makes the counter demo convincing with no signal.

     In live mode the server does it, and its answer is the one the owner is
     shown — including who was held back and why. Reporting a locally guessed
     number next to real notifications would be the one lie that destroys the
     reach figure the whole $49 rests on. */
  const publish = async (p) => {
    if (!LIVE) {
      setProducts((ps) => [p, ...ps]);
      broadcast(p);
      setOTab("sales");
      return;
    }

    setLoading(true);
    try {
      const res = await API.publish(p.store, toPostBody(p));
      setProducts((ps) => [{ ...toProduct({ ...res.post, slug: p.store }) }, ...ps]);
      const { sent, held, followers, askedReached } = describeSend(res);

      /* "Nobody follows this shop yet" is a claim about the follower count, so
         it now comes from the follower count and nothing else. Inferring it
         from an empty `held` list is what put "Nobody follows this shop yet"
         on the screen of a shop with one follower — and, in the same breath,
         "Everyone who wanted this heard it." Both were true of the branch and
         neither was true of the shop. */
      const reason = sent > 0 ? "delivered"
                   : followers === 0 ? "nobody_follows"
                   : "all_held";
      setDecision({
        at: stamp(), store: storeOf(p.store)?.name, product: p.name,
        cat: storeWide(p) ? kindOf(p).label : catName(p.cat),
        reason, recipients: sent, held, followers, askedReached,
      });
      setPush({ title: sent > 0 ? (sent === 1 ? "Sent to 1 follower" : `Sent to ${sent} followers`)
                     : followers === 0 ? "No followers yet"
                     : "Nobody was alerted",
                /* Only claim everyone heard it when somebody did. */
                body: askedReached > 0
                       ? `Including ${askedReached} who asked for it.`
                       + (held.length ? ` Held back: ${held.join(", ")}.` : "")
                     : held.length ? `Held back: ${held.join(", ")}.`
                     : sent > 0 ? "Everyone who wanted this heard it."
                     : followers === 0 ? "The post is saved and waiting for the first follower."
                     : `${followers === 1 ? "The one follower" : `All ${followers} followers`} `
                       + `could not be reached.`,
                kind: "owner" });
      setNetErr(null);
      setOTab("sales");
      refreshReach(p.store);
      /* An answered ask drops off the demand list server-side, so re-read it
         rather than leaving the owner looking at a request he just filled. */
      refreshDemand(p.store);
      setPrefill(null);
    } catch (e) {
      /* A shop taken off the app leaves its owner signed in to something that
         no longer exists, and every post then fails with the server's own
         words — "no such shop" — which reads like the app is broken. Name what
         actually happened, and drop the dead shop so the screen isn't offering
         to post to it again. */
      const shopGone = e.status === 404 || /no such shop/i.test(e.message || "");
      if (shopGone) {
        const name = storeOf(p.store)?.name || "That shop";
        setStores((ss) => ss.filter((x) => x.id !== p.store));
        setNetErr(`${name} is no longer on the app, so there's nothing to post to. `
                + `Add it again from Admin and this will work.`);
      } else {
        setNetErr(e.status === 409 ? "That was just posted — check the list below."
                : e.status === 400 ? e.message
                : `Couldn't send that — ${e.message}`);
      }
    } finally { setLoading(false); }
  };

  /* The owner's reach panel, from the server. Held in a map so switching shops
     doesn't blank the number that was already on screen. */
  const refreshReach = async (slug) => {
    if (!LIVE || !slug) return;
    try {
      const r = toReach(await API.reach(slug));
      setLiveReach((m) => ({ ...m, [slug]: r }));
    } catch {}
  };

  /* Unmet demand for this shop. Fetched alongside reach, because the two
     answer the same question from opposite ends: who is listening, and what
     are they listening for. */
  const refreshDemand = async (slug) => {
    if (!LIVE || !slug) return;
    try {
      const r = await API.demand(slug);
      setDemand((m) => ({ ...m, [slug]: r.wants || [] }));
    } catch {}
  };

  /* Ending a sale has to reach the server, or the shelf says one thing and the
     app another — the fastest way to lose a shop's trust. */
  const expire = async (id) => {
    const p = products.find((x) => x.id === id);
    setProducts((ps) => ps.map((x) => (x.id === id ? { ...x, status: "expired" } : x)));
    if (!LIVE || !p) return;
    try { await API.endPost(p.store, id); setNetErr(null); }
    catch (e) {
      setProducts((ps) => ps.map((x) => (x.id === id ? { ...x, status: "active" } : x)));
      setNetErr(`Couldn't end that — ${e.message}`);
    }
  };

  /* ---- chrome ---- */
  const banner = push && (
    <div style={{ position: "absolute", top: 36, left: 10, right: 10, zIndex: 40,
      background: "rgba(255,255,255,.97)", borderRadius: 15, padding: "11px 13px",
      boxShadow: "0 10px 28px rgba(22,33,28,.3)",
      animation: "drop .34s cubic-bezier(.2,.9,.3,1.2)" }}>
      <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 5 }}>
        <div style={{ width: 17, height: 17, borderRadius: 5,
          background: push.kind === "owner" ? T.tag : T.leaf, display: "grid",
          placeItems: "center", color: push.kind === "owner" ? T.ink : "#fff",
          fontSize: 10, fontWeight: 800 }}>L</div>
        <span style={{ fontSize: 11, fontWeight: 800, color: T.mute }}>Dealtitude</span>
        <span style={{ fontSize: 11, color: T.mute, marginLeft: "auto" }}>now</span>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3 }}>{push.title}</div>
      <div style={{ fontSize: 12.5, color: T.mute, marginTop: 2 }}>{push.body}</div>
    </div>
  );

  /* When something doesn't reach the server, say so where it happened. A tap
     that silently did nothing is the failure that makes someone stop trusting
     the app — far worse than an honest line they can dismiss. */
  const netBanner = netErr && (
    <div onClick={() => setNetErr(null)} style={{ position: "absolute", top: 36, left: 10,
      right: 10, zIndex: 41, background: T.ink, color: "#fff", borderRadius: 13,
      padding: "10px 13px", cursor: "pointer", display: "flex", gap: 10,
      alignItems: "flex-start", boxShadow: "0 10px 28px rgba(22,33,28,.3)",
      animation: "drop .3s cubic-bezier(.2,.9,.3,1.2)" }}>
      <span style={{ fontSize: 13, flex: 1, lineHeight: 1.4, fontWeight: 600 }}>{netErr}</span>
      <span style={{ fontSize: 15, color: "rgba(255,255,255,.55)", lineHeight: 1 }}>×</span>
    </div>
  );
  /* A real notification outranks an error line; the error waits its turn. */
  const topBanner = push ? banner : netBanner;

  /* The iPhone step. Shown over whatever screen they're on, because it follows
     a tap on Follow and should feel like part of that, not a new place. */
  const installSheet = installFor ? (
    <AddToHomeScreen store={storeOf(installFor)} bottomBar={!Install.isIPad()}
      onClose={() => setInstallFor(null)} />
  ) : null;

  /* The age gate, shown the same way and for the same reason: it follows a tap
     on Follow and belongs to that moment, not to a screen of its own. */
  const ageSheet = ageFor ? (
    <AgeGate
      store={storeOf(ageFor)}
      minAge={storeOf(ageFor)?.minAge || 21}
      onClose={() => setAgeFor(null)}
      onPass={async (bar) => {
        try {
          if (LIVE) await API.confirmAge(bar);
          setAgeCleared((v) => Math.max(v, bar));
          const id = ageFor;
          setAgeFor(null);
          doFollow(id);
        } catch (e) {
          setAgeFor(null);
          setNetErr(`Couldn't confirm that — ${e.message}`);
        }
      }} />
  ) : null;

  const authSheet =
    sheet === "owner-signin" ? (
      <OwnerSignIn onSend={sendOwnerLink} onCode={signInWithCode}
        sent={linkSent} busy={loading} err={linkErr} devLink={devLink}
        onClose={() => { setSheet(null); setLinkSent(null); setLinkErr(null); }} />
    ) : sheet === "providers" || sheet === "accounts" ? (
      <SignInSheet step={sheet} reason={authReason}
        onProvider={signInWith} onPick={completeSignIn}
        onClose={() => { setSheet(null); setPending(null); }} />
    ) : sheet === "account" && session ? (
      <AccountSheet session={session} roles={roles} onSignOut={signOut}
        onClose={() => setSheet(null)} />
    ) : null;

  /* ---- screens ---- */
  if (screen === "join" && joinStore) {
    const js = storeOf(joinStore);
    return (
      <Shell>
        <Phone banner={topBanner} sheet={ageSheet || installSheet || authSheet}>
          <JoinScreen store={js} products={products} followed={!!follows[js.id]}
            session={session} onFollow={() => follow(js.id)}
            onBrowse={() => {
              setOpenStore(js.id); setZip(zip || js.zip || "");
              setScreen("app"); setTab("stores"); setJoinStore(null);
            }} />
        </Phone>
      </Shell>
    );
  }

  if (screen === "landing") {
    return (
      <Shell>
        <Phone banner={topBanner} sheet={ageSheet || installSheet || authSheet}>
          <Landing zip={zip} setZip={setZip} onGo={goZip} err={zipErr}
            signedInAs={session?.email || null}
            onSignIn={session
              ? () => { setView(isOwner ? "owner" : "shopper"); setScreen("app"); }
              : () => askSignIn("Signing in brings back the shops you follow.")} />
        </Phone>
      </Shell>
    );
  }

  /* Shown over whatever screen you are on: if mail failed, the link is the
     only thing standing between this shop and a working owner, so it does not
     wait politely at the bottom of a list. */
  if (ownerLink) {
    return (
      <Shell>
        <Phone>
          <div style={{ flex: 1, padding: "22px 20px", overflowY: "auto",
            background: T.dim }}>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.02em" }}>
              {ownerLink.name} is live</div>
            <div style={{ fontSize: 13.5, color: T.mute, margin: "8px 0 18px",
              lineHeight: 1.5 }}>
              The email to {ownerLink.email} didn't send, so hand them this link
              instead. It opens their shop and works once they're on it.</div>
            <div style={{ background: T.card, border: `1px solid ${T.line}`,
              borderRadius: 11, padding: 13, fontSize: 12, wordBreak: "break-all",
              color: T.leaf, lineHeight: 1.5 }}>{ownerLink.link}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <Btn kind="ghost" onClick={async () => {
                try { await navigator.clipboard.writeText(ownerLink.link);
                      setNetErr("Link copied."); }
                catch { setNetErr("Couldn't copy — read it out or screenshot it."); }
              }}>Copy the link</Btn>
              <Btn onClick={async () => {
                /* Texting it is how this actually happens at a counter. */
                try {
                  if (navigator.share) {
                    await navigator.share({ title: `${ownerLink.name} on Dealtitude`,
                      text: `Open your shop: ${ownerLink.link}` });
                  } else { window.location.href =
                    `sms:?&body=${encodeURIComponent(`Open your shop: ${ownerLink.link}`)}`; }
                } catch { /* they closed the share sheet */ }
              }}>Send it to them</Btn>
            </div>
            <div style={{ marginTop: 16 }}>
              <Btn kind="ghost" full onClick={() => setOwnerLink(null)}>Done</Btn>
            </div>
            <div style={{ fontSize: 11.5, color: T.mute, marginTop: 18,
              lineHeight: 1.5 }}>
              To stop this happening, set RESEND_API_KEY and MAIL_FROM on the
              server. Health will then show mail as on.</div>
          </div>
        </Phone>
      </Shell>
    );
  }

  if (screen === "invite" && openInvite) {
    return (
      <Shell>
        <Phone banner={topBanner} sheet={ageSheet || installSheet || authSheet}>
          <InviteLanding invite={openInvite} store={storeOf(openInvite.storeId)}
            onAccept={() => {
              if (!session) {
                askSignIn("Sign in to take over this shop's page.",
                  { type: "accept", inviteId: openInvite.id });
              } else { acceptInvite(openInvite, session.email); }
            }}
            onDecline={() => { setOpenInvite(null); setScreen(zip ? "app" : "landing"); }} />
        </Phone>
      </Shell>
    );
  }

  const shopperBody = () => {
    if (openStore) {
      const s = storeOf(openStore);
      return <StoreScreen store={s} products={products} follow={follows[s.id]}
        followers={followerCount(s.id)} onFollow={() => follow(s.id)}
        onUnfollow={() => unfollow(s.id)} onToggleCat={(c) => toggleCat(s.id, c)}
        onBack={() => setOpenStore(null)} wants={wants[s.id]}
        onAsk={(label, aisle) => ask(s.id, label, aisle)}
        onUnask={(n) => unask(s.id, n)} />;
    }
    if (tab === "stores") return <StoreList zip={zip} stores={zipStores()}
      products={products} nearest={nearestStores()} onOpen={setOpenStore}
      follows={follows} notified={zipWaitlist.includes(zip)}
      radius={radius}
      /* Live only: in the walkthrough the radius is part of the invented
         geography and there is nothing honest to vary. */
      onRadius={LIVE ? changeRadius : undefined}
      followedElsewhere={followedElsewhere()}
      onChangeZip={() => setScreen("landing")}
      onNotifyMe={() => {
        if (!session) { askSignIn("We'll email you when a shop near you joins."); return; }
        setWaitlist((w) => [...w, zip]);
      }} />;
    if (tab === "deals") return <FeedScreen products={products} follows={follows}
      onOpen={setOpenStore} storeName={(id) => storeOf(id)?.name || ""}
      onSaid={setNetErr} />;
    return <AlertsScreen inbox={inbox} held={held} notif={notifProps} decision={decision} />;
  };

  const ownerBody = () => {
    /* No shop attached to this account is a real state, not an error: the
       operator before their first shop exists, and an owner whose shop was
       taken down. Reaching for the walkthrough's "s1" here meant live mode
       either rendered an invented shop or, once the invented shops were gone,
       rendered nothing at all with no explanation. */
    const s = ownerStore || (LIVE ? null : storeOf("s1"));
    if (!s) {
      return (
        <>
          <Head title="My shop" sub="Nothing assigned to this account yet" />
          <Scroll>
            <div style={{ background: T.card, border: `1px solid ${T.line}`,
              borderRadius: 12, padding: 18, textAlign: "center" }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>🏪</div>
              <div style={{ fontSize: 16, fontWeight: 800 }}>No shop yet</div>
              <div style={{ fontSize: 13, color: T.mute, margin: "7px 0 0",
                lineHeight: 1.5 }}>
                You're signed in{session?.email ? ` as ${session.email}` : ""}, but no
                shop is attached to this address. A shop becomes yours when whoever
                set it up invites this address — ask them to, or add it yourself
                from Admin if you have the operator key.
              </div>
            </div>
          </Scroll>
        </>
      );
    }
    if (oTab === "new") return <OwnerNew store={s} actingAs={null}
      catalog={catalog[s.id] || {}} lookup={LIVE ? gtinLookup(s.id) : null}
      onLearn={learnItem} prefill={prefill}
      onCancel={() => { setPrefill(null); setOTab("sales"); }} onPublish={publish} />;
    if (oTab === "activity") return <OwnerActivity store={s}
      activity={activity.filter((a) => !a.store || a.store === s.id)}
      followers={followerCount(s.id)} demand={demand[s.id]} reach={reachOf(s.id)}
      onPostFor={(name, aisle, shoppers) => {
        setPrefill({ name, aisle, shoppers }); setOTab("new"); }}
      onSimulate={LIVE ? undefined : () => {
        /* No name here, and there never will be. A shopper gives no email, no
           phone and no account, so the shop learns a count and a set of aisles
           and nothing else. The demo has to say exactly that — showing an
           invented name would promise an owner something the product refuses
           to do, and he'd find out after he'd paid. */
        const cats = s.cats.filter(() => Math.random() > 0.45);
        setExtra((n) => n + 1);
        ownerPing(`New follower at ${s.name}`,
          cats.length === 0
            ? "Shop-wide news only for now"
            : `Wants ${cats.map(catName).join(", ")} · no name, no email`, s.id);
      }} notif={notifProps} />;
    if (oTab === "settings") return <OwnerSettings store={s} notif={notifProps}
      actingAs={ACTING_AS} onRevoke={() => {}}
      shops={myShopList} subs={subs} price={PRICE}
      onChange={(patch) => setStores((ss) => ss.map((x) => x.id === s.id ? { ...x, ...patch } : x))} />;
    return <OwnerSales store={s} products={products} followers={followerCount(s.id)}
      onExpire={expire} onNew={() => setOTab("new")} decision={decision}
      onSaid={setNetErr}
      sentToday={inbox.filter((a) => a.store === s.id).length} />;
  };

  /* ---------------------------------------------------------------- admin --
     Creating a shop on the spot, standing in it. */
  const saveAdminKey = async (key) => {
    setLoading(true); setAdminErr(null);
    API.setAdminKey(key);
    try {
      /* Checked now, not when you are standing at a counter having typed in
         a shop's whole details. */
      if (await API.checkAdminKey()) { setAdminKeyOk(true); setAdminErr(null); }
      else {
        API.setAdminKey(null);
        /* A server with no ADMIN_KEY set refuses every key, which is
           indistinguishable from a wrong one — so ask the server which case
           this is instead of blaming what was typed. */
        const set = await API.adminKeyConfigured().catch(() => null);
        setAdminErr(set === false
          ? "This server has no operator key set. Add ADMIN_KEY in its settings, "
            + "wait for it to restart, then try again."
          : "That key isn't right for this server.");
      }
    } catch (e) {
      API.setAdminKey(null);
      setAdminErr(e.status === 0 ? "Couldn't reach the server." : e.message);
    } finally { setLoading(false); }
  };

  const removeShopLive = async (slug) => {
    const name = storeOf(slug)?.name || slug;
    setLoading(true); setAdminErr(null);
    try {
      await API.removeShop(slug);
      setStores((ss) => ss.filter((x) => x.id !== slug));
      setFollows((f) => { const n = { ...f }; delete n[slug]; return n; });
      setNetErr(`${name} is off the app. Its history is kept.`);
    } catch (e) {
      setAdminErr(e.status === 403 ? "That operator key was refused."
        : e.status === 0 ? "Couldn't reach the server." : e.message);
    } finally { setLoading(false); }
  };

  const resetLive = async () => {
    setLoading(true); setAdminErr(null);
    try {
      await API.resetEverything();
      /* Everything the screen was showing is gone, including whatever shop
         this session was signed in to, so clear it here rather than letting
         the next tap fail against rows that no longer exist. */
      setStores([]); setProducts([]); setInvites([]); setMembers([]);
      setFollows({});
      setNetErr("Everything is cleared. Add your first shop from Add shop.");
      setATab("new");
    } catch (e) {
      setAdminErr(e.status === 404
        ? "This server has start-fresh switched off. Set ALLOW_RESET to true in "
          + "its settings, wait for it to restart, then try again."
        : e.status === 403 ? "That operator key was refused."
        : e.status === 0 ? "Couldn't reach the server." : e.message);
    } finally { setLoading(false); }
  };

  const createShopLive = async (shop) => {
    setLoading(true); setAdminErr(null);
    const { email, ...body } = shop;
    try {
      const r = await API.createShop(body);
      /* It may have been put back rather than created — a shop taken off the
         app keeps its name, so re-adding it restores it. Worth saying, because
         its old followers and posts come back too. */
      const restored = r?.restored === true;
      /* Invite in the same breath. A shop that exists with no owner is a visit
         you have to make twice. */
      /* Whether the owner was actually EMAILED, not merely recorded. Saying
         "they can sign in" when nothing was sent is how a shop visit ends with
         the owner locked out and nobody aware of it. */
      let invited = false, mailed = false, handLink = null;
      if (email) {
        try {
          const inv = await API.inviteOwner(body.slug, email);
          invited = true;
          mailed = inv?.mail?.sent === true;
          handLink = inv?.link || null;
        } catch (e) {
          setNetErr(`${body.name} is live, but the invite to ${email} failed — ${e.message}`);
        }
      }
      setStores((ss) => [...ss.filter((x) => x.id !== body.slug),
                         toStore({ ...r.shop, aisles: body.aisles, followers: 0 })]);
      setATab("stores");

      /* If the shop was invited to the address this session is signed in as —
         which is what happens when you sign up your own first shop — take
         ownership now. Otherwise My Shop sits empty and the only cure is
         signing out and back in, which nothing on screen tells you. */
      let mine = false;
      if (invited) {
        try {
          const c = await API.claimInvites();
          mine = (c?.claimed || 0) > 0;
        } catch { /* not fatal: signing in again still works */ }
      }

      if (handLink) setOwnerLink({ name: body.name, email, link: handLink });

      setNetErr(restored && mine
        ? `${body.name} is back on the app and yours — its followers and history came with it.`
        : restored
        ? `${body.name} is back on the app, with the details you just entered.`
        : mine
        ? `${body.name} is live and yours — it's in My Shop now.`
        : invited && mailed
        ? `${body.name} is live. ${email} has been emailed a link to it.`
        : invited
        ? `${body.name} is live, but the email didn't send. Pass the owner the link below.`
        : email ? null : `${body.name} is live. Invite the owner when you have their email.`);
    } catch (e) {
      setAdminErr(e.status === 409 || /already on the app|duplicate|already exists/i.test(e.message || "")
        ? "That shop is already on the app — look for it in the Shops list rather "
          + "than adding it again."
        : e.status === 403 ? "That operator key was refused. Check it in Settings."
        : e.status === 0 ? "Couldn't reach the server. Check your connection."
        : e.message);
    } finally { setLoading(false); }
  };

  const adminBody = () => {
    /* Nothing can be created without the operator key, so ask for it before
       the form rather than after a shop has been typed in at a counter. */
    if (LIVE && !adminKeyOk) return <AdminKeyScreen
      onSave={saveAdminKey} busy={loading} error={adminErr} />;

    if (aTab === "new") return <AdminNewStore onCancel={() => setATab("stores")}
      busy={loading} error={adminErr}
      onCreate={LIVE ? createShopLive
                     : (s) => { setStores((ss) => [...ss, s]); setATab("stores"); }} />;
    return <AdminStores stores={stores} invites={invites} members={members}
      products={products} follows={follows} onNew={() => setATab("new")}
      onRemove={LIVE ? removeShopLive : undefined}
      onReset={LIVE && canReset ? resetLive : undefined}
      subs={subs} price={PRICE}
      onInvite={(storeId, email) =>
        setInvites((is) => [...is, { id: uid(), storeId, email, accepted: false }])}
      onOpenLink={openInviteLink} />;
  };

  const tabsFor = {
    shopper: [
      { id: "stores", label: "Shops", icon: "🏪" },
      { id: "deals", label: "Latest", icon: "🏷" },
      { id: "alerts", label: "Alerts", icon: "🔔", badge: inbox.length },
    ],
    owner: [
      { id: "sales", label: "Sales", icon: "🏷" },
      { id: "new", label: "Add", icon: "＋" },
      { id: "activity", label: "Activity", icon: "👥", badge: activity.length },
      { id: "settings", label: "Settings", icon: "⚙" },
    ],
    admin: [
      { id: "stores", label: "Shops", icon: "🏪" },
      { id: "new", label: "Add shop", icon: "＋" },
    ],
  };

  const followCount = Object.keys(follows).length;

  return (
    <Shell>
      <Phone banner={topBanner} sheet={ageSheet || installSheet || authSheet}>
        {/* identity bar — view switcher only where the person genuinely holds
            more than one role. Never a way to claim one. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px 8px",
          background: T.dim, flexShrink: 0 }}>
          {availableViews.length > 1 ? (
            <div style={{ display: "flex", gap: 4, background: T.card, borderRadius: 9,
              padding: 3, border: `1px solid ${T.line}`, flex: 1 }}>
              {availableViews.map(([id, label]) => (
                <button key={id} onClick={() => setView(id)} style={{ flex: 1, border: "none",
                  borderRadius: 7, padding: "6px 4px", cursor: "pointer", fontFamily: FONT,
                  fontSize: 12, fontWeight: 700, background: view === id ? T.ink : "transparent",
                  color: view === id ? "#fff" : T.mute }}>{label}</button>
              ))}
            </div>
          ) : (
            <div style={{ flex: 1, fontSize: 12, fontWeight: 700, color: T.mute }}>
              {session ? session.name : !LIVE ? "Browsing as a guest" : ""}</div>
          )}
          {/* A signed-out shopper has no account and never will, so a circle
              offering one is a door to nowhere. It appears only for someone who
              is actually signed in and has something behind it. */}
          {session && <Avatar session={session} onClick={() => setSheet("account")} />}
        </div>

        {view === "owner" && (
          <ShopSwitch shops={myShopList} current={ownerStore?.id}
            onPick={(id) => { setOwnerStoreId(id); setOTab("sales"); }} />
        )}

        {view === "shopper" ? shopperBody() : view === "owner" ? ownerBody() : adminBody()}

        <TabBar tabs={tabsFor[view]}
          active={view === "shopper" ? (openStore ? "stores" : tab)
                : view === "owner" ? oTab : aTab}
          onChange={(t) => {
            if (view === "shopper") { setOpenStore(null); setTab(t); }
            else if (view === "owner") setOTab(t);
            else setATab(t);
          }} />
      </Phone>
    </Shell>
  );
}

function Shell({ children }) {
  const framed = useFramed();
  /* Unframed — native, installed, or simply a phone-sized screen — Phone fills
     the viewport and owns the safe-area insets, so the centring wrapper would
     only add dead margin around the edges. */
  if (NATIVE || !framed) {
    return <div style={{ fontFamily: FONT, color: T.ink }}>{children}</div>;
  }
  return (
    <div style={{ fontFamily: FONT, background: T.floor, minHeight: "100vh", color: T.ink,
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "max(12px, env(safe-area-inset-top)) 12px max(16px, env(safe-area-inset-bottom))" }}>
      {children}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
