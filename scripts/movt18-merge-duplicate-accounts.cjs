// MOVT-18 — Merge das contas duplicadas. DRY-RUN por padrão.
// Re-aponta todas as linhas de dados dos id_us duplicados para o id_us CANÔNICO
// (escolhido MANUALMENTE por você no plano) e desativa (soft) as contas duplicadas.
// Nada é apagado às cegas: backup em JSON antes, tudo numa única transação,
// verificação antes do commit. Colisões de UNIQUE são detectadas.
//
// Fluxo:
//   1) node scripts/movt18-diag-duplicate-accounts.cjs --backup scripts/_backup_user_id_mapping_*.json
//   2) copie movt18-plan.SUGGESTED.json -> movt18-plan.json e PREENCHA `canonical`
//      de cada grupo (e tire o canônico de `duplicates`). Confira `tables`.
//   3) DRY-RUN:  node scripts/movt18-merge-duplicate-accounts.cjs --plan scripts/movt18-plan.json
//   4) revise o plano impresso. Faça BACKUP do banco (Supabase) por fora.
//   5) APLICAR:  node scripts/movt18-merge-duplicate-accounts.cjs --plan scripts/movt18-plan.json --apply --sim-eu-fiz-backup
//
// Segurança: em --apply, para cada tabela com UNIQUE que envolve a coluna de
// usuário, as linhas do lado duplicado que COLIDIRIAM com uma linha já existente
// do canônico são APAGADAS (após backup) — o canônico vence. As demais são
// re-apontadas. As contas duplicadas viram inativas (email recebe sufixo
// `+merged<canonical>` e, se existir, uma coluna de flag é marcada), nunca são
// hard-deletadas.

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

const IDENT = /^[a-z_][a-z0-9_]*$/i;
const argValue = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };
const hasFlag = (flag) => process.argv.includes(flag);

function loadPlan() {
  const p = argValue("--plan");
  if (!p) throw new Error("Faltou --plan scripts/movt18-plan.json");
  const plan = JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(__dirname, "..", p), "utf8"));
  if (!Array.isArray(plan.grupos)) throw new Error("Plano inválido: falta `grupos[]`.");
  for (const g of plan.grupos) {
    if (!Number.isInteger(g.canonical)) throw new Error(`Grupo ${g.chave}: preencha um \`canonical\` inteiro.`);
    g.duplicates = (g.duplicates || []).map(Number).filter((id) => id !== g.canonical);
    if (!g.duplicates.length) throw new Error(`Grupo ${g.chave}: sem duplicates (além do canônico).`);
    for (const t of g.tables || []) {
      if (!IDENT.test(t.table) || !IDENT.test(t.column)) throw new Error(`Grupo ${g.chave}: tabela/coluna inválida ${t.table}.${t.column}`);
    }
  }
  return plan;
}

// Colunas dos índices UNIQUE de uma tabela que INCLUEM `ucol` (retorna, por índice,
// a lista das OUTRAS colunas — as que definem a colisão).
async function uniqueOtherCols(sql, table, ucol) {
  const rows = await sql`
    SELECT ix.indexrelid::regclass::text AS idx,
           array_agg(a.attname) AS cols
    FROM pg_index ix
    JOIN pg_class c ON c.oid = ix.indrelid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
    WHERE c.relname = ${table} AND ix.indisunique AND ix.indpred IS NULL
    GROUP BY ix.indexrelid
  `;
  const res = [];
  for (const r of rows) {
    const cols = r.cols.filter((c) => IDENT.test(c));
    if (cols.includes(ucol) && cols.length > 1) res.push(cols.filter((c) => c !== ucol));
  }
  return res;
}

async function collisionRows(sql, table, ucol, otherColsList, canonical, duplicates) {
  // linhas do lado duplicado que já existem no canônico (mesmos otherCols)
  let total = new Set();
  for (const others of otherColsList) {
    const cond = others.map((c) => `k.${c} IS NOT DISTINCT FROM d.${c}`).join(" AND ");
    const rows = await sql.unsafe(
      `SELECT d.ctid::text AS ctid FROM ${table} d
       WHERE d.${ucol} = ANY($1)
         AND EXISTS (SELECT 1 FROM ${table} k WHERE k.${ucol} = $2 AND ${cond})`,
      [duplicates, canonical]
    );
    for (const r of rows) total.add(r.ctid);
  }
  return total; // set de ctids a apagar (colidem)
}

