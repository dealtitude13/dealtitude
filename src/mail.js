/* ---------------------------------------------------------------------------
 * Sending the one email this product sends.
 *
 * A shop owner gets a sign-in link and nothing else. No newsletter, no digest,
 * no "we miss you" — so there is no unsubscribe flow to build and no reason for
 * a shopkeeper to mark Dealtitude as spam, which is what would stop the sign-in
 * link arriving for everyone else on the domain.
 *
 * With no key configured the link is logged instead. That is deliberate: a
 * pilot can start before the mail domain is verified, with you forwarding the
 * link by hand, rather than the whole thing being blocked on DNS.
 * ------------------------------------------------------------------------- */

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || "Dealtitude <hello@dealtitude.com>";
const REPLY_TO = process.env.MAIL_REPLY_TO || null;

export const mailConfigured = Boolean(KEY);

/* Plain text as well as HTML. Some shop owners read mail in clients that show
   one or the other, and a sign-in link that renders as nothing is a support
   call you cannot answer. */
function signInBody(link, minutes) {
  const text = [
    "Here is your Dealtitude sign-in link.",
    "",
    link,
    "",
    `It works once and expires in ${minutes} minutes.`,
    "If you didn't ask for it, you can ignore this — nothing has changed.",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;
  background:#F5EFE4;font-family:Helvetica,Arial,sans-serif;color:#1A1410">
  <div style="max-width:440px;margin:0 auto;background:#FFFDF8;border-radius:14px;
    padding:28px 24px;border:1px solid #DED3C2">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#7A6E62;
      text-transform:uppercase">Dealtitude</div>
    <div style="font-size:21px;font-weight:800;margin:14px 0 8px;letter-spacing:-.02em">
      Sign in to your shop</div>
    <div style="font-size:15px;line-height:1.5;color:#1A1410;margin-bottom:22px">
      Tap the button below. It works once and expires in ${minutes} minutes.</div>
    <a href="${link}" style="display:inline-block;background:#FF9F1C;color:#1A1410;
      text-decoration:none;font-weight:800;font-size:16px;padding:13px 22px;
      border-radius:10px">Open my shop</a>
    <div style="font-size:12.5px;line-height:1.55;color:#7A6E62;margin-top:22px">
      If the button doesn't work, copy this address into your browser:<br>
      <span style="word-break:break-all;color:#2E7D5B">${link}</span>
    </div>
    <div style="font-size:12.5px;line-height:1.55;color:#7A6E62;margin-top:18px;
      padding-top:16px;border-top:1px solid #F2ECE1">
      If you didn't ask for this, ignore it — nothing has changed.
    </div>
  </div></body></html>`;

  return { text, html };
}

/**
 * Send the sign-in link. Returns { sent: true } or { sent: false, reason }.
 *
 * Never throws: a mail provider having a bad minute must not turn into a 500
 * on the sign-in route, and it must never reveal to the caller whether that
 * address is registered.
 */
export async function sendSignInLink(email, link, minutes = 20) {
  if (!KEY) {
    console.log(`[auth] sign-in link for ${email}: ${link}`);
    return { sent: false, reason: "no_mail_key" };
  }

  const { text, html } = signInBody(link, minutes);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [email], subject: "Your Dealtitude sign-in link",
        text, html, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[mail] send failed", res.status, body.slice(0, 300));
      /* Log the link too, so a pilot is never stuck behind a mail outage. */
      console.log(`[auth] sign-in link for ${email}: ${link}`);
      return { sent: false, reason: `resend_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error("[mail] send threw", e.message);
    console.log(`[auth] sign-in link for ${email}: ${link}`);
    return { sent: false, reason: "network" };
  }
}
