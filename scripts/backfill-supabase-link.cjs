// Backfill do vínculo Supabase Auth: liga contas existentes (sem mapeamento)
// ao usuário que JÁ existe em auth.users, casando por e-mail. Idempotente.
// Uso: node scripts/backfill-supabase-link.cjs
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const postgres = require("postgres");

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  prepare: false,
  idle_timeout: 5,
  connect_timeout: 30,
});

(async () => {
  try {
    // Pré-visualização do que será ligado
    const preview = await sql`
      SELECT u.id_us, u.email, a.id AS auth_user_id
      FROM usuarios u
      JOIN auth.users a ON a.email = u.email
      WHERE NOT EXISTS (SELECT 1 FROM user_id_mapping m WHERE m.id_us = u.id_us)
    `;
    console.log("A ligar:", JSON.stringify(preview, null, 2));

    // 1. Cria o mapeamento que faltava
    const inserted = await sql`
      INSERT INTO user_id_mapping (id_us, auth_user_id)
      SELECT u.id_us, a.id
      FROM usuarios u
      JOIN auth.users a ON a.email = u.email
      WHERE NOT EXISTS (SELECT 1 FROM user_id_mapping m WHERE m.id_us = u.id_us)
      RETURNING id_us, auth_user_id
    `;
    console.log(`Mapeamentos criados: ${inserted.length}`);

    // 2. Consistência: preenche as colunas em 'usuarios'
    const updated = await sql`
      UPDATE usuarios u
      SET supabase_uid = a.id, auth_user_id = a.id
      FROM auth.users a
      WHERE a.email = u.email AND u.supabase_uid IS NULL
      RETURNING u.id_us
    `;
    console.log(`Colunas em 'usuarios' preenchidas: ${updated.length}`);

    // Verificação final
    const [counts] = await sql`
      SELECT
        (SELECT count(*) FROM usuarios) AS total,
        (SELECT count(*) FROM usuarios u
           WHERE NOT EXISTS (SELECT 1 FROM user_id_mapping m WHERE m.id_us = u.id_us)) AS sem_mapeamento
    `;
    console.log("Panorama final:", { total: Number(counts.total), sem_mapeamento: Number(counts.sem_mapeamento) });
  } catch (err) {
    console.error("FALHA NO BACKFILL:", err.message);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
