// Diagnóstico READ-ONLY do vínculo Supabase Auth (supabase_uid).
// Não escreve nada. Descobre por que getUserAuthId() retorna null.
// Uso: node scripts/diag-supabase-link.cjs [id_us]
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const postgres = require("postgres");

const TARGET_ID = process.argv[2] ? parseInt(process.argv[2], 10) : 40;

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  prepare: false,
  idle_timeout: 5,
  connect_timeout: 30,
});

(async () => {
  const out = {};
  try {
    // 1. A tabela de mapeamento existe?
    const [mapTbl] = await sql`SELECT to_regclass('public.user_id_mapping') AS t`;
    out.user_id_mapping_table = mapTbl.t;

    // 2. Quais colunas relevantes existem em 'usuarios'?
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'usuarios'
        AND column_name IN ('supabase_uid','auth_user_id')
    `;
    out.usuarios_link_columns = cols.map((c) => c.column_name);

    // 3. Dados da conta alvo
    const [u] = await sql`SELECT * FROM usuarios WHERE id_us = ${TARGET_ID}`;
    if (u) {
      out.account = {
        id_us: u.id_us,
        email: u.email,
        role: u.role,
        supabase_uid: u.supabase_uid ?? "(coluna ausente)",
        auth_user_id: u.auth_user_id ?? "(coluna ausente)",
      };
    } else {
      out.account = `Nenhuma conta com id_us=${TARGET_ID}`;
    }

    // 4. Linha no user_id_mapping (se a tabela existir)
    if (mapTbl.t) {
      const m = await sql`SELECT * FROM user_id_mapping WHERE id_us = ${TARGET_ID}`;
      out.mapping_row = m.length ? m[0] : "(nenhum mapeamento)";
    }

    // 5. A conta existe no auth.users do Supabase? (lemos direto via SQL)
    if (u?.email) {
      try {
        const au = await sql`SELECT id, email, created_at FROM auth.users WHERE email = ${u.email}`;
        out.auth_users_match = au.length ? au.map((r) => ({ id: r.id, email: r.email })) : "(não existe em auth.users)";
      } catch (e) {
        out.auth_users_match = `Erro ao ler auth.users: ${e.message}`;
      }
    }

    // 6. Total de contas sem vínculo (panorama do problema)
    try {
      const [counts] = await sql`
        SELECT
          (SELECT count(*) FROM usuarios) AS total,
          (SELECT count(*) FROM usuarios u
             WHERE NOT EXISTS (SELECT 1 FROM user_id_mapping m WHERE m.id_us = u.id_us)) AS sem_mapeamento
      `;
      out.panorama = { total_contas: Number(counts.total), sem_mapeamento: Number(counts.sem_mapeamento) };
    } catch (e) {
      out.panorama = `n/d: ${e.message}`;
    }

    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("FALHA NO DIAGNÓSTICO:", err.message);
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
