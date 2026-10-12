/* ---------------------------------------------------------------------------
 * Publishing a post and fanning it out.
 *
 * The decisions — who hears it, who doesn't, and why — are made by
 * recipients_for() in SQL so there is exactly one copy of the rule. This file
 * records the outcome for every follower, including the ones who were
 * withheld, because "we held 3 back for you" is the honest half of the reach
 * number a shop is paying for.
 * ------------------------------------------------------------------------- */
import { sql } from "./db.js";
import { send, retireDevice } from "./push.js";

const money = (c) =>
  c == null ? null : `$${(c / 100).toFixed(2)}`;

/** What the notification actually says. Short: it is read on a lock screen. */
export function compose(shop, post) {
  if (post.kind === "sale") {
    const price = money(post.now_cents);
    return {
      title: `${post.name} — ${price} at ${shop.name}`,
      body: post.was_cents && post.was_cents > post.now_cents
        ? `Was ${money(post.was_cents)}.${post.note ? " " + post.note : ""}`
        : post.note || `On sale now at ${shop.name}.`,
    };
  }
  if (post.kind === "arrival") {
    return { title: `${shop.name}: ${post.name}`,
             body: post.note || "Just arrived." };
  }
  return { title: `${shop.name}: ${post.name}`,
           body: post.note || (post.kind === "hours" ? "Hours have changed." : "") };
}

/**
 * Create the post, work out who it reaches, record every outcome, and send.
 * Returns { post, sent, withheld: {reason: count} }.
 */
export async function publish(shopId, input, postedBy = null) {
  const [shop] = await sql`select * from shops where id = ${shopId} and active`;
  if (!shop) throw Object.assign(new Error("no such shop"), { status: 404 });

  const wide = input.kind === "hours" || input.kind === "notice";

  /* Guard the aisle here as well as in the constraint: a sale filed under an
     aisle this shop does not have would be filtered out to nobody, silently. */
  if (!wide) {
    const have = await sql`
      select 1 from shop_aisles where shop_id = ${shopId} and aisle = ${input.aisle}`;
    if (!have.length)
      throw Object.assign(new Error(`this shop has no aisle "${input.aisle}"`),
                          { status: 400 });
  }

  /* Don't let the same item go out twice in a panic of double taps. */
  const dupWindow = "20 minutes";
  const [dup] = await sql`
    select id from posts
     where shop_id = ${shopId} and name = ${input.name} and kind = ${input.kind}
       and created_at > now() - ${dupWindow}::interval
     limit 1`;
  if (dup) throw Object.assign(new Error("that was just posted"), { status: 409 });

  const [post] = await sql`
    insert into posts ${sql({
      shop_id: shopId,
      kind: input.kind,
      aisle: wide ? null : input.aisle,
      name: input.name,
      note: input.note ?? null,
      gtin: input.gtin ?? null,
      was_cents: input.was_cents ?? null,
      now_cents: input.now_cents ?? null,
      ends: input.ends ?? null,
      posted_by: postedBy,
    })} returning *`;

  /* The shop learns the barcode so the next scan fills itself in. */
  if (input.gtin) {
    await sql`
      insert into catalog (shop_id, gtin, name, aisle, was_cents, now_cents)
      values (${shopId}, ${input.gtin}, ${input.name}, ${wide ? null : input.aisle},
              ${input.was_cents ?? null}, ${input.now_cents ?? null})
      on conflict (shop_id, gtin) do update
        set name = excluded.name, aisle = excluded.aisle,
            was_cents = excluded.was_cents, now_cents = excluded.now_cents,
            updated_at = now()`;
  }

  const rows = await sql`select * from recipients_for(${post.id})`;
  const toSend = rows.filter((r) => r.withheld === null);
  const held   = rows.filter((r) => r.withheld !== null);

  /* Record the held ones first. If sending falls over halfway, the ledger
     still reflects the decisions that were made. */
  if (held.length) {
    await sql`insert into deliveries ${sql(held.map((r) => ({
      post_id: post.id, device_id: r.device_id, shop_id: shopId, withheld: r.withheld,
    })))} on conflict do nothing`;
  }

  const payload = { ...compose(shop, post), postId: post.id, shop: shop.slug,
                    kind: post.kind };

  let sent = 0;
  for (const r of toSend) {
    const [device] = await sql`select * from devices where id = ${r.device_id}`;
    if (!device) continue;
    const res = await send(device, payload);
    if (res.ok) {
      sent++;
      await sql`insert into deliveries (post_id, device_id, shop_id)
                values (${post.id}, ${r.device_id}, ${shopId})
                on conflict do nothing`;
    } else {
      if (res.retire) await retireDevice(r.device_id, res.reason);
      await sql`insert into deliveries (post_id, device_id, shop_id, withheld)
                values (${post.id}, ${r.device_id}, ${shopId}, 'no_device')
                on conflict do nothing`;
    }
  }

  const withheld = {};
  for (const r of held) withheld[r.withheld] = (withheld[r.withheld] || 0) + 1;
  return { post, sent, withheld };
}
