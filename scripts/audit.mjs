/* What is already on the app that the 20g rules would now refuse.
 *
 * The word filter added in 2026-10-20g runs when something is posted or
 * edited. It does not reach backwards, so anything posted before the deploy is
 * still sitting there untouched. This reads the four places it could be and
 * prints them. It writes nothing.
 *
 * Run it in Render's Web Shell on the API service:
 *     node scripts/audit.mjs
 * Everything it needs — Node, the database client, DATABASE_URL — is already
 * in that container, which the .sql version is not: there is no psql there.
 */
import { sql } from "../src/db.js";

const TOBACCO = "(cigarette|cigar|cigarillo|tobacco|vape|vaping|e-?cig|nicotine"
              + "|juul|hookah|shisha|snuff|snus|zyn)";
const BETTING = "(lottery|lotto|scratch-?off|powerball|mega ?millions|pick-? ?6"
              + "|cash4life|quick draw|gambling|casino|sportsbook|wager|betting"
              + "|parlay|bookmaker|fanduel|draftkings)";

const show = (title, rows, line) => {
  console.log(`\n=== ${title} ` + "=".repeat(Math.max(0, 54 - title.length)));
  if (!rows.length) { console.log("  (nothing — clean)"); return; }
  for (const r of rows) console.log("  " + line(r));
};

const shops = await sql`
  select slug, name, zip, active from shops
   where name ~* ${TOBACCO} or name ~* ${BETTING} order by name`;
show("1. SHOP NAMES", shops,
  (r) => `${r.name}  [${r.slug}]  ${r.zip}  ${r.active ? "live" : "removed"}`);

const aisles = await sql`
  select s.name as shop, a.aisle from shop_aisles a join shops s on s.id = a.shop_id
   where a.aisle ~* ${TOBACCO} or a.aisle ~* ${BETTING} order by s.name, a.aisle`;
show("2. AISLES", aisles, (r) => `${r.shop}  →  ${r.aisle}`);

const posts = await sql`
  select s.name as shop, p.status, p.created_at::date as posted, p.name,
         coalesce(p.note, '') as note
    from posts p join shops s on s.id = p.shop_id
   where p.name ~* ${TOBACCO} or p.name ~* ${BETTING}
      or coalesce(p.note,'') ~* ${TOBACCO} or coalesce(p.note,'') ~* ${BETTING}
   order by p.created_at desc`;
show("3. POSTS", posts,
  (r) => `${r.posted}  ${r.shop}  [${r.status}]  "${r.name}" ${r.note && "— " + r.note}`);

const asks = await sql`
  select s.name as shop, w.label, w.created_at::date as asked
    from wants w join shops s on s.id = w.shop_id
   where w.hidden_at is null and (w.label ~* ${TOBACCO} or w.label ~* ${BETTING})
   order by w.created_at desc`;
show("4. SHOPPER ITEM ASKS", asks, (r) => `${r.asked}  ${r.shop}  "${r.label}"`);

/* Who has yet to sign. These owners meet the undertaking screen the next time
   they open the app, and cannot post until they tick through it. Worth a text
   before they find out on their own. */
const owners = await sql`
  select o.email,
         coalesce(string_agg(distinct s.name, ', '), '(no shop)') as shops,
         max(t.accepted_at) as accepted
    from owners o
    left join memberships m on m.owner_id = o.id
    left join shops s on s.id = m.shop_id
    left join owner_terms t on t.owner_id = o.id
   group by o.email order by max(t.accepted_at) nulls first, o.email`;
show("5. THE UNDERTAKING — who has signed", owners,
  (r) => `${r.accepted ? "signed " + new Date(r.accepted).toISOString().slice(0, 10)
                       : "NOT YET "}  ${r.email}  (${r.shops})`);

console.log("\nNothing was changed. Sections 1–4 empty means there is nothing to clean up.\n");
await sql.end();