(async () => {
  const url = loadUrl();
  if (!url) { console.error("Sem DATABASE_URL. Abortando."); process.exit(1); }
  const APPLY = hasFlag("--apply");
  if (APPLY && !hasFlag("--sim-eu-fiz-backup")) {
    console.error("--apply exige também --sim-eu-fiz-backup (confirmação de que há backup do banco). Abortando.");
    process.exit(1);
  }

  let plan;
  try { plan = loadPlan(); } catch (e) { console.error("PLANO:", e.message); process.exit(1); }

  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, prepare: false, idle_timeout: 5, connect_timeout: 30 });
  const report = { modo: APPLY ? "APPLY" : "DRY-RUN", gerado_em: new Date().toISOString(), grupos: [] };

  try {
    // detecta se `usuarios` tem coluna de flag p/ marcar inativa (opcional)
    const flagCol = (await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='usuarios' AND column_name IN ('ativo','is_active','deleted','deletado','merged_into')
    `).map((r) => r.column_name);

    // Guarda-corpo: nenhuma coluna do plano pode ser PK (re-apontar PK = catástrofe).
    const pkSet = new Set((await sql`
      SELECT c.relname AS t, a.attname AS col
      FROM pg_index ix
      JOIN pg_class c ON c.oid = ix.indrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ix.indisprimary AND n.nspname = 'public'
    `).map((r) => `${r.t}.${r.col}`));
    for (const g of plan.grupos) {
      for (const t of g.tables || []) {
        if (pkSet.has(`${t.table}.${t.column}`)) throw new Error(`ABORT: ${t.table}.${t.column} é PRIMARY KEY — nunca re-apontar. Tire do plano.`);
        if (t.table === "user_id_mapping") throw new Error(`ABORT: user_id_mapping é a tabela de identidade — não faça merge por aqui. Tire do plano.`);
      }
    }

    for (const g of plan.grupos) {
      const gRep = { chave: g.chave, canonical: g.canonical, duplicates: g.duplicates, tabelas: [], colisoes: [], contas_desativadas: [] };
      for (const t of g.tables || []) {
        const mover = (await sql`
          SELECT count(*)::int AS n FROM ${sql(t.table)} WHERE ${sql(t.column)} = ANY(${g.duplicates})
        `)[0].n;
        const others = await uniqueOtherCols(sql, t.table, t.column);
        const colisao = others.length ? await collisionRows(sql, t.table, t.column, others, g.canonical, g.duplicates) : new Set();
        gRep.tabelas.push({ table: t.table, column: t.column, linhas_a_mover: mover, colisoes_a_remover: colisao.size });
        if (colisao.size) gRep.colisoes.push({ table: t.table, column: t.column, qtd: colisao.size });
      }
      report.grupos.push(gRep);
    }

    if (!APPLY) {
      console.log(JSON.stringify(report, null, 2));
      console.log("\nDRY-RUN — nada foi escrito. Revise, faça backup e rode com --apply --sim-eu-fiz-backup.");
      await sql.end({ timeout: 5 });
      return;
    }

    // ---- APPLY: backup + transação --------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = { gerado_em: stamp, plano: plan, linhas: {} };

    await sql.begin(async (tx) => {
      for (const g of plan.grupos) {
        for (const t of g.tables || []) {
          // backup das linhas do lado duplicado (antes de mexer)
          const rows = await tx`SELECT * FROM ${tx(t.table)} WHERE ${tx(t.column)} = ANY(${g.duplicates})`;
          backup.linhas[`${g.canonical}:${t.table}.${t.column}`] = rows;

          // 1) remove colisões (canônico vence)
          const others = await uniqueOtherCols(tx, t.table, t.column);
          if (others.length) {
            const ctids = await collisionRows(tx, t.table, t.column, others, g.canonical, g.duplicates);
            if (ctids.size) {
              await tx.unsafe(
                `DELETE FROM ${t.table} WHERE ctid = ANY($1::tid[])`,
                [[...ctids]]
              );
            }
          }
          // 2) re-aponta o restante para o canônico
          await tx`UPDATE ${tx(t.table)} SET ${tx(t.column)} = ${g.canonical} WHERE ${tx(t.column)} = ANY(${g.duplicates})`;

          // 3) verifica que não sobrou nenhum id_us duplicado nessa tabela/coluna
          const [{ n }] = await tx`SELECT count(*)::int AS n FROM ${tx(t.table)} WHERE ${tx(t.column)} = ANY(${g.duplicates})`;
          if (n !== 0) throw new Error(`ABORT: ${t.table}.${t.column} ainda tem ${n} linhas de ${JSON.stringify(g.duplicates)}`);
        }

        // desativa (soft) as contas duplicadas — nunca hard-delete
        for (const dup of g.duplicates) {
          const [u] = await tx`SELECT email FROM usuarios WHERE id_us = ${dup}`;
          if (!u) continue;
          const novoEmail = `${u.email || `id${dup}`}+merged${g.canonical}`;
          if (flagCol.includes("merged_into")) {
            await tx`UPDATE usuarios SET email = ${novoEmail}, merged_into = ${g.canonical} WHERE id_us = ${dup}`;
          } else if (flagCol.includes("ativo")) {
            await tx`UPDATE usuarios SET email = ${novoEmail}, ativo = false WHERE id_us = ${dup}`;
          } else if (flagCol.includes("is_active")) {
            await tx`UPDATE usuarios SET email = ${novoEmail}, is_active = false WHERE id_us = ${dup}`;
          } else {
            await tx`UPDATE usuarios SET email = ${novoEmail} WHERE id_us = ${dup}`;
          }
        }
      }
    });

    const backupFile = path.join(__dirname, `_backup_movt18_merge_${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), "utf8");
    console.log("BACKUP:", backupFile);
    console.log("RESULT:", JSON.stringify(report, null, 2));
    console.log("COMMIT OK — contas mescladas.");
    await sql.end({ timeout: 5 });
  } catch (err) {
    console.error("ROLLBACK / FALHA:", err.message);
    try { await sql.end({ timeout: 2 }); } catch {}
    process.exit(1);
  }
})();
