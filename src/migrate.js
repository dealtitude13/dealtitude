import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "./db.js";
const here = dirname(fileURLToPath(import.meta.url));
const ddl = readFileSync(join(here, "../db/schema.sql"), "utf8");
await sql.unsafe(ddl);
console.log("schema applied");
await sql.end();
