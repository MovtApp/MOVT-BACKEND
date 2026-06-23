/* Runner one-off para aplicar a migration 008_dados_saude_client_id.sql.
 * Usa a mesma conexão/SSL do index.js. Idempotente (ADD COLUMN/INDEX IF NOT EXISTS).
 * Uso: node migrations/run_008_dados_saude_client_id.js
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
    const file = path.join(__dirname, "008_dados_saude_client_id.sql");
    const ddl = fs.readFileSync(file, "utf8");

    console.log("→ Aplicando migration 008_dados_saude_client_id.sql ...");
    await sql.unsafe(ddl);

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'dados_saude' AND column_name = 'client_id'
    `;
    if (cols.length === 0) {
      console.error("✗ Coluna client_id ausente após a migration.");
      process.exit(1);
    }

    console.log("✓ Coluna client_id confirmada em dados_saude.");
    await sql.end({ timeout: 5 });
    console.log("✅ Migration 008 aplicada com sucesso.");
    process.exit(0);
  } catch (err) {
    console.error("✗ Falha ao aplicar a migration:", err.message);
    try {
      await sql.end({ timeout: 5 });
    } catch {}
    process.exit(1);
  }
})();
