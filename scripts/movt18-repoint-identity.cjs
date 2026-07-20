// MOVT-18 (passo final) — Move a identidade Supabase (uid do Google) para o id_us
// CANÔNICO, onde os dados já estão. Espelha exatamente o linkSupabaseIdentity de
// produção (index.js): solta o uid de qualquer OUTRO id_us (colunas de usuarios +
// user_id_mapping) e vincula ao canônico, respeitando o UNIQUE(auth_user_id).
//
// DRY-RUN por padrão. Aplicar: --apply --sim-eu-fiz-backup.
// Uso: node scripts/movt18-repoint-identity.cjs [--canonical 56] [--uid a041554a-...] [--apply --sim-eu-fiz-backup]

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
const hasFlag = (f) => process.argv.includes(f);

const CANONICAL = parseInt(argValue("--canonical") || "56", 10);
const UID = argValue("--uid") || "a041554a-cb8c-423d-8983-14224f9ca414";
const APPLY = hasFlag("--apply");

(async () => {
  const url = loadUrl();
  if (!url) { console.error("Sem DATABASE_URL."); process.exit(1); }
  if (!Number.isInteger(CANONICAL)) { console.error("--canonical inválido."); process.exit(1); }
  if (APPLY && !hasFlag("--sim-eu-fiz-backup")) {
    console.error("--apply exige --sim-eu-fiz-backup. Abortando."); process.exit(1);
  }
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 30 });

  try {
    // estado atual
    const donoUsuarios = await sql`SELECT id_us, email, ativo, supabase_uid, auth_user_id FROM usuarios WHERE auth_user_id = ${UID} ORDER BY id_us`;
    const donoMapping = await sql`SELECT id_us FROM user_id_mapping WHERE auth_user_id = ${UID} ORDER BY id_us`;
    const [alvo] = await sql`SELECT id_us, email, ativo, supabase_uid, auth_user_id FROM usuarios WHERE id_us = ${CANONICAL}`;
    if (!alvo) throw new Error(`Canônico id_us=${CANONICAL} não existe.`);

    const estado = {
      uid: UID, canonical: CANONICAL,
      antes: {
        uid_em_usuarios: donoUsuarios,
        uid_em_user_id_mapping: donoMapping.map((r) => r.id_us),
        canonico: alvo,
      },
    };

    if (!APPLY) {
      estado.modo = "DRY-RUN";
      estado.plano = [
        `Soltar ${UID} de qualquer id_us <> ${CANONICAL} (usuarios.supabase_uid/auth_user_id = NULL; remover do user_id_mapping).`,
        `Vincular ${UID} ao id_us ${CANONICAL} (usuarios + user_id_mapping).`,
      ];
      console.log(JSON.stringify(estado, null, 2));
      console.log("\nDRY-RUN — nada foi escrito. Rode com --apply --sim-eu-fiz-backup.");
      await sql.end({ timeout: 5 });
      return;
    }

    // APPLY — espelha linkSupabaseIdentity(CANONICAL, UID) numa transação
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let result;
    await sql.begin(async (tx) => {
      // 1) soltar o uid de qualquer outro id_us (exclusividade 1:1)
      const soltosU = await tx`
        UPDATE usuarios SET supabase_uid = NULL, auth_user_id = NULL
        WHERE auth_user_id = ${UID} AND id_us <> ${CANONICAL}
        RETURNING id_us`;
      const soltosM = await tx`
        DELETE FROM user_id_mapping WHERE auth_user_id = ${UID} AND id_us <> ${CANONICAL}
        RETURNING id_us`;

      // 2) vincular ao canônico (usuarios + upsert no mapping)
      await tx`UPDATE usuarios SET supabase_uid = ${UID}, auth_user_id = ${UID} WHERE id_us = ${CANONICAL}`;
      const [ex] = await tx`SELECT 1 AS x FROM user_id_mapping WHERE id_us = ${CANONICAL}`;
      if (ex) await tx`UPDATE user_id_mapping SET auth_user_id = ${UID} WHERE id_us = ${CANONICAL}`;
      else await tx`INSERT INTO user_id_mapping (id_us, auth_user_id) VALUES (${CANONICAL}, ${UID})`;

      // 3) verificar: uid mora só no canônico, nos dois lugares
      const uU = await tx`SELECT id_us FROM usuarios WHERE auth_user_id = ${UID}`;
      const uM = await tx`SELECT id_us FROM user_id_mapping WHERE auth_user_id = ${UID}`;
      const okU = uU.length === 1 && Number(uU[0].id_us) === CANONICAL;
      const okM = uM.length === 1 && Number(uM[0].id_us) === CANONICAL;
      if (!okU || !okM) {
        throw new Error(`ABORT: uid deveria estar só em ${CANONICAL}. usuarios=${JSON.stringify(uU.map(r=>r.id_us))} mapping=${JSON.stringify(uM.map(r=>r.id_us))}`);
      }
      result = { soltos_de_usuarios: soltosU.map((r) => r.id_us), soltos_do_mapping: soltosM.map((r) => r.id_us), vinculado_a: CANONICAL };
    });

    const backupFile = path.join(__dirname, `_backup_movt18_identity_${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ estado_antes: estado.antes, uid: UID, canonical: CANONICAL }, null, 2), "utf8");
    console.log("BACKUP:", backupFile);
    console.log("RESULT:", JSON.stringify(result, null, 2));
    console.log("COMMIT OK — identidade movida para", CANONICAL);
    await sql.end({ timeout: 5 });
  } catch (err) {
    console.error("ROLLBACK / FALHA:", err.message);
    try { await sql.end({ timeout: 2 }); } catch {}
    process.exit(1);
  }
})();
