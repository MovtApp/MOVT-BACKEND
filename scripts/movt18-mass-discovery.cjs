// MOVT-18 em massa — DESCOBERTA READ-ONLY de TODAS as contas duplicadas
// (email/senha + Google do mesmo dono). Não escreve nada.
//
// Cruza 3 sinais e une os grupos por id_us compartilhado:
//   A) backup do user_id_mapping (--backup): auth_user_id -> vários id_us (pega typos de email)
//   B) mesmo email normalizado em usuarios -> vários id_us
//   C) auth.users: identidade Google cujo email casa com uma conta email/senha em OUTRO id_us
//
// Por grupo: contas (email, ativo, tem_senha, uid), peso de dados por id_us,
// email do Google, canônico sugerido pela régua (email == email do Google) e flag de ambiguidade.
//
// Uso: node scripts/movt18-mass-discovery.cjs [--backup scripts/_backup_user_id_mapping_*.json]

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
const argValue = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const norm = (e) => (e || "").trim().toLowerCase();

// colunas de usuário reais (peso de dados) — do diagnóstico já validado
const USER_COLS = [
  ["activities", "id_us"], ["agendamentos", "id_usuario"], ["community_members", "id_us"],
  ["dados_saude", "id_us"], ["desafio_participacoes", "id_us"], ["dietas", "id_us"],
  ["follows", "followed_user_id"], ["follows", "follower_user_id"],
  ["notifications", "sender_id"], ["notifications", "user_id"],
  ["post_comments", "id_us"], ["post_likes", "id_us"], ["post_saves", "id_us"],
  ["posts", "id_us"], ["push_tokens", "user_id"], ["user_mission", "id_us"], ["user_workouts", "id_us"],
];

// union-find
class UF {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); while (this.p.get(x) !== x) { this.p.set(x, this.p.get(this.p.get(x))); x = this.p.get(x); } return x; }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}

(async () => {
  const url = loadUrl();
  if (!url) { console.error("Sem DATABASE_URL."); process.exit(1); }
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 30 });
  const out = { gerado_em: new Date().toISOString(), fontes: {}, grupos: [] };

  try {
    const usuarios = await sql`SELECT id_us, email, ativo, (senha IS NOT NULL) AS tem_senha, auth_user_id, supabase_uid FROM usuarios`;
    const uById = new Map(usuarios.map((u) => [Number(u.id_us), u]));
    const idsByEmail = new Map();
    for (const u of usuarios) { const e = norm(u.email); if (!e) continue; if (!idsByEmail.has(e)) idsByEmail.set(e, []); idsByEmail.get(e).push(Number(u.id_us)); }

    let authUsers = [];
    try { authUsers = await sql`SELECT id, email FROM auth.users`; } catch (e) { out.fontes.auth_users_erro = e.message; }
    const authEmailByUid = new Map(authUsers.map((a) => [a.id, norm(a.email)]));

    const uf = new UF();
    const seed = (ids) => { const v = [...new Set(ids.map(Number))].filter((id) => uById.has(id)); for (let i = 1; i < v.length; i++) uf.union(v[0], v[i]); return v; };

    // A) backup
    let aGroups = 0;
    const backupArg = argValue("--backup");
    if (backupArg) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.isAbsolute(backupArg) ? backupArg : path.join(__dirname, "..", backupArg), "utf8"));
        const rows = raw.before_full || raw.before || [];
        const byUid = new Map();
        for (const m of rows) { if (!m.auth_user_id) continue; if (!byUid.has(m.auth_user_id)) byUid.set(m.auth_user_id, new Set()); byUid.get(m.auth_user_id).add(Number(m.id_us)); }
        for (const ids of byUid.values()) { const v = seed([...ids]); if (v.length > 1) aGroups++; }
        out.fontes.backup = backupArg;
      } catch (e) { out.fontes.backup_erro = e.message; }
    } else out.fontes.backup_aviso = "sem --backup: pode perder splits por typo de email";

    // B) mesmo email
    let bGroups = 0;
    for (const ids of idsByEmail.values()) if (ids.length > 1) { seed(ids); bGroups++; }

    // C) auth.users cross-ref: identidade Google (email X) vs conta email/senha com email X em outro id_us
    let cGroups = 0;
    for (const [uid, aemail] of authEmailByUid) {
      if (!aemail) continue;
      const linked = usuarios.filter((u) => u.auth_user_id === uid).map((u) => Number(u.id_us));
      const byEmail = idsByEmail.get(aemail) || [];
      const v = seed([...linked, ...byEmail]);
      if (v.length > 1) cGroups++;
    }
    out.fontes.grupos_por_sinal = { A_backup: aGroups, B_email: bGroups, C_authusers: cGroups };

    // consolida grupos (>=2 contas vivas)
    const buckets = new Map();
    for (const id of uById.keys()) { const r = uf.find(id); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(id); }
    const grupos = [...buckets.values()].filter((g) => g.length > 1);

    // peso de dados por id_us (17 queries no total, sobre todos os ids envolvidos)
    const allIds = [].concat(...grupos);
    const weight = new Map();
    if (allIds.length) {
      for (const [t, c] of USER_COLS) {
        try {
          const rows = await sql`SELECT ${sql(c)} AS id, count(*)::int AS n FROM ${sql(t)} WHERE ${sql(c)} = ANY(${allIds}) GROUP BY ${sql(c)}`;
          for (const r of rows) weight.set(Number(r.id), (weight.get(Number(r.id)) || 0) + r.n);
        } catch {}
      }
    }

    // monta relatório por grupo
    let ambiguos = 0;
    for (const ids of grupos) {
      const idsSorted = ids.slice().sort((a, b) => a - b);
      // emails do Google no grupo (via auth.users pelos uids ligados aos id_us)
      const googleEmails = new Set();
      for (const id of idsSorted) { const uid = uById.get(id).auth_user_id; if (uid && authEmailByUid.has(uid)) googleEmails.add(authEmailByUid.get(uid)); }
      // e também: qualquer auth.users cujo email casa com um email do grupo
      const groupEmails = new Set(idsSorted.map((id) => norm(uById.get(id).email)).filter(Boolean));
      for (const [uid, ae] of authEmailByUid) if (groupEmails.has(ae)) googleEmails.add(ae);

      // régua: canônico = id_us cujo email normalizado == email do Google
      let canonicais = [];
      if (googleEmails.size === 1) {
        const ge = [...googleEmails][0];
        canonicais = idsSorted.filter((id) => norm(uById.get(id).email) === ge);
      }
      const canonical_sugerido = canonicais.length === 1 ? canonicais[0] : null;
      const comDados = idsSorted.filter((id) => (weight.get(id) || 0) > 0);
      const ambiguo = canonical_sugerido == null || googleEmails.size !== 1;
      if (ambiguo) ambiguos++;

      out.grupos.push({
        ids: idsSorted,
        google_emails: [...googleEmails],
        canonical_sugerido,
        ambiguo,
        contas: idsSorted.map((id) => {
          const u = uById.get(id);
          return { id_us: id, email: u.email, ativo: u.ativo, tem_senha: u.tem_senha, tem_uid: !!u.auth_user_id, dados: weight.get(id) || 0 };
        }),
      });
    }

    out.resumo = {
      total_grupos: grupos.length,
      total_contas: allIds.length,
      ambiguos,
      nao_ambiguos: grupos.length - ambiguos,
    };
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("FALHA:", err.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
