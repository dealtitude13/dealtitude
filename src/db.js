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
});

export async function healthy() {
  try { await sql`select 1`; return true; } catch { return false; }
}
