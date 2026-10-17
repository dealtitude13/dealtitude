-- ============================================================================
-- Dealtitude — the database behind the app.
--
-- Two ideas shape this schema:
--
--   1. A shopper has no account. The device's push subscription IS the
--      identity. That removes sign-up from the one moment where friction
--      costs you the follower, and it means a lost phone loses only that
--      phone's follows. An optional claim code links devices later.
--
--   2. Owner access is never claimed, only granted. There is no column a
--      client can set to become an owner — membership arrives through an
--      invite row that someone with the keys created.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------- shops ----
create table if not exists shops (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null
                  check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name          text not null,
  address       text not null,
  town          text not null,
  zip           text not null,
  lat           double precision,
  lon           double precision,
  hours         text,
  -- the most alerts ONE follower can receive from this shop in a day
  daily_cap     smallint not null default 3 check (daily_cap between 1 and 10),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists shops_zip_idx on shops (zip) where active;

-- The aisles a shop actually has. A follower subscribes to a subset.
create table if not exists shop_aisles (
  shop_id   uuid not null references shops(id) on delete cascade,
  aisle     text not null,
  position  smallint not null default 0,
  primary key (shop_id, aisle)
);

-- -------------------------------------------------------------- devices ----
-- One row per browser/app install. `endpoint` is the Web Push subscription
-- URL; for a native build it is the APNs/FCM token instead.
create table if not exists devices (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'webpush'
                  check (kind in ('webpush','apns','fcm')),
  endpoint      text not null unique,
  p256dh        text,                     -- webpush only
  auth          text,                     -- webpush only
  user_agent    text,
  -- set when the push service tells us this subscription is dead
  retired_at    timestamptz,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists devices_live_idx on devices (id) where retired_at is null;

-- --------------------------------------------------------------- follows ---
-- aisles = NULL  -> every aisle (legacy; nothing creates this now)
-- aisles = '{}'  -> none picked yet; only shop-wide news reaches them
create table if not exists follows (
  device_id   uuid not null references devices(id) on delete cascade,
  shop_id     uuid not null references shops(id)   on delete cascade,
  aisles      text[] not null default '{}',
  muted       boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (device_id, shop_id)
);
create index if not exists follows_shop_idx on follows (shop_id);

-- ----------------------------------------------------------------- posts ---
-- 'sale' and 'arrival' answer to the aisle filter.
-- 'hours' and 'notice' are shop-wide and skip it, but still count to the cap.
create table if not exists posts (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops(id) on delete cascade,
  kind          text not null check (kind in ('sale','arrival','hours','notice')),
  aisle         text,
  name          text not null,
  note          text,
  gtin          text,                     -- scanned barcode, if any
  -- money in integer cents, never floats
  was_cents     integer check (was_cents >= 0),
  now_cents     integer check (now_cents >= 0),
  ends          text,
  status        text not null default 'active' check (status in ('active','ended')),
  posted_by     text,
  created_at    timestamptz not null default now(),
  -- a shop-wide kind must not carry an aisle, and a priced kind must have a price
  constraint aisle_matches_kind check (
    (kind in ('hours','notice') and aisle is null) or
    (kind in ('sale','arrival') and aisle is not null)
  ),
  constraint price_matches_kind check (
    kind <> 'sale' or now_cents is not null
  )
);
create index if not exists posts_shop_live_idx on posts (shop_id, created_at desc)
  where status = 'active';

-- Per-device delivery ledger. This is what the daily cap counts, what proves
-- reach to a shop, and what stops the same item going out twice.
create table if not exists deliveries (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references posts(id)   on delete cascade,
  device_id    uuid not null references devices(id) on delete cascade,
  shop_id      uuid not null references shops(id)   on delete cascade,
  sent_at      timestamptz not null default now(),
  opened_at    timestamptz,
  -- why it did NOT go, when it didn't
  withheld     text check (withheld in
                 ('aisle_off','daily_cap','muted','no_device','duplicate')),
  unique (post_id, device_id)
);
create index if not exists deliveries_cap_idx
  on deliveries (device_id, shop_id, sent_at) where withheld is null;

-- --------------------------------------------------------------- owners ----
-- Access is granted, never claimed. No request body can make someone an owner.
create table if not exists owners (
  id          uuid primary key default gen_random_uuid(),
  email       citext unique not null,
  name        text,
  created_at  timestamptz not null default now()
);

create table if not exists memberships (
  owner_id    uuid not null references owners(id) on delete cascade,
  shop_id     uuid not null references shops(id)  on delete cascade,
  role        text not null default 'owner' check (role in ('owner','staff')),
  created_at  timestamptz not null default now(),
  primary key (owner_id, shop_id)
);

create table if not exists invites (
  token       text primary key,
  shop_id     uuid not null references shops(id) on delete cascade,
  email       citext not null,
  role        text not null default 'owner' check (role in ('owner','staff')),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references owners(id)
);

-- Sign-in links for owners. Short-lived, single use.
create table if not exists login_links (
  token      text primary key,
  email      citext not null,
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table if not exists sessions (
  token      text primary key,
  owner_id   uuid not null references owners(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Per-shop barcode catalogue. The shop names an item once; every later scan
-- of that code fills itself in. No public product database carries a 20 lb
-- sack of basmati from a Monroe Township grocer.
create table if not exists catalog (
  shop_id    uuid not null references shops(id) on delete cascade,
  gtin       text not null,
  name       text not null,
  aisle      text,
  was_cents  integer,
  now_cents  integer,
  updated_at timestamptz not null default now(),
  primary key (shop_id, gtin)
);

-- ------------------------------------------------------------ the filter ---
-- Who should receive this post, and who should not, with the reason.
-- Kept in SQL so the rule has exactly one home — the client cannot drift
-- from it and neither can a second server.
create or replace function recipients_for(p_post_id uuid)
returns table (device_id uuid, withheld text)
language sql stable as $$
  with p as (
    select po.*, s.daily_cap
      from posts po join shops s on s.id = po.shop_id
     where po.id = p_post_id
  )
  select f.device_id,
         case
           when f.muted then 'muted'
           when d.id is null or d.retired_at is not null then 'no_device'
           -- hours and notices reach everyone; sales and arrivals do not
           when p.kind in ('sale','arrival') and not (p.aisle = any (f.aisles))
             then 'aisle_off'
           when (select count(*) from deliveries dl
                  where dl.device_id = f.device_id
                    and dl.shop_id   = p.shop_id
                    and dl.withheld is null
                    and dl.sent_at > now() - interval '24 hours') >= p.daily_cap
             then 'daily_cap'
           else null
         end as withheld
    from p
    join follows f on f.shop_id = p.shop_id
    left join devices d on d.id = f.device_id and d.retired_at is null
$$;

-- What a shop is actually paying for: not followers, but reachable followers.
create or replace function reach_for(p_shop_id uuid)
returns table (total bigint, muted bigint, no_push bigint, reachable bigint)
language sql stable as $$
  select count(*)                                                   as total,
         count(*) filter (where f.muted)                            as muted,
         count(*) filter (where not f.muted
                            and (d.id is null or d.retired_at is not null)) as no_push,
         count(*) filter (where not f.muted
                            and d.id is not null
                            and d.retired_at is null)               as reachable
    from follows f
    left join devices d on d.id = f.device_id
   where f.shop_id = p_shop_id
$$;

-- Device credential. Added here rather than in `devices` above so the column
-- reads as what it is: the only thing a phone uses to prove it is itself.
alter table devices add column if not exists token_hash text unique;
create index if not exists devices_token_idx on devices (token_hash);

-- ---------------------------------------------------------------------------
-- A phone with no push subscription is still a real follower.
--
-- Someone who declines notifications, or whose iPhone is not on the home
-- screen yet, can still follow a shop and open the app to see what is on. So
-- the token is the identity and `endpoint` is merely where this phone happens
-- to be reachable — which may be nowhere yet. Postgres lets any number of rows
-- hold NULL under a unique index, so the constraint still does its job for
-- every device that does have one.
alter table devices alter column endpoint drop not null;
alter table devices drop constraint if exists devices_kind_check;
alter table devices add constraint devices_kind_check
  check (kind in ('none','webpush','apns','fcm'));

-- ---------------------------------------------------------------------------
-- Carrying a follower from one install to another.
--
-- On an iPhone, a web app added to the home screen gets its OWN storage: it
-- cannot see anything Safari saved. So someone who follows a shop in Safari
-- and then adds the app to their home screen would arrive as a stranger, with
-- the follow they just made stranded on the other side.
--
-- A claim code bridges that. The Safari side asks for a short code, the
-- installed app redeems it, and the same device row — with its follows and its
-- aisles — carries over. The code is short-lived, single use, and worth
-- nothing on its own: redeeming it only ever yields the follows of the phone
-- that asked for it.
--
-- The same mechanism carries a follower into a native app later.
create table if not exists device_claims (
  code        text primary key,
  device_id   uuid not null references devices(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists device_claims_device_idx on device_claims (device_id);

-- Both functions below must count an endpoint-less device as unreachable.
-- Calling it reachable would inflate the one number a shop is paying for.
create or replace function recipients_for(p_post_id uuid)
returns table (device_id uuid, withheld text)
language sql stable as $$
  with p as (
    select po.*, s.daily_cap
      from posts po join shops s on s.id = po.shop_id
     where po.id = p_post_id
  )
  select f.device_id,
         case
           when f.muted then 'muted'
           when d.id is null or d.retired_at is not null or d.endpoint is null
             then 'no_device'
           when p.kind in ('sale','arrival') and not (p.aisle = any (f.aisles))
             then 'aisle_off'
           when (select count(*) from deliveries dl
                  where dl.device_id = f.device_id
                    and dl.shop_id   = p.shop_id
                    and dl.withheld is null
                    and dl.sent_at > now() - interval '24 hours') >= p.daily_cap
             then 'daily_cap'
           else null
         end as withheld
    from p
    join follows f on f.shop_id = p.shop_id
    left join devices d on d.id = f.device_id and d.retired_at is null
$$;

create or replace function reach_for(p_shop_id uuid)
returns table (total bigint, muted bigint, no_push bigint, reachable bigint)
language sql stable as $$
  select count(*)                                      as total,
         count(*) filter (where f.muted)               as muted,
         count(*) filter (where not f.muted
                            and (d.id is null or d.retired_at is not null
                                 or d.endpoint is null))       as no_push,
         count(*) filter (where not f.muted
                            and d.id is not null
                            and d.retired_at is null
                            and d.endpoint is not null)         as reachable
    from follows f
    left join devices d on d.id = f.device_id
   where f.shop_id = p_shop_id
$$;

-- ============================================================================
-- Age-restricted shops.
--
-- A liquor store's alerts are alcohol marketing, and both app stores require a
-- gate in front of them. The gate is an attestation, not an identity check —
-- which is what the stores ask for and all any consumer app can honestly do.
--
-- What matters here is where the date of birth lives: ON THE PHONE, and
-- nowhere else. The phone works out whether it clears the bar and sends only
-- the bar it cleared. The server never receives a birth date, so there is no
-- date of birth in this database to leak, to subpoena, or to explain to a shop
-- owner. `age_ok_to` is the highest minimum age this device has attested to.
-- ============================================================================

alter table shops
  add column if not exists min_age smallint
    check (min_age is null or min_age between 13 and 25);

alter table devices add column if not exists age_ok_to smallint;
alter table devices add column if not exists age_ok_at timestamptz;

-- The reason has to be recordable, or an alert withheld for age would violate
-- the deliveries constraint and take the whole fan-out down with it.
--
-- Kept as one authoritative list rather than a narrow constraint that a later
-- migration widens: schema.sql is re-applied in full, so the narrow step ran
-- first against rows the widened step had already allowed, and failed.
alter table deliveries drop constraint if exists deliveries_withheld_check;
alter table deliveries add constraint deliveries_withheld_check
  check (withheld is null or withheld in
    ('aisle_off','daily_cap','muted','no_device','duplicate','age_unverified',
     'push_unconfigured','send_failed','gone'));

-- A follower who has not cleared the shop's age bar is never sent to, even if
-- a row somehow exists. The gate in the app is the door; this is the lock.
create or replace function recipients_for(p_post_id uuid)
returns table (device_id uuid, withheld text)
language sql stable as $$
  with p as (
    select po.*, s.daily_cap, s.min_age
      from posts po join shops s on s.id = po.shop_id
     where po.id = p_post_id
  )
  select f.device_id,
         case
           when f.muted then 'muted'
           when p.min_age is not null
                and (d.age_ok_to is null or d.age_ok_to < p.min_age)
             then 'age_unverified'
           when d.id is null or d.retired_at is not null or d.endpoint is null
             then 'no_device'
           when p.kind in ('sale','arrival') and not (p.aisle = any (f.aisles))
             then 'aisle_off'
           when (select count(*) from deliveries dl
                  where dl.device_id = f.device_id
                    and dl.shop_id   = p.shop_id
                    and dl.withheld is null
                    and dl.sent_at > now() - interval '24 hours') >= p.daily_cap
             then 'daily_cap'
           else null
         end as withheld
    from p
    join follows f on f.shop_id = p.shop_id
    left join devices d on d.id = f.device_id and d.retired_at is null
$$;

-- An unverified follower of an age-restricted shop is not reach. Counting them
-- would charge the shop for people the server will never send to.
create or replace function reach_for(p_shop_id uuid)
returns table (total bigint, muted bigint, no_push bigint, reachable bigint)
language sql stable as $$
  with s as (select min_age from shops where id = p_shop_id),
  ok as (
    select f.muted,
           d.id is not null and d.retired_at is null and d.endpoint is not null
             as has_push,
           (select min_age from s) is null
             or (d.age_ok_to is not null
                 and d.age_ok_to >= (select min_age from s))  as old_enough
      from follows f
      left join devices d on d.id = f.device_id
     where f.shop_id = p_shop_id
  )
  select count(*)                                                   as total,
         count(*) filter (where muted)                              as muted,
         count(*) filter (where not muted
                            and (not has_push or not old_enough))   as no_push,
         count(*) filter (where not muted and has_push
                            and old_enough)                         as reachable
    from ok
$$;

-- Which of Apple's two push services this device's token belongs to. Learned
-- on first send rather than configured: a developer testing from Xcode and a
-- customer who installed from the App Store are on different services at the
-- same time, which no single setting can express. Null until established.
alter table devices add column if not exists push_env text
  check (push_env is null or push_env in ('production','sandbox'));

-- A send that fails after recipients_for() has cleared the follower is still a
-- decision the shop is owed. Those were written here as 'no_device' and left
-- out of the publish response altogether, so a shop with one eligible follower
-- and no push keys configured was told "nobody follows this shop yet". Three
-- of the reasons above are not the follower's problem and must never be worded
-- as if they were: push_unconfigured is ours, send_failed is the push
-- service's, and gone means the subscription died since they followed.

-- ------------------------------------------------------------------ wants ----
-- "Hoping for something else?" used to be the shop's own aisle list rendered a
-- second time, with the overlap greyed out — the shopper picking from the same
-- five chips twice on one screen. Worse, the tally lived in the app's own
-- memory and never reached here, so the owner's "what shoppers asked for"
-- panel was showing that one device its own taps back.
--
-- An aisle is not a want. A shopkeeper knows he sells sweets; what he cannot
-- know is that six people are waiting for Kaju Katli. So a want is an ITEM, in
-- the shopper's words, and it earns them something concrete in return: a
-- standing alert for that one thing, which reaches them even if they never
-- switched its aisle on. Aisles filter. Wants pull.
create table if not exists wants (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id)   on delete cascade,
  device_id   uuid not null references devices(id) on delete cascade,
  label       text not null,          -- as typed, for display
  norm        text not null,          -- for grouping and for matching posts
  aisle       text,                   -- inferred where we can, never required
  alert       boolean not null default true,
  created_at  timestamptz not null default now(),
  filled_at   timestamptz,            -- stamped when the shop posts a match
  unique (shop_id, device_id, norm)
);
create index if not exists wants_shop_idx on wants (shop_id) where filled_at is null;
create index if not exists wants_match_idx on wants (shop_id, norm) where alert;

-- One normalisation rule, used by the unique index, the grouping and the
-- post matching alike. Two shoppers typing "kaju katli" and "Kaju Katli!"
-- are waiting for the same thing and must count as two, not as one each.
create or replace function norm_item(t text) returns text
language sql immutable as $$
  select nullif(btrim(regexp_replace(lower(coalesce(t, '')),
                                     '[^a-z0-9]+', ' ', 'g')), '')
$$;

-- What the shop is being asked for, most-wanted first. `label` is the most
-- recent spelling, which is the one a shopper will recognise.
create or replace function wants_for(p_shop_id uuid)
returns table (norm text, label text, shoppers bigint, aisle text,
               alerting bigint, last_at timestamptz)
language sql stable as $$
  select w.norm,
         (array_agg(w.label order by w.created_at desc))[1]                  as label,
         count(*)                                                           as shoppers,
         (array_agg(w.aisle order by w.created_at desc)
            filter (where w.aisle is not null))[1]                          as aisle,
         count(*) filter (where w.alert)                                     as alerting,
         max(w.created_at)                                                   as last_at
    from wants w
   where w.shop_id = p_shop_id and w.filled_at is null
   group by w.norm
   order by count(*) desc, max(w.created_at) desc
$$;

-- A follower who ASKED for this item is not "aisle off" — they are the single
-- most interested person on the list. This one clause is what makes a want
-- worth leaving: it outranks the aisle filter rather than restating it.
create or replace function recipients_for(p_post_id uuid)
returns table (device_id uuid, withheld text)
language sql stable as $$
  with p as (
    select po.*, s.daily_cap, s.min_age
      from posts po join shops s on s.id = po.shop_id
     where po.id = p_post_id
  )
  select f.device_id,
         case
           when f.muted then 'muted'
           when p.min_age is not null
                and (d.age_ok_to is null or d.age_ok_to < p.min_age)
             then 'age_unverified'
           when d.id is null or d.retired_at is not null or d.endpoint is null
             then 'no_device'
           when p.kind in ('sale','arrival')
                and not (p.aisle = any (f.aisles))
                and not exists (
                  select 1 from wants w
                   where w.shop_id   = p.shop_id
                     and w.device_id = f.device_id
                     and w.alert
                     and w.norm      = norm_item(p.name))
             then 'aisle_off'
           when (select count(*) from deliveries dl
                  where dl.device_id = f.device_id
                    and dl.shop_id   = p.shop_id
                    and dl.withheld is null
                    and dl.sent_at > now() - interval '24 hours') >= p.daily_cap
             then 'daily_cap'
           else null
         end as withheld
    from p
    join follows f on f.shop_id = p.shop_id
    left join devices d on d.id = f.device_id and d.retired_at is null
$$;

-- The provider's own words, kept next to the decision.
--
-- Every APNs and FCM failure reason was being flattened into one bucket before
-- it reached anybody: a wrong signing key, a token Apple has never heard of,
-- and a momentary HTTP/2 reset all arrived on the owner's screen as "the alert
-- service refused it — try again shortly". The first two are not transient and
-- retrying is the wrong advice. Diagnosing it meant reading the service log,
-- which the person running a shop cannot do.
alter table deliveries add column if not exists detail text;

-- ------------------------------------------------- posts that end by themselves
--
-- `ends` was only ever text — "Today, 9:00 PM", or whatever a browser's
-- datetime field produced. Readable, and impossible to compare against the
-- clock, so a sale stayed "on" until somebody pressed a button. A shelf that
-- says one thing while the app says another is the fastest way to lose a
-- shop's trust, and it was happening by default.
--
-- ends_at is an INSTANT. The phone converts the shopkeeper's local
-- "9:00 PM today" to one, so a shop in Monroe and a shop three time zones
-- away both expire when their own evening ends rather than when UTC says so.
-- `ends` stays for display: it is what the owner typed, in their words.
alter table posts add column if not exists ends_at timestamptz;
create index if not exists posts_expiring_idx on posts (ends_at)
  where status = 'active' and ends_at is not null;

-- 'expired' is a third state, distinct from 'ended'. Ended is a decision
-- somebody made; expired is the clock arriving. The owner is owed the
-- difference when looking back at what they posted.
alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check
  check (status in ('active','ended','expired'));

-- One rule for "has this run out", used by the sweep and by every read.
create or replace function expire_due_posts() returns integer
language sql as $$
  with done as (
    update posts set status = 'expired'
     where status = 'active' and ends_at is not null and ends_at <= now()
     returning 1
  ) select count(*)::int from done
$$;

-- --------------------------------------------------- shops: the editable bits
alter table shops add column if not exists phone text;
alter table shops add column if not exists note text;      -- a line about the shop
alter table shops add column if not exists updated_at timestamptz;

-- --------------------------------------------------- moderating the ask list
-- An owner can take an item off their own demand list. It is removed for THAT
-- shop only: wants are rows per (shop, device), so nothing here can reach
-- another shop's list, and a shopper who asked the same thing of a different
-- shop still has it. Hidden rather than deleted, so the same text cannot be
-- re-posted into the list five seconds later by the same device.
alter table wants add column if not exists hidden_at timestamptz;

create or replace function wants_for(p_shop_id uuid)
returns table (norm text, label text, shoppers bigint, aisle text,
               alerting bigint, last_at timestamptz)
language sql stable as $$
  select w.norm,
         (array_agg(w.label order by w.created_at desc))[1]                  as label,
         count(*)                                                           as shoppers,
         (array_agg(w.aisle order by w.created_at desc)
            filter (where w.aisle is not null))[1]                          as aisle,
         count(*) filter (where w.alert)                                     as alerting,
         max(w.created_at)                                                   as last_at
    from wants w
   where w.shop_id = p_shop_id and w.filled_at is null and w.hidden_at is null
   group by w.norm
   order by count(*) desc, max(w.created_at) desc
$$;
