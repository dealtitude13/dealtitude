/* ---------------------------------------------------------------------------
 * Putting an announcement on the shop's own social accounts.
 *
 * The four platforms do NOT offer the same thing, and pretending they do would
 * mean shipping buttons that quietly do nothing:
 *
 *   WhatsApp  takes the whole message as text. Works properly.
 *   X         takes text plus a link. Works properly.
 *   Facebook  takes a LINK ONLY. It ignores any text you try to prefill and
 *             builds the post from the linked page's own preview tags, so what
 *             the shopkeeper sees is whatever the shop page says about itself.
 *   Instagram has no web share at all. You cannot open Instagram with a post
 *             ready to publish from a link — there is no such address. The only
 *             route is the phone's own share sheet, which offers Instagram when
 *             it is installed.
 *
 * So Instagram goes through the share sheet, and the others go direct. The
 * sheet is offered on its own too, because it reaches everything else a
 * shopkeeper uses — Messages, Signal, their own notes.
 * ------------------------------------------------------------------------- */

/** Where a shop lives on the web. Falls back to the bare slug if unset. */
export function shopUrl(slug, base) {
  const root = (base || "https://dealtitude.com").replace(/\/+$/, "");
  return `${root}/${slug}`;
}

/** The announcement as a sentence a person would actually send. */
export function shareText(post, shopName) {
  const money = (c) => (c == null ? null : `$${(c / 100).toFixed(2)}`);
  const bits = [];
  if (post.kind === "sale" && post.now != null) {
    bits.push(`${post.name} — ${money(post.now)}${
      post.was != null && post.was > post.now ? ` (was ${money(post.was)})` : ""} at ${shopName}`);
  } else if (post.kind === "arrival") {
    bits.push(`Just in at ${shopName}: ${post.name}`);
  } else {
    bits.push(`${shopName}: ${post.name}`);
  }
  if (post.note) bits.push(post.note);
  if (post.ends) bits.push(post.kind === "sale" ? `Ends ${post.ends}.` : String(post.ends));
  return bits.join("\n");
}

/**
 * Addresses for the platforms that have one. Instagram is deliberately absent:
 * it has no such address, and a button pointing at instagram.com would open the
 * app with nothing in it.
 */
export function shareTargets(post, shopName, slug, base) {
  const url = shopUrl(slug, base);
  const text = shareText(post, shopName);
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`,
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`
     + `&url=${encodeURIComponent(url)}`,
    /* Link only. Facebook discards prefilled text. */
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    url, text,
  };
}

/** True when this device can offer its own share sheet (and so Instagram). */
export function canUseSheet() {
  try { return typeof navigator !== "undefined" && typeof navigator.share === "function"; }
  catch { return false; }
}

/**
 * Open the phone's share sheet. Returns "shared", "cancelled", or "unavailable"
 * so the caller can say something true rather than assume it worked.
 */
export async function openSheet(post, shopName, slug, base) {
  if (!canUseSheet()) return "unavailable";
  const { url, text } = shareTargets(post, shopName, slug, base);
  try {
    await navigator.share({ title: shopName, text, url });
    return "shared";
  } catch (e) {
    /* A cancel throws AbortError, which is not a failure worth reporting. */
    return e && e.name === "AbortError" ? "cancelled" : "unavailable";
  }
}

/* A seam for the test that checks these addresses actually carry the
   announcement. Not referenced by any screen. */
if (typeof window !== "undefined") {
  window.__dtShare = { shareTargets, shareText, shopUrl, canUseSheet };
}
