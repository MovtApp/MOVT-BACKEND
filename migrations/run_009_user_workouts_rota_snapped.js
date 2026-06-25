/* Runner one-off para aplicar a migration 009_user_workouts_rota_snapped.sql.
 * Usa a mesma conexão/SSL do index.js. Idempotente (ADD COLUMN IF NOT EXISTS).
 * Uso: node migrations/run_009_user_workouts_rota_snapped.js
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

(async () => {
  try {
    const file = path.join(__dirname, "009_user_workouts_rota_snapped.sql");
    const ddl = fs.readFileSync(file, "utf8");

    console.log("→ Aplicando migration 009_user_workouts_rota_snapped.sql ...");
    await sql.unsafe(ddl);

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_workouts' AND column_name = 'rota_snapped'
    `;
    if (cols.length === 0) {
      console.error("✗ Coluna rota_snapped ausente após a migration.");
      process.exit(1);
    }

    console.log("✓ Coluna rota_snapped confirmada em user_workouts.");
    await sql.end({ timeout: 5 });
    console.log("✅ Migration 009 aplicada com sucesso.");
    process.exit(0);
  } catch (err) {
    console.error("✗ Falha ao aplicar a migration:", err.message);
    try {
      await sql.end({ timeout: 5 });
    } catch {}
    process.exit(1);
  }
})();
