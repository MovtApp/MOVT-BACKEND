// MOVT-18 — Diagnóstico READ-ONLY das contas duplicadas ("1 corrida vs 5 corridas").
// NÃO escreve nada. Mede o tamanho do problema e descobre, dinamicamente, TODA
// tabela/coluna que referencia os id_us duplicados — sem chutar nomes de coluna
// (o FK de usuário é inconsistente: id_us, follower_user_id, trainer_id, ...).
//
// Uso:
//   node scripts/movt18-diag-duplicate-accounts.cjs [--backup scripts/_backup_user_id_mapping_*.json]
//
// Fontes de "grupo duplicado":
//   1) Mesmo email normalizado com >1 id_us em `usuarios` (migration 004).
//   2) (opcional) Backup do user_id_mapping pré-limpeza: mesmo auth_user_id → vários
//      id_us. É assim que se acha o caso do Google (14 vs 56), que tem email com typo
//      e por isso NÃO cai na regra (1).
//
// Saída:
//   - Relatório JSON no stdout (grupos + contagem de dados por id_us por tabela).
//   - scripts/movt18-plan.SUGGESTED.json — esqueleto do plano de merge p/ você PREENCHER
//     o canônico de cada grupo (a escolha é MANUAL, nunca automática).

const path = require("path");
const fs = require("fs");
const postgres = require("postgres");

// ---- conexão (mesmo padrão dos outros scripts) --------------------------------
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

const IDENT = /^[a-z_][a-z0-9_]*$/i; // valida identificadores vindos do information_schema

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

