// One-time cleanup of user_id_mapping (Bug 1): remove orphan rows and enforce
// the Google account a041554a as owned ONLY by id_us 56.
// Approved line-by-line by the owner. Backs up deleted rows first, runs inside a
// single transaction, verifies the final state, and only then commits.
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

const GOOGLE_UID = "a041554a-cb8c-423d-8983-14224f9ca414";
const KEEP_ID = 56;

(async () => {
  const url = loadUrl(".env.local") || loadUrl(".env");
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 20 });
  try {
    const before = await sql`SELECT id_us, auth_user_id FROM user_id_mapping ORDER BY id_us`;

    // Rows that WILL be deleted (for the backup + report)
    const orphans = await sql`
      SELECT m.id_us, m.auth_user_id FROM user_id_mapping m
      LEFT JOIN usuarios u ON u.id_us = m.id_us
      WHERE u.id_us IS NULL ORDER BY m.id_us`;
    const googleExtra = await sql`
      SELECT id_us, auth_user_id FROM user_id_mapping
      WHERE auth_user_id = ${GOOGLE_UID} AND id_us <> ${KEEP_ID} AND id_us IN
        (SELECT id_us FROM usuarios) ORDER BY id_us`;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(__dirname, `_backup_user_id_mapping_${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ before_full: before, to_delete_orphans: orphans, to_delete_google_extra: googleExtra }, null, 2), "utf8");

    let result;
    await sql.begin(async (tx) => {
      // Group 1: orphan mappings (id_us not present in usuarios)
      const delOrphans = await tx`
        DELETE FROM user_id_mapping m
        WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id_us = m.id_us)
        RETURNING id_us, auth_user_id`;

      // Group 2: Google UID must belong only to id_us 56 (drop the typo dup 14)
      const delGoogle = await tx`
        DELETE FROM user_id_mapping
        WHERE auth_user_id = ${GOOGLE_UID} AND id_us <> ${KEEP_ID}
        RETURNING id_us, auth_user_id`;

      // Verify inside the tx before commit
      const remainingGoogle = await tx`SELECT id_us FROM user_id_mapping WHERE auth_user_id = ${GOOGLE_UID} ORDER BY id_us`;
      const remainingDupes = await tx`
        SELECT auth_user_id AS uid, count(*)::int AS n, array_agg(id_us ORDER BY id_us) AS ids
        FROM user_id_mapping WHERE auth_user_id IS NOT NULL
        GROUP BY auth_user_id HAVING count(*) > 1`;
      const [{ total }] = await tx`SELECT count(*)::int AS total FROM user_id_mapping`;

      const googleIds = remainingGoogle.map((r) => r.id_us);
      if (googleIds.length !== 1 || googleIds[0] !== KEEP_ID) {
        throw new Error(`ABORT: Google UID deveria mapear só ${KEEP_ID}, mas mapeia ${JSON.stringify(googleIds)}`);
      }
      if (remainingDupes.length !== 0) {
        throw new Error(`ABORT: ainda há UIDs duplicados: ${JSON.stringify(remainingDupes)}`);
      }

      result = {
        deleted_orphans: delOrphans.length,
        deleted_orphan_ids: delOrphans.map((r) => r.id_us),
        deleted_google_extra: delGoogle.length,
        deleted_google_ids: delGoogle.map((r) => r.id_us),
        remaining_total: total,
        google_now_owned_by: googleIds,
        remaining_dupes: remainingDupes.length,
      };
    });

    console.log("BACKUP:", backupFile);
    console.log("RESULT:", JSON.stringify(result, null, 2));
    console.log("COMMIT OK");
    await sql.end({ timeout: 5 });
  } catch (err) {
    console.error("ROLLBACK / FALHA:", err.message);
    try { await sql.end({ timeout: 2 }); } catch {}
    process.exit(1);
  }
})();
