require("dotenv").config();
const postgres = require("postgres");
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false } });
async function migrate() {
  try {
    await sql`ALTER TABLE academias ADD COLUMN IF NOT EXISTS mp_public_key TEXT`;
    await sql`ALTER TABLE academias ADD COLUMN IF NOT EXISTS mp_access_token TEXT`;
    console.log("Columns added to academias");
  } catch (e) { console.error(e); }
  finally { process.exit(0); }
}
migrate();