(async () => {
  const url = loadUrl();
  if (!url) {
    console.error("Sem DATABASE_URL (.env.local / .env). Abortando.");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 30 });
  const out = { gerado_em: new Date().toISOString(), grupos: [], varredura: {} };

  try {
    // --- 1) grupos por email normalizado -------------------------------------
    const byEmail = await sql`
      SELECT lower(trim(email)) AS chave, array_agg(id_us ORDER BY id_us) AS ids
      FROM usuarios
      WHERE email IS NOT NULL AND trim(email) <> ''
      GROUP BY lower(trim(email))
      HAVING count(*) > 1
    `;
    const grupos = new Map(); // chave -> Set(id_us)
    for (const r of byEmail) grupos.set(`email:${r.chave}`, new Set(r.ids.map(Number)));

    // --- 2) grupos pelo backup do user_id_mapping (auth_user_id -> vários id_us)
    const backupArg = argValue("--backup");
    if (backupArg) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.isAbsolute(backupArg) ? backupArg : path.join(__dirname, "..", backupArg), "utf8"));
        const rows = raw.before_full || raw.before || [];
        const byUid = new Map();
        for (const m of rows) {
          if (!m.auth_user_id) continue;
          if (!byUid.has(m.auth_user_id)) byUid.set(m.auth_user_id, new Set());
          byUid.get(m.auth_user_id).add(Number(m.id_us));
        }
        for (const [uid, ids] of byUid) if (ids.size > 1) grupos.set(`uid:${uid}`, ids);
        out.backup_usado = backupArg;
      } catch (e) {
        out.backup_erro = `Não li o backup (${backupArg}): ${e.message}`;
      }
    } else {
      out.backup_aviso = "Rode com --backup scripts/_backup_user_id_mapping_*.json para achar os splits por auth_user_id (caso Google 14 vs 56).";
    }

    // Conjunto de todos os id_us envolvidos (só os que ainda existem em usuarios)
    const todosIds = new Set();
    for (const s of grupos.values()) for (const id of s) todosIds.add(id);
    const existentes = new Set(
      (await sql`SELECT id_us FROM usuarios WHERE id_us = ANY(${[...todosIds]})`).map((r) => Number(r.id_us))
    );

    // --- 3) varredura dinâmica: quais (tabela.coluna) contêm esses id_us ------
    // Todas as colunas inteiras de tabelas base do schema public.
    const cols = await sql`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('integer','bigint','smallint')
      ORDER BY c.table_name, c.column_name
    `;
    // PK de cada tabela — uma PK NUNCA é re-apontada (é a linha, não uma referência).
    const pks = await sql`
      SELECT c.relname AS t, a.attname AS col
      FROM pg_index ix
      JOIN pg_class c ON c.oid = ix.indrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ix.indisprimary AND n.nspname = 'public'
    `;
    const pkSet = new Set(pks.map((r) => `${r.t}.${r.col}`));

    // Nome que É de fato referência a um usuário. O resto do scan por valor é ruído
    // (PKs, kcal, gym_id, id_agendamento, ...) e NÃO pode entrar no merge.
    const USER_REF = /^(id_us|user_id|usuario_id|id_usuario|follower_user_id|followed_user_id|sender_id|receiver_id|destinatario_id|remetente_id|autor_id|owner_id|aluno_id|personal_id|trainer_id|id_trainer|criado_por|created_by)$/i;
    // Tabelas que NÃO entram no merge automático (identidade e backups).
    const EXCLUI_TABELA = (t) => t === "user_id_mapping" || /_backup$/.test(t) || /_bkp$/.test(t);

    const alvo = [...existentes];
    const refs = [];      // colunas de usuário de verdade (candidatas ao plano)
    const suspeitos = []; // value-matches cujo NOME não é de usuário — só p/ conferência
    for (const { table_name, column_name } of cols) {
      if (!IDENT.test(table_name) || !IDENT.test(column_name)) continue;
      if (table_name === "usuarios" && column_name === "id_us") continue;
      try {
        const rows = await sql`
          SELECT ${sql(column_name)} AS id_us, count(*)::int AS n
          FROM ${sql(table_name)}
          WHERE ${sql(column_name)} = ANY(${alvo})
          GROUP BY ${sql(column_name)}
        `;
        if (!rows.length) continue;
        const counts = {};
        for (const r of rows) counts[r.id_us] = r.n;
        const ehPk = pkSet.has(`${table_name}.${column_name}`);
        if (USER_REF.test(column_name) && !ehPk) {
          refs.push({ table: table_name, column: column_name, counts });
        } else {
          suspeitos.push({ table: table_name, column: column_name, counts, motivo: ehPk ? "é PK (ignorado)" : "nome não é de usuário (ignorado)" });
        }
      } catch {
        // coluna não comparável / sem permissão — ignora
      }
    }
    out.varredura.colunas_de_usuario = refs;
    out.varredura.suspeitos_ignorados_no_plano = suspeitos;

    // --- 4) monta os grupos com dados por id_us ------------------------------
    const planSkeleton = { gerado_em: out.gerado_em, grupos: [] };
    for (const [chave, ids] of grupos) {
      const idsVivos = [...ids].filter((id) => existentes.has(id));
      if (idsVivos.length < 2) continue; // grupo deixou de ser duplicado após limpezas
      // SELECT * p/ não quebrar em colunas que talvez não existam (ex.: created_at).
      const contas = await sql`
        SELECT * FROM usuarios WHERE id_us = ANY(${idsVivos}) ORDER BY id_us
      `;
      // total de linhas de dados por id_us (só colunas de usuário reais)
      const totalPorId = {};
      const tabelasDoGrupo = []; // entram no merge automático
      const revisarManual = [];  // identidade/backup: tratar à parte, fora do merge
      for (const ref of refs) {
        const doGrupo = idsVivos.filter((id) => ref.counts[id]);
        if (!doGrupo.length) continue;
        for (const id of doGrupo) totalPorId[id] = (totalPorId[id] || 0) + ref.counts[id];
        if (EXCLUI_TABELA(ref.table)) revisarManual.push({ table: ref.table, column: ref.column });
        else tabelasDoGrupo.push({ table: ref.table, column: ref.column });
      }
      out.grupos.push({
        chave,
        ids: idsVivos,
        contas: contas.map((c) => ({
          id_us: c.id_us, email: c.email, role: c.role,
          tem_supabase: !!(c.supabase_uid || c.auth_user_id),
          criado_em: c.created_at ?? null, linhas_de_dados: totalPorId[c.id_us] || 0,
        })),
        tabelas_no_merge: tabelasDoGrupo,
        revisar_manual: revisarManual, // ex.: user_id_mapping (identidade), *_backup
      });
      planSkeleton.grupos.push({
        chave,
        canonical: null, // <<< PREENCHA: o id_us que fica (dono da identidade / mais dados)
        duplicates: idsVivos, // remova daqui o canônico depois de escolher
        tables: tabelasDoGrupo, // já filtrado (só colunas de usuário reais, sem PK/identidade)
      });
    }

    // esqueleto do plano p/ o merge
    const planPath = path.join(__dirname, "movt18-plan.SUGGESTED.json");
    fs.writeFileSync(planPath, JSON.stringify(planSkeleton, null, 2), "utf8");
    out.plano_sugerido = planPath;
    out.resumo = { grupos_duplicados: out.grupos.length, id_us_envolvidos: [...existentes].sort((a, b) => a - b) };

    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("FALHA NO DIAGNÓSTICO:", err.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
})();
