// Fix #8 (a): enforce 1 supabase auth_user_id -> 1 usuario at the DB level.
// Safe to run only after duplicates are cleaned (remaining_dupes must be 0).
// Idempotent: skips if the constraint already exists. Verifies no dupes first.
const path = require("path");
const fs = require("fs");
const postgres = require("postgres");

function loadUrl(file) {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const m = txt.match(/^DATABASE_URL=(.*)$/m);
    return m ? (m[1].trim().replace(/^["']|["']$/g, "") || null) : null;
  } catch { return null; }
}

(async () => {
  const url = loadUrl(".env.local") || loadUrl(".env");
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 20 });
  try {
    const dupes = await sql`
      SELECT auth_user_id AS uid, count(*)::int AS n
      FROM user_id_mapping WHERE auth_user_id IS NOT NULL
      GROUP BY auth_user_id HAVING count(*) > 1`;
    if (dupes.length > 0) {
      throw new Error(`ABORT: ainda há duplicados, não posso criar UNIQUE: ${JSON.stringify(dupes)}`);
    }

    const [exists] = await sql`
      SELECT 1 AS x FROM pg_constraint WHERE conname = 'user_id_mapping_auth_user_id_key'`;
    if (exists) {
      console.log("SKIP: constraint user_id_mapping_auth_user_id_key já existe");
    } else {
      await sql`ALTER TABLE user_id_mapping ADD CONSTRAINT user_id_mapping_auth_user_id_key UNIQUE (auth_user_id)`;
      console.log("OK: UNIQUE(auth_user_id) criada");
    }
    await sql.end({ timeout: 5 });
  } catch (err) {
    console.error("FALHA:", err.message);
    try { await sql.end({ timeout: 2 }); } catch {}
    process.exit(1);
  }
})();
