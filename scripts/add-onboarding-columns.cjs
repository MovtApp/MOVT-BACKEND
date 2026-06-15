// One-off: garante as colunas de dados pessoais (onboarding) na tabela usuarios.
// Idempotente (ADD COLUMN IF NOT EXISTS). Uso: node scripts/add-onboarding-columns.cjs
require("dotenv").config();
const postgres = require("postgres");
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, prepare: false });

(async () => {
  try {
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS genero TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS idade INTEGER DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS altura NUMERIC DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS peso NUMERIC DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS objetivo TEXT DEFAULT NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nivel TEXT DEFAULT NULL`;
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'usuarios'
        AND column_name IN ('genero','idade','altura','peso','objetivo','nivel','onboarding_completed','phone_verified')
      ORDER BY column_name
    `;
    console.log("✅ Colunas presentes:", cols.map((c) => c.column_name).join(", "));
  } catch (err) {
    console.error("❌ Erro:", err.message);
  } finally {
    await sql.end();
  }
})();
