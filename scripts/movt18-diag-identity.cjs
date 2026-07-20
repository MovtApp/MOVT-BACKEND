// MOVT-18 — Diagnóstico READ-ONLY da identidade (login) das contas do merge.
// Usa o mesmo loadUrl() dos scripts movt18 (.env.local primeiro = pooler que
// funciona). Mostra, por id_us: vínculo em usuarios, linha no user_id_mapping e
// correspondência em auth.users. Também procura auth.users pelos dois emails.
//
// Uso: node scripts/movt18-diag-identity.cjs [id_us...]   (default: 14 56)

const path = require("path");
const fs = require("fs");
const postgres = require("postgres");

function loadUrl() {
  for (const file of [".env.local", ".env"]) {
    try {
      const txt = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      const v = m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
      if (v) return v;
    } catch {}
  }
  return process.env.DATABASE_URL || null;
}

const ids = process.argv.slice(2).map((n) => parseInt(n, 10)).filter(Boolean);
const TARGETS = ids.length ? ids : [14, 56];

(async () => {
  const url = loadUrl();
  if (!url) { console.error("Sem DATABASE_URL."); process.exit(1); }
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 30 });
  const out = { gerado_em: new Date().toISOString(), contas: [] };
  try {
    for (const id of TARGETS) {
      const [u] = await sql`SELECT * FROM usuarios WHERE id_us = ${id}`;
      const conta = { id_us: id };
      if (!u) { conta.erro = "não existe"; out.contas.push(conta); continue; }
      conta.email = u.email;
      conta.ativo = u.ativo;
      conta.tem_senha = !!u.senha;               // login email/senha exige senha
      conta.supabase_uid = u.supabase_uid ?? null;
      conta.auth_user_id = u.auth_user_id ?? null;
      const m = await sql`SELECT auth_user_id FROM user_id_mapping WHERE id_us = ${id}`;
      conta.user_id_mapping = m.length ? m[0].auth_user_id : "(sem linha)";
      // auth.users por email exato desta conta
      try {
        const au = await sql`SELECT id, email FROM auth.users WHERE lower(email) = lower(${u.email})`;
        conta.auth_users_por_email = au.length ? au.map((r) => ({ id: r.id, email: r.email })) : "(nenhum)";
      } catch (e) { conta.auth_users_por_email = `erro: ${e.message}`; }
      out.contas.push(conta);
    }

    // Panorama: auth.users com os dois emails (certo e typo) do dono
    try {
      const au = await sql`
        SELECT id, email, created_at FROM auth.users
        WHERE lower(email) IN ('josulima90@gmail.com','josulima90@gmail.comm')
        ORDER BY email
      `;
      out.auth_users_do_dono = au.map((r) => ({ id: r.id, email: r.email }));
    } catch (e) { out.auth_users_do_dono = `erro: ${e.message}`; }

    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("FALHA:", err.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
