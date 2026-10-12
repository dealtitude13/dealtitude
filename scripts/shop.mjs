#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * Adding a shop, from the command line.
 *
 * Creating a shop and inviting its owner are the two things only you ever do,
 * and they are the two things that must not be possible over the public API
 * without the operator key. So they live here, talking to the database
 * directly, rather than as a screen anyone could find.
 *
 *   node scripts/shop.mjs add brownbros "Brown Brothers Grocery" \
 *        "418 Applegate Road" "Monroe Township" 08831 \
 *        --aisles produce,dairy,sweets,pantry,frozen \
 *        --hours "8:00 AM – 9:00 PM" --cap 3
 *
 *   node scripts/shop.mjs invite brownbros owner@brownbros.com
 *   node scripts/shop.mjs list
 *   node scripts/shop.mjs reach brownbros
 * ------------------------------------------------------------------------- */
import { sql } from "../src/db.js";
import { newToken, store } from "../src/auth.js";

const [cmd, ...rest] = process.argv.slice(2);

/* Pull --flags out so the positional arguments stay readable. */
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
  else args.push(rest[i]);
}

const die = (msg) => { console.error(msg); process.exit(1); };
const money = (c) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

switch (cmd) {
  case "add": {
    const [slug, name, address, town, zip] = args;
    if (!slug || !name || !address || !town || !zip)
      die("usage: add <slug> <name> <address> <town> <zip> [--aisles a,b,c] [--hours ..] [--cap n]");
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug))
      die(`"${slug}" won't work as a slug — lowercase letters, numbers and hyphens only.\n` +
          "It becomes the printed address on the counter card, so keep it short.");
    const aisles = (flags.aisles || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!aisles.length)
      die("--aisles is required. These are what a shopper opts into; without any,\n" +
          "only hours and announcements could ever reach a follower.");

    const [shop] = await sql`
      insert into shops (slug, name, address, town, zip, hours, daily_cap)
      values (${slug}, ${name}, ${address}, ${town}, ${zip},
              ${flags.hours || null}, ${Number(flags.cap || 3)})
      on conflict (slug) do update
        set name = excluded.name, address = excluded.address, town = excluded.town,
            zip = excluded.zip, hours = excluded.hours, daily_cap = excluded.daily_cap
      returning *`;

    await sql`insert into shop_aisles ${sql(aisles.map((a, i) => ({
      shop_id: shop.id, aisle: a, position: i })))} on conflict do nothing`;
    /* An aisle removed from the list should stop being offered. */
    await sql`delete from shop_aisles where shop_id = ${shop.id}
               and aisle <> all (${aisles})`;

    console.log(`${shop.name}`);
    console.log(`  card address   ${process.env.APP_URL || "https://dealtitude.com"}/${shop.slug}`);
    console.log(`  aisles         ${aisles.join(", ")}`);
    console.log(`  daily cap      ${shop.daily_cap} alerts per follower per day`);
    console.log(`\nNext:  node scripts/shop.mjs invite ${shop.slug} <their email>`);
    break;
  }

  case "invite": {
    const [slug, email] = args;
    if (!slug || !email) die("usage: invite <slug> <email>");
    const [shop] = await sql`select * from shops where slug = ${slug}`;
    if (!shop) die(`no shop with slug "${slug}" — run: node scripts/shop.mjs list`);

    await sql`insert into invites (token, shop_id, email, role, expires_at)
              values (${store(newToken())}, ${shop.id}, ${email}, 'owner',
                      now() + interval '30 days')`;
    console.log(`${email} can now run ${shop.name}.`);
    console.log("\nTell them: open the app, tap \"Shop owner\", enter that address.");
    console.log("The shop becomes theirs the first time they sign in with it.");
    break;
  }

  case "list": {
    const rows = await sql`
      select s.slug, s.name, s.town, s.zip, s.daily_cap, s.active,
             (select count(*) from follows f where f.shop_id = s.id) as followers,
             (select count(*) from posts p
               where p.shop_id = s.id and p.created_at > now() - interval '7 days') as week,
             (select string_agg(m.email, ', ') from memberships mm
                join owners m on m.id = mm.owner_id where mm.shop_id = s.id) as owners
        from shops s order by s.name`;
    if (!rows.length) { console.log("No shops yet."); break; }
    for (const r of rows) {
      console.log(`${r.active ? " " : "·"} ${r.name}  (/${r.slug})`);
      console.log(`    ${r.town} ${r.zip} · ${r.followers} followers · ` +
                  `${r.week} posts this week · cap ${r.daily_cap}`);
      console.log(`    owner: ${r.owners || "not claimed yet"}`);
    }
    break;
  }

  case "reach": {
    const [slug] = args;
    if (!slug) die("usage: reach <slug>");
    const [shop] = await sql`select * from shops where slug = ${slug}`;
    if (!shop) die(`no shop with slug "${slug}"`);
    const [r] = await sql`select * from reach_for(${shop.id})`;
    console.log(`${shop.name}`);
    console.log(`  followers        ${r.total}`);
    console.log(`  muted            ${r.muted}`);
    console.log(`  no notifications ${r.no_push}`);
    console.log(`  REACHABLE        ${r.reachable}   <- what they are paying for`);

    const opens = await sql`
      select p.name, p.kind, p.now_cents,
             count(*) filter (where d.withheld is null) as sent,
             count(*) filter (where d.opened_at is not null) as opened
        from posts p left join deliveries d on d.post_id = p.id
       where p.shop_id = ${shop.id} and p.created_at > now() - interval '30 days'
       group by p.id order by p.created_at desc limit 10`;
    if (opens.length) {
      console.log("\n  last 30 days");
      for (const o of opens)
        console.log(`    ${String(o.sent).padStart(4)} sent  ${String(o.opened).padStart(4)} opened   ` +
                    `${o.name}${o.kind === "sale" ? " · " + money(o.now_cents) : ""}`);
    }
    break;
  }

  default:
    console.log(`Dealtitude — shop admin

  node scripts/shop.mjs add <slug> <name> <address> <town> <zip> \\
       --aisles produce,dairy,sweets --hours "8 AM – 9 PM" --cap 3
  node scripts/shop.mjs invite <slug> <email>
  node scripts/shop.mjs list
  node scripts/shop.mjs reach <slug>
`);
}

await sql.end();
