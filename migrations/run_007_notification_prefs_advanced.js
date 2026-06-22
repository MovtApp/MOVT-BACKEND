/* Runner one-off para aplicar a migration 007_notification_prefs_advanced.sql.
 * Usa a mesma conexão/SSL do index.js. Idempotente (ADD COLUMN IF NOT EXISTS).
 * Uso: node migrations/run_007_notification_prefs_advanced.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const postgres = require("postgres");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL não definido no ambiente (.env).");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: { rejectUnauthorized: false },
  max: 1,
  connect_timeout: 30,
  prepare: false,
  onnotice: () => {},
});

const EXPECTED = [
  "hide_message_preview",
  "quiet_hours_enabled",
  "quiet_start",
  "quiet_end",
  "timezone",
];

(async () => {
  try {
    const file = path.join(__dirname, "007_notification_prefs_advanced.sql");
    const ddl = fs.readFileSync(file, "utf8");

    console.log("→ Aplicando migration 007_notification_prefs_advanced.sql ...");
    await sql.unsafe(ddl);

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'notification_prefs' ORDER BY ordinal_position
    `;
    const names = cols.map((c) => c.column_name);
    const missing = EXPECTED.filter((c) => !names.includes(c));

    if (missing.length > 0) {
      console.error("✗ Colunas ausentes após a migration:", missing.join(", "));
      process.exit(1);
    }

    console.log("✓ Colunas confirmadas:", names.join(", "));
    await sql.end({ timeout: 5 });
    console.log("✅ Migration 007 aplicada com sucesso.");
    process.exit(0);
  } catch (err) {
    console.error("✗ Falha ao aplicar a migration:", err.message);
    try {
      await sql.end({ timeout: 5 });
    } catch {}
    process.exit(1);
  }
})();
