/* ---------------------------------------------------------------------------
 * Firebase Cloud Messaging — the Android half.
 *
 * FCM's v1 API authenticates with an ordinary Google OAuth access token, which
 * we mint ourselves from the service-account JSON rather than pulling in the
 * Google auth library: it is one signed JWT and one form post, and it keeps a
 * large dependency out of a server whose whole job is sending short messages.
 *
 * The service-account JSON is downloaded once from the Firebase console
 * (Project settings → Service accounts → Generate new private key) and pasted
 * whole into one environment variable.
 * ------------------------------------------------------------------------- */
import { createSign } from "node:crypto";

const RAW = process.env.FCM_SERVICE_ACCOUNT || "";

let account = null;
try {
  if (RAW.trim()) account = JSON.parse(RAW);
} catch (e) {
  /* A malformed value here is a deployment mistake, and silently behaving as
     "Android not configured" would hide it until a shop owner complains. */
  console.error("[fcm] FCM_SERVICE_ACCOUNT is not valid JSON — Android push is off");
}

export const configured = Boolean(account?.client_email && account?.private_key &&
                                  account?.project_id);
export const projectId = account?.project_id || null;

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/* ------------------------------------------------------- access token ------ */

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o))
  .toString("base64url");

let cached = { token: null, expires: 0 };

async function accessToken() {
  /* A minute of headroom: a token that expires mid-fan-out would fail the
     tail of a shop's followers and nobody would know why. */
  if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const sig = createSign("RSA-SHA256")
    .update(`${head}.${body}`)
    .sign(account.private_key.replace(/\\n/g, "\n"))
    .toString("base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${head}.${body}.${sig}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`fcm auth failed: ${json.error_description || json.error || res.status}`);
  }
  cached = {
    token: json.access_token,
    expires: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return cached.token;
}

/* ------------------------------------------------------------------ send --- */

/**
 * Deliver one alert to one Android phone.
 * Returns { ok } or { ok: false, retire, reason } matching the web sender.
 */
export async function send(device, payload) {
  if (!configured) return { ok: false, retire: false, reason: "fcm_not_configured" };

  let token;
  try { token = await accessToken(); }
  catch (e) {
    /* Our credentials, not the shopper's phone. Never retire anyone for this. */
    console.warn("[fcm]", e.message);
    return { ok: false, retire: false, reason: "fcm_auth_failed" };
  }

  /* FCM requires every data value to be a string, and silently rejects the
     whole message if one is a number or null. */
  const data = {};
  for (const k of ["shop", "postId", "kind"]) {
    if (payload[k] != null) data[k] = String(payload[k]);
  }

  const message = {
    token: device.endpoint,
    notification: { title: payload.title, body: payload.body || "" },
    data,
    android: {
      priority: "HIGH",
      ttl: `${6 * 60 * 60}s`,       // a stale sale helps nobody
      notification: {
        icon: "ic_stat_dealtitude",
        color: "#FF9F1C",
        /* Same promise as the web worker's tag and APNs' collapse id: one
           notification per post, replaced on retry rather than stacked. */
        tag: payload.postId ? `post-${payload.postId}` : undefined,
      },
    },
  };

  let res, json;
  try {
    res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message }),
      }
    );
    json = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, retire: false, reason: "fcm_network" };
  }

  if (res.ok) return { ok: true };

  /* UNREGISTERED means the app was uninstalled or the token rotated —
     genuinely gone. INVALID_ARGUMENT usually means a malformed token, which is
     equally unrecoverable for that row. Everything else (quota, 500s, auth) is
     ours to fix and must never cost a shop a follower. */
  const status = json?.error?.status || "";
  const gone = res.status === 404 || status === "UNREGISTERED" ||
               (res.status === 400 && status === "INVALID_ARGUMENT");

  return { ok: false, retire: gone, reason: `fcm_${status || res.status}` };
}
