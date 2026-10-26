/* ---------------------------------------------------------------------------
 * Where a ZIP code actually is, and how far apart two of them are.
 *
 * This replaces an invented coordinate system: six hardcoded ZIPs with made-up
 * x/y values on an "abstract plane", and a multiplier that turned those units
 * into a number that read like miles. It was never real, and under a ZIP it
 * had never heard of it produced whatever came out — which is how a shop in
 * 08831 was shown as "within five miles" of 11367, 42 miles away.
 *
 * us-zips is the 2022 Census ZCTA centroid set: 33,791 ZIPs, offline, no API
 * key and no network call on the hot path. A centroid is not a street address,
 * so a distance here is accurate to a mile or so — which is the right
 * precision for "shops near me" and is stated as such rather than implied to
 * be more.
 * ------------------------------------------------------------------------- */
import zips from "us-zips";

/**
 * A ZIP as it should be stored and looked up: five digits, nothing else.
 *
 * Takes what people and spreadsheets actually produce — " 08831 ",
 * "08831-1234", and the four-digit "8831" that comes out of anything which
 * treated a ZIP as a number and dropped its leading zero. Returns null for
 * anything that is not a ZIP at all.
 */
export function normalizeZip(zip) {
  const raw = String(zip ?? "").trim();
  if (!raw) return null;
  const digits = raw.split("-")[0].replace(/\D/g, "");   // ZIP+4 → ZIP
  if (digits.length === 5) return digits;
  /* A leading zero lost on the way through a number. 4 digits is the only
     length where padding is unambiguous: anything shorter is a typo, not a
     ZIP with zeros knocked off. */
  if (digits.length === 4) return "0" + digits;
  return null;
}

/* Which real ZIPs sit under each 4- and 3-digit prefix. Built on the first
   miss rather than at boot, because most lookups never need it. */
let byPrefix = null;
const prefixes = () => {
  if (byPrefix) return byPrefix;
  byPrefix = new Map();
  for (const z of Object.keys(zips)) {
    for (const len of [4, 3]) {
      const k = z.slice(0, len);
      const arr = byPrefix.get(k);
      if (arr) arr.push(z); else byPrefix.set(k, [z]);
    }
  }
  return byPrefix;
};

/* The nearest real ZIP to one the Census has no area for.
 *
 * ZIPs are handed out in geographic order, so the numerically closest ZIP
 * sharing a 4-digit prefix is next door; a 3-digit prefix is the same sorting
 * district. 80001 resolves to 80002, which is the next street over in Arvada.
 * That is the right answer for "shops near me" and vastly better than the
 * honest-sounding refusal it replaces. */
const nearestReal = (z) => {
  const idx = prefixes();
  const n = Number(z);
  for (const len of [4, 3]) {
    const list = idx.get(z.slice(0, len));
    if (!list || list.length === 0) continue;
    let best = null, gap = Infinity;
    for (const cand of list) {
      const d = Math.abs(Number(cand) - n);
      if (d < gap) { gap = d; best = cand; }
    }
    if (best) return best;
  }
  return null;
};

/**
 * { lat, lon } for a ZIP, or null if it is not a ZIP at all.
 *
 * us-zips holds Census ZCTAs, and a ZCTA only exists where people live. A ZIP
 * serving nothing but PO boxes or a single large building — 80001 in Arvada,
 * and a few hundred others — has no entry, so this used to return null for a
 * perfectly real ZIP somebody had their shop in. The shop was then created
 * with no coordinates and could never be found by ZIP again, while a search
 * for that ZIP answered "not one we can place on a map". Both were true
 * statements about the dataset and useless to the person holding the phone.
 *
 * `exact` says which happened, for anything that wants to be straight about
 * the precision. Nothing is required to look.
 */
export function zipPoint(zip) {
  const z = normalizeZip(zip);
  if (!z) return null;
  const hit = zips[z];
  if (hit) return { lat: hit.latitude, lon: hit.longitude, zip: z, exact: true };

  const near = nearestReal(z);
  if (!near) return null;
  const at = zips[near];
  return { lat: at.latitude, lon: at.longitude, zip: z, exact: false, placedFrom: near };
}

const R_MILES = 3958.7613;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle miles between two { lat, lon } points. */
export function milesBetween(a, b) {
  if (!a || !b || a.lat == null || a.lon == null || b.lat == null || b.lon == null) {
    return null;          // unknown, NOT zero — zero reads as "right here"
  }
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(h));
}

/** Is this ZIP one we can place on a map at all? */
export const knownZip = (zip) => zipPoint(zip) !== null;
