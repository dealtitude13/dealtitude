import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

/* ssl: Neon, Supabase and Render all require it; a local socket does not. */
const local = /localhost|127\.0\.0\.1|^postgres:\/\/[^@]*@\/|host=\/tmp/.test(
  process.env.DATABASE_URL);

export const sql = postgres(process.env.DATABASE_URL, {
  ssl: local ? false : "require",
  max: Number(process.env.PG_POOL || 8),
  idle_timeout: 20,
  connect_timeout: 15,
  transform: { undefined: null },

  /* The schema is applied on every boot and is idempotent by design, so it
     emits a NOTICE for every object that already exists — around thirty of
     them, each printed as a multi-line object. That volume is not harmless:
     it buries anything that actually matters in the one log a deploy gets
     looked at in. So the benign "already exists / already a member" codes are
     dropped and everything else still prints. */
  onnotice: (n) => {
    const benign = new Set([
      "42710",  // object already exists (extension, constraint)
      "42P07",  // relation already exists
      "42701",  // column already exists
      "42P06",  // schema already exists
      "42704",  // undefined object, from a DROP ... IF EXISTS
    ]);
    if (benign.has(n?.code)) return;
    console.warn(`[pg ${n?.severity || "NOTICE"}] ${n?.message || n}`);
  },
});

export async function healthy() {
  try { await sql`select 1`; return true; } catch { return false; }
}
