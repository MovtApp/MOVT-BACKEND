/* Runner one-off para aplicar a migration 011_cref_data_registro.sql.
 * Usa a mesma conexão/SSL do index.js. Idempotente (ADD COLUMN IF NOT EXISTS).
 * Uso: node migrations/run_011_cref_data_registro.js
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
    const file = path.join(__dirname, "011_cref_data_registro.sql");
    const ddl = fs.readFileSync(file, "utf8");

    console.log("→ Aplicando migration 011_cref_data_registro.sql ...");
    await sql.unsafe(ddl);

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'usuarios' AND column_name = 'cref_data_registro'
    `;
    if (cols.length === 0) {
      console.error("✗ Coluna cref_data_registro ausente após a migration.");
      process.exit(1);
    }

    console.log("✓ Coluna cref_data_registro confirmada em usuarios.");
    await sql.end({ timeout: 5 });
    console.log("✅ Migration 011 aplicada com sucesso.");
    process.exit(0);
  } catch (err) {
    console.error("✗ Falha ao aplicar a migration:", err.message);
    try {
      await sql.end({ timeout: 5 });
    } catch {}
    process.exit(1);
  }
})();
