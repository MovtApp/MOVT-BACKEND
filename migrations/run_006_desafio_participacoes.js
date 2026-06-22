/* Runner one-off para aplicar a migration 006_create_desafio_participacoes.sql.
 * Usa a mesma conexão/SSL do index.js. Idempotente (IF NOT EXISTS).
 * Uso: node migrations/run_006_desafio_participacoes.js
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
    const file = path.join(__dirname, "006_create_desafio_participacoes.sql");
    const ddl = fs.readFileSync(file, "utf8");

    console.log("→ Aplicando migration 006_create_desafio_participacoes.sql ...");
    await sql.unsafe(ddl);

    const [tbl] = await sql`
      SELECT relrowsecurity AS rls
      FROM pg_class
      WHERE relname = 'desafio_participacoes' AND relkind = 'r'
    `;
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'desafio_participacoes' ORDER BY ordinal_position
    `;

    if (!tbl) {
      console.error("✗ Tabela desafio_participacoes NÃO encontrada após a migration.");
      process.exit(1);
    }

    console.log("✓ Tabela desafio_participacoes criada/confirmada.");
    console.log("  RLS habilitado:", tbl.rls === true);
    console.log("  Colunas:", cols.map((c) => c.column_name).join(", "));
    await sql.end({ timeout: 5 });
    console.log("✅ Migration aplicada com sucesso.");
    process.exit(0);
  } catch (err) {
    console.error("✗ Falha ao aplicar a migration:", err.message);
    try {
      await sql.end({ timeout: 5 });
    } catch {}
    process.exit(1);
  }
})();
