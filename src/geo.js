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

/** { lat, lon } for a 5-digit ZIP, or null if it is not a real one. */
export function zipPoint(zip) {
  const z = String(zip || "").trim();
  if (!/^\d{5}$/.test(z)) return null;
  const hit = zips[z];
  return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
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
