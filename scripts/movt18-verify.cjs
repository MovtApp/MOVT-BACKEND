// MOVT-18 verificação READ-ONLY: os dois logins resolvem pro MESMO id_us e as
// mesmas corridas? Espelha as consultas reais do backend.
//   email/senha: /api/login  -> WHERE email = $email  (match exato)
//   google:      handleSocialLogin -> WHERE supabase_uid = $uid OR LOWER(email)=LOWER($email)
// Uso: node scripts/movt18-verify.cjs

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

const EMAIL = "josulima90@gmail.com";
const UID = "a041554a-cb8c-423d-8983-14224f9ca414";

(async () => {
  const url = loadUrl();
  if (!url) { console.error("Sem DATABASE_URL."); process.exit(1); }
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 30 });
  const out = {};
  try {
    // 1) resolução de cada login
    const emailSenha = await sql`SELECT id_us, ativo, email FROM usuarios WHERE email = ${EMAIL}`;
    const google = await sql`SELECT id_us, ativo, email FROM usuarios WHERE supabase_uid = ${UID} OR LOWER(email) = LOWER(${EMAIL})`;
    out.login_email_senha_resolve_para = emailSenha.map((r) => ({ id_us: r.id_us, ativo: r.ativo }));
    out.login_google_resolve_para = google.map((r) => ({ id_us: r.id_us, ativo: r.ativo }));
    const idES = emailSenha.map((r) => r.id_us).sort();
    const idG = google.map((r) => r.id_us).sort();
    out.mesmo_id_us = idES.length === 1 && idG.length === 1 && idES[0] === idG[0];

    // 2) corridas / treinos por id_us (14 e 56)
    const w = await sql`
      SELECT id_us,
             count(*) FILTER (WHERE tipo = 'Corrida')::int   AS corridas,
             count(*) FILTER (WHERE tipo = 'Ciclismo')::int  AS ciclismo,
             count(*)::int                                    AS treinos_total
      FROM user_workouts WHERE id_us IN (14, 56) GROUP BY id_us ORDER BY id_us
    `;
    out.workouts_por_id = w;

    // 3) as corridas efetivas do id resolvido
    const alvo = out.mesmo_id_us ? idES[0] : (idG[0] ?? idES[0]);
    const corridas = await sql`
      SELECT to_char(data, 'YYYY-MM-DD HH24:MI') AS quando, tipo, distancia_km, duracao_seg
      FROM user_workouts WHERE id_us = ${alvo} AND tipo = 'Corrida' ORDER BY data DESC
    `;
    out.id_us_final = alvo;
    out.corridas_desse_id = corridas;

    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("FALHA:", err.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
