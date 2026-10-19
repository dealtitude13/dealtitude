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
/* Overridable so the invite email can be tested against a stand-in provider
   that records what arrived. Without this seam the only way to know whether an
   invite sends anything is to send one to a real inbox and go and look — which
   is why it went unnoticed that it sent nothing at all. */
const ENDPOINT = process.env.RESEND_URL || "https://api.resend.com/emails";
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
    const res = await fetch(ENDPOINT, {
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

/* ----------------------------------------------------------------- invites --
 * The email an owner actually receives first.
 *
 * Separate wording from the sign-in link, because the situations are not the
 * same: a sign-in link is something you asked for seconds ago, an invite
 * arrives unprompted and has to say who set this up and what it is before it
 * asks anyone to tap anything. A shopkeeper who cannot tell it from phishing
 * will not tap it, and that is the whole business stalled at the first step.
 */
function inviteBody(link, shopName, days) {
  const text = [
    `${shopName} has been set up on Dealtitude.`,
    "",
    "Dealtitude lets you tell the customers who follow your shop when you have",
    "something on — a sale, a delivery just in, a change of hours. They choose",
    "which aisles they care about, and you can only reach them a few times a day.",
    "",
    "Open your shop here:",
    link,
    "",
    `This link is yours alone and works for ${days} days.`,
    "If you weren't expecting this, you can ignore it — nothing has been shared.",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;
  background:#F5EFE4;font-family:Helvetica,Arial,sans-serif;color:#1A1410">
  <div style="max-width:440px;margin:0 auto;background:#FFFDF8;border-radius:14px;
    padding:28px 24px;border:1px solid #DED3C2">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#7A6E62;
      text-transform:uppercase">Dealtitude</div>
    <div style="font-size:21px;font-weight:800;margin:14px 0 8px;letter-spacing:-.02em">
      ${shopName} is ready</div>
    <div style="font-size:15px;line-height:1.5;margin-bottom:18px">
      Tell the customers who follow your shop when you have something on — a
      sale, a delivery just in, a change of hours. They pick the aisles they
      care about, and you can only reach them a few times a day.</div>
    <a href="${link}" style="display:inline-block;background:#FF9F1C;color:#1A1410;
      text-decoration:none;font-weight:800;font-size:16px;padding:13px 22px;
      border-radius:10px">Open my shop</a>
    <div style="font-size:12.5px;line-height:1.55;color:#7A6E62;margin-top:22px">
      If the button doesn't work, copy this address into your browser:<br>
      <span style="word-break:break-all;color:#2E7D5B">${link}</span>
    </div>
    <div style="font-size:12.5px;line-height:1.55;color:#7A6E62;margin-top:18px;
      padding-top:16px;border-top:1px solid #F2ECE1">
      This link is yours alone and works for ${days} days. If you weren't
      expecting it, ignore it — nothing has been shared.
    </div>
  </div></body></html>`;

  return { text, html };
}

/**
 * Send an owner their first way in. Same guarantees as the sign-in link:
 * never throws, and says plainly whether it went.
 */
export async function sendInviteLink(email, link, shopName, days = 7) {
  if (!KEY) {
    console.log(`[invite] link for ${email} (${shopName}): ${link}`);
    return { sent: false, reason: "no_mail_key" };
  }
  const { text, html } = inviteBody(link, shopName, days);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [email], subject: `${shopName} is ready on Dealtitude`,
        text, html, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[mail] invite failed", res.status, body.slice(0, 300));
      console.log(`[invite] link for ${email} (${shopName}): ${link}`);
      /* The provider's own words, trimmed. "Domain not verified" and "key
         rejected" need completely different fixes, and a bare status code
         sends you looking in the wrong place. */
      return { sent: false, reason: `resend_${res.status}`,
               detail: body.slice(0, 200) };
    }
    return { sent: true };
  } catch (e) {
    console.error("[mail] invite threw", e.message);
    console.log(`[invite] link for ${email} (${shopName}): ${link}`);
    return { sent: false, reason: "network", detail: e.message };
  }
}

/* -------------------------------------------------- keeping your follows ----
 * Two emails for the one thing a shopper has no other way to do: carry their
 * follows onto a different phone.
 *
 * Both are written for someone who never made an account and may not remember
 * agreeing to anything. So each says plainly what Dealtitude is, that this is
 * the only thing the address is used for, and that ignoring it costs nothing.
 * An email that reads like a password reset for an account they never opened is
 * an email that gets reported as spam, and that damages the sending domain for
 * every shop on the platform.
 */

function recoveryBody(link) {
  const text = [
    "You asked Dealtitude to remember this address.",
    "",
    "Confirm it and the shops you follow can be restored if you ever change",
    "phones. Until you confirm, it isn't used for anything.",
    "",
    link,
    "",
    "This is the only thing we use this address for. We won't send you deals,",
    "and no shop ever sees it.",
    "If you didn't ask for this, ignore it — nothing has been saved.",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;
  background:#F5EFE4;font-family:Helvetica,Arial,sans-serif;color:#1A1410">
  <div style="max-width:440px;margin:0 auto;background:#FFFDF8;border-radius:14px;
    padding:28px 24px;border:1px solid #DED3C2">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#7A6E62;
      text-transform:uppercase">Dealtitude</div>
    <div style="font-size:21px;font-weight:800;margin:14px 0 8px;letter-spacing:-.02em">
      Confirm this address</div>
    <div style="font-size:15px;line-height:1.5;margin-bottom:18px">
      Confirm it and the shops you follow can be restored if you ever change
      phones. Until you confirm, it isn't used for anything.</div>
    <a href="${link}" style="display:inline-block;background:#2E7D5B;color:#fff;
      text-decoration:none;font-weight:800;font-size:16px;padding:13px 22px;
      border-radius:10px">Confirm my address</a>
    <div style="font-size:12.5px;line-height:1.55;color:#7A6E62;margin-top:22px">
      If the button doesn't work, copy this address into your browser:<br>
      <span style="word-break:break-all;color:#2E7D5B">${link}</span>
    </div>
    <div style="font-size:12.5px;line-height:1.55;color:#7A6E62;margin-top:18px;
      padding-top:16px;border-top:1px solid #F2ECE1">
      This is the only thing we use your address for. We won't send you deals,
      and no shop ever sees it. If you didn't ask for this, ignore it — nothing
      has been saved.
    </div>
  </div></body></html>`;

  return { text, html };
}

/** Confirm a recovery address. Never throws. */
export async function sendRecoveryConfirm(email, link) {
  if (!KEY) {
    console.log(`[recovery] confirm link for ${email}: ${link}`);
    return { sent: false, reason: "no_mail_key" };
  }
  const { text, html } = recoveryBody(link);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [email], subject: "Confirm your Dealtitude address",
        text, html, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[mail] recovery confirm failed", res.status, body.slice(0, 300));
      console.log(`[recovery] confirm link for ${email}: ${link}`);
      return { sent: false, reason: `resend_${res.status}`, detail: body.slice(0, 200) };
    }
    return { sent: true };
  } catch (e) {
    console.error("[mail] recovery confirm threw", e.message);
    console.log(`[recovery] confirm link for ${email}: ${link}`);
    return { sent: false, reason: "network", detail: e.message };
  }
}

function restoreBody(link, code) {
  const text = [
    "Here are your follows.",
    "",
    "Open this link on your new phone and the shops you follow — and the aisles",
    "you picked — come back with it:",
    link,
    "",
    `Already installed the Dealtitude app? Open it, go to the You tab, choose`,
    `"I have a code" and type: ${code}`,
    "",
    "This works once and expires in 2 hours.",
    "If you didn't ask for it, ignore it — nothing has changed.",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;
  background:#F5EFE4;font-family:Helvetica,Arial,sans-serif;color:#1A1410">
  <div style="max-width:440px;margin:0 auto;background:#FFFDF8;border-radius:14px;
    padding:28px 24px;border:1px solid #DED3C2">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#7A6E62;
      text-transform:uppercase">Dealtitude</div>
    <div style="font-size:21px;font-weight:800;margin:14px 0 8px;letter-spacing:-.02em">
      Here are your follows</div>
    <div style="font-size:15px;line-height:1.5;margin-bottom:18px">
      Open this on your new phone and the shops you follow — and the aisles you
      picked — come back with it.</div>
    <a href="${link}" style="display:inline-block;background:#FF9F1C;color:#1A1410;
      text-decoration:none;font-weight:800;font-size:16px;padding:13px 22px;
      border-radius:10px">Restore my follows</a>
    <div style="font-size:13px;line-height:1.55;color:#7A6E62;margin-top:22px;
      padding-top:16px;border-top:1px solid #F2ECE1">
      Already have the Dealtitude app installed? Open it, go to the
      <b style="color:#1A1410">You</b> tab, choose "I have a code" and type:
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:20px;
        font-weight:600;letter-spacing:.12em;color:#1A1410;background:#F2ECE1;
        border-radius:9px;padding:12px;margin-top:10px;text-align:center">${code}</div>
    </div>
    <div style="font-size:12.5px;line-height:1.55;color:#7A6E62;margin-top:18px;
      padding-top:16px;border-top:1px solid #F2ECE1">
      This works once and expires in 2 hours. If you didn't ask for it, ignore
      it — nothing has changed.
    </div>
  </div></body></html>`;

  return { text, html };
}

/** Send a new phone its way back. Never throws, and never says who it found. */
export async function sendRestoreLink(email, link, code) {
  if (!KEY) {
    console.log(`[recovery] restore link for ${email}: ${link}`);
    return { sent: false, reason: "no_mail_key" };
  }
  const { text, html } = restoreBody(link, code);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [email], subject: "Restore your Dealtitude follows",
        text, html, ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[mail] restore failed", res.status, body.slice(0, 300));
      console.log(`[recovery] restore link for ${email}: ${link}`);
      return { sent: false, reason: `resend_${res.status}`, detail: body.slice(0, 200) };
    }
    return { sent: true };
  } catch (e) {
    console.error("[mail] restore threw", e.message);
    console.log(`[recovery] restore link for ${email}: ${link}`);
    return { sent: false, reason: "network", detail: e.message };
  }
}
