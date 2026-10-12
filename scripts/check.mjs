#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * Is the deployment actually working?
 *
 *   node scripts/check.mjs https://api.dealtitude.com https://dealtitude.com
 *
 * Every one of these can fail quietly and look, from a phone, like "the app is
 * a bit broken" — a follow that doesn't stick, an alert nobody gets, a card
 * that lands on the ZIP screen. So each is checked out loud, and each failure
 * says what to change rather than what went wrong.
 * ------------------------------------------------------------------------- */

const api = (process.argv[2] || "").replace(/\/+$/, "");
const site = (process.argv[3] || "").replace(/\/+$/, "");
if (!api) {
  console.error("usage: node scripts/check.mjs <api-url> [site-url]");
  process.exit(1);
}

let bad = 0;
const yes = (s) => console.log(`  ok    ${s}`);
const no = (s, fix) => { bad++; console.log(`  FAIL  ${s}\n        → ${fix}`); };

const get = async (url, opts) => {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body, headers: r.headers };
  } catch (e) { return { status: 0, error: e.message }; }
};

console.log(`\nAPI  ${api}`);

const h = await get(`${api}/v1/health`);
if (h.status === 0) {
  no("the API doesn't answer at all",
     "Check the service is deployed and awake. A free tier that sleeps will do this.");
} else {
  yes("the API answers");

  if (h.body?.db) yes("it can reach the database");
  else no("it cannot reach the database",
          "Check DATABASE_URL. A managed Postgres needs TLS; a wrong password gives this too.");

  if (h.body?.push) yes("push is configured");
  else no("push is NOT configured — no alert can ever be delivered",
          "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY from `npm run keys`.");

  if (h.body?.mail) yes("sign-in emails will be sent");
  else console.log("  note  no mail sender — sign-in links go to the server log instead\n" +
                   "        → Fine for now. Set RESEND_API_KEY when the domain is verified.");

  const localhost = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/;
  const appUrl = h.body?.app_url;
  if (appUrl && (/^https:\/\//.test(appUrl) || localhost.test(appUrl)))
    yes(`sign-in links point at ${appUrl}`);
  else no(`APP_URL is ${appUrl || "unset"} — sign-in links will be broken`,
          "Set APP_URL to the address the app is served from, with https://");

  const origins = h.body?.origins || [];
  if (site && !origins.includes("*") && !origins.includes(site))
    no(`${site} is not in ALLOWED_ORIGINS`,
       `Set ALLOWED_ORIGINS to include ${site} — otherwise every request from the app fails.`);
  else if (origins.includes("*"))
    console.log("  note  ALLOWED_ORIGINS is open to everything\n" +
                "        → Narrow it to your own domain before you take payment.");
  else yes("the app's address is allowed to call the API");
}

const key = await get(`${api}/v1/push-key`);
if (key.status === 200 && key.body?.key?.length > 60) yes("the push key is being served to phones");
else no("the push key endpoint is not serving a key",
        "Phones cannot subscribe without it. Check the VAPID variables.");

/* A real cross-origin preflight, which is what the browser actually sends. */
if (site) {
  const pre = await get(`${api}/v1/shops?zip=08831`, {
    method: "OPTIONS",
    headers: { origin: site, "access-control-request-method": "GET",
               "access-control-request-headers": "authorization,content-type" },
  });
  const allow = pre.headers?.get?.("access-control-allow-origin");
  if (allow && (allow === "*" || allow === site)) yes("CORS lets the app through");
  else no("CORS blocks the app",
          `Add ${site} to ALLOWED_ORIGINS and redeploy. Every call fails until you do.`);
}

if (site) {
  console.log(`\nSITE ${site}`);
  const home = await get(site);
  if (home.status === 0) no("the site doesn't answer", "Check the deploy and the DNS.");
  else yes("the site answers");

  /* The single most important thing before printing anything. */
  const card = await fetch(`${site}/a-slug-that-does-not-exist`,
    { redirect: "manual", signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!card) no("couldn't test a shop path", "Check the site is reachable.");
  else if (card.status === 200) yes("a shop path serves the app (printed cards will work)");
  else no(`a shop path returns ${card.status} instead of the app`,
          "Add the rewrite: every path must serve /index.html with status 200, " +
          "not a redirect. Without it every printed QR code lands on a 404.");

  const cfg = await fetch(`${site}/config.js`, { signal: AbortSignal.timeout(15000) })
    .then((r) => r.text()).catch(() => "");
  const named = cfg.match(/DEALTITUDE_API\s*=\s*"([^"]*)"/)?.[1];
  if (!named)
    no("config.js doesn't name an API",
       "The app is in demo mode — nothing it does reaches the server. " +
       `Set window.DEALTITUDE_API = "${api}" in www/config.js and redeploy.`);
  else if (named.replace(/\/+$/, "") !== api)
    no(`the app is pointed at ${named}, not ${api}`,
       `Set window.DEALTITUDE_API = "${api}" in www/config.js and redeploy.`);
  else yes("the app is pointed at this API");
}

console.log(bad === 0
  ? "\nAll good. Follow a shop on your phone, then post from the owner side.\n"
  : `\n${bad} thing${bad === 1 ? "" : "s"} to fix before this is usable.\n`);
process.exit(bad ? 1 : 0);
