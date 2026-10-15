/* ---------------------------------------------------------------------------
 * Translating between the server's shapes and the app's.
 *
 * The screens were written against the prototype's own objects, and they are
 * the part that has been looked at on a phone and shown to shop owners. So the
 * server bends to them here rather than the other way round — one small file
 * to check instead of a rewrite of every screen.
 *
 * Money crosses the wire as integer cents, which is also how the app holds it.
 * No conversion, and no floats anywhere near a price.
 * ------------------------------------------------------------------------- */

/* The map is an abstract 0–100 plane. Real shops arrive with coordinates, so
   put them where they actually are, scaled to a box around Middlesex County. */
const BOX = { lat0: 40.28, lat1: 40.64, lon0: -74.54, lon1: -74.18 };
const clamp = (n) => Math.max(6, Math.min(94, n));

/* A shop with no coordinates yet still needs a spot, and the same spot every
   time the list loads — otherwise markers jump around between refreshes. */
const scatter = (slug) => {
  let h = 2166136261;
  for (const ch of slug) { h ^= ch.charCodeAt(0); h = (h * 16777619) >>> 0; }
  return { x: 20 + (h % 61), y: 20 + ((h >>> 8) % 61) };
};

export function toStore(s) {
  const placed = s.lat != null && s.lon != null;
  const pos = placed
    ? { x: clamp(((s.lon - BOX.lon0) / (BOX.lon1 - BOX.lon0)) * 100),
        y: clamp(100 - ((s.lat - BOX.lat0) / (BOX.lat1 - BOX.lat0)) * 100) }
    : scatter(s.slug);

  return {
    id: s.slug,
    name: s.name,
    addr: s.address,
    town: s.town,
    zip: s.zip,
    hours: s.hours || "",
    ...pos,
    cats: s.aisles || [],
    broadcast: true,
    cap: s.daily_cap ?? 3,
    /* 21 for a liquor shop, null for everyone else. Carried through so the
       app knows to put the gate up before the shop's alerts are offered. */
    minAge: s.min_age ?? null,
    baseFollowers: Number(s.followers ?? 0),
    /* The server's distance in miles, or null when it could not be worked out.
       NEVER computed here: the app used to derive one from invented
       coordinates, which is how a shop 42 miles away was shown as nearby. */
    miles: s.miles == null ? null : Number(s.miles),
  };
}

/** A server post as the feed and the owner's list want it. */
export function toProduct(p) {
  return {
    id: p.id,
    kind: p.kind,
    store: p.slug,
    cat: p.aisle || undefined,
    name: p.name,
    note: p.note || undefined,
    was: p.was_cents ?? undefined,
    now: p.now_cents ?? undefined,
    ends: p.ends || "",
    status: p.status || "active",
    gtin: p.gtin || undefined,
    at: p.created_at,
  };
}

/** /v1/me/follows -> the { [slug]: { cats } } map the screens read. */
export function toFollows(rows = []) {
  const out = {};
  for (const f of rows) out[f.slug] = { cats: f.aisles || [], muted: f.muted };
  return out;
}

/** A composed post as the publish endpoint wants it. */
export function toPostBody(p) {
  const wide = p.kind === "hours" || p.kind === "notice";
  return {
    kind: p.kind,
    aisle: wide ? undefined : p.cat,
    name: p.name,
    note: p.note || undefined,
    gtin: p.gtin || undefined,
    was_cents: p.was ?? undefined,
    now_cents: p.now ?? undefined,
    ends: p.ends || undefined,
  };
}

/** The server's reach row in the shape the owner panel renders. */
export function toReach(r) {
  return {
    total: Number(r.total || 0),
    muted: Number(r.muted || 0),
    noPush: Number(r.no_push || 0),
    reachable: Number(r.reachable || 0),
    newThisWeek: Number(r.new_this_week || 0),
    aisles: (r.aisles || []).map((a) => ({ aisle: a.aisle, wanted: Number(a.wanted || 0) })),
  };
}

/* What the owner is told after publishing. The server already decided; this
   only puts its answer into words, and never rounds a withheld follower away —
   "held back" is the number that keeps the reach figure honest. */
export function describeSend(res) {
  const held = res.withheld || {};
  const reasons = {
    /* Each reads as a noun phrase, because it is printed after a count:
       "Held back: 2 with alerts switched off, 1 muting this shop." */
    aisle_off:      "without this aisle picked",
    daily_cap:      "at today's limit already",
    muted:          "muting this shop",
    no_device:      "with alerts switched off",
    age_unverified: "with their age not confirmed",
    /* These three are not the follower's doing, and the wording has to keep
       that distinction — a shopkeeper who reads "their phone can't receive
       alerts" goes and bothers a customer about a problem on our side. */
    push_unconfigured: "unreachable — this app's alert keys aren't set up yet",
    send_failed:       "refused by the alert service",
    gone:              "no longer using the app",
  };
  const parts = Object.entries(held)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${reasons[k] || k}`);

  /* followers is the server's count of follow rows considered for this post —
     the only honest answer to "does anyone follow this shop?". Older servers
     don't send it; fall back to what can be derived rather than to zero,
     because zero is the one answer that produces a false "nobody follows". */
  const counted = Object.values(held).reduce((a, n) => a + n, 0);
  const sent = res.sent || 0;
  return {
    sent,
    held: parts,
    followers: Number.isFinite(res.followers) ? res.followers : sent + counted,
    eligible: Number.isFinite(res.eligible) ? res.eligible : sent,
    /* How many of the people reached had asked for this exact item. The whole
       argument for item asks is that this number is not zero. */
    askedFor: res.asked_for || 0,
    askedReached: res.asked_reached || 0,
  };
}
