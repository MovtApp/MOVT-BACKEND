# MOVT-18 — Merge das contas duplicadas ("1 corrida vs 5 corridas")

O login Google já foi consertado (ADR-0037): o `social-sync` não auto-cria mais conta e o
vínculo Supabase↔usuário virou 1:1. Isso **previne casos novos**. O que falta (esta issue)
é **mesclar os dados das contas que já ficaram divididas** entre vários `id_us` do mesmo
dono, e depois travar a unicidade.

> ⚠️ **Mexe em dados de PRODUÇÃO e é irreversível.** Faça backup do banco antes do `--apply`.
> A escolha de qual conta é a "verdadeira" (canônica) de cada grupo é **manual, sua** — o
> script nunca decide isso sozinho (segue o aviso da migration `004`).

## Pré-requisito

`DATABASE_URL` no `.env.local` ou `.env` (mesma que os outros scripts usam). Lib `postgres` já é dependência.

## Passo a passo

**1. Diagnóstico (read-only, não escreve nada).**
```
node scripts/movt18-diag-duplicate-accounts.cjs --backup scripts/_backup_user_id_mapping_2026-07-18T17-10-59-240Z.json
```
- Acha grupos duplicados por **email normalizado** e pelo **backup do user_id_mapping**
  (é assim que aparece o caso Google 14 vs 56, que tem email com typo).
- Varre **todo o schema** e lista cada `tabela.coluna` que contém os `id_us` do grupo —
  não confia em nomes de coluna (o FK de usuário é inconsistente: `id_us`,
  `follower_user_id`, `trainer_id`, ...).
- Mostra, por `id_us`, quantas **linhas de dados** cada um tem → você vê o tamanho do
  problema e decide o canônico.
- Gera `scripts/movt18-plan.SUGGESTED.json`.

**2. Monte o plano.** Copie o esqueleto e preencha:
```
cp scripts/movt18-plan.SUGGESTED.json scripts/movt18-plan.json
```
Em cada grupo:
- `canonical`: o `id_us` que **fica** (normalmente o que tem a identidade Google ativa e/ou mais dados).
- `duplicates`: os `id_us` que serão absorvidos (tire o canônico daqui).
- `tables`: confira a lista; a varredura já preenche, mas adicione se souber de alguma tabela a mais.

**3. Dry-run (não escreve).**
```
node scripts/movt18-merge-duplicate-accounts.cjs --plan scripts/movt18-plan.json
```
Mostra, por tabela: quantas linhas seriam **re-apontadas** e quantas seriam **removidas por
colisão de UNIQUE** (ex.: os dois já seguem o mesmo trainer → `follows`). Revise com calma.

**4. Backup do banco.** Faça um snapshot/backup no Supabase por fora. Sério.

**5. Aplicar.**
```
node scripts/movt18-merge-duplicate-accounts.cjs --plan scripts/movt18-plan.json --apply --sim-eu-fiz-backup
```
- Roda tudo em **uma transação**; salva um `_backup_movt18_merge_*.json` com as linhas do
  lado duplicado antes de mexer.
- Colisões de UNIQUE: a linha do lado duplicado que colidiria é **apagada** (o canônico
  vence) — tudo já está no backup.
- Re-aponta o resto para o canônico e **verifica** que não sobrou nenhum `id_us` duplicado
  antes do commit. Se algo não bater, faz **rollback**.
- As contas duplicadas **não são hard-deletadas**: viram inativas (email ganha sufixo
  `+merged<canonical>`; se houver coluna `merged_into`/`ativo`/`is_active`, é marcada).

## Depois do merge

- A constraint de unicidade de email já existe (`usuarios_email_unique`, migration `004`).
  Se as contas absorvidas tinham email com typo, elas saíram do caminho ao virar
  `+merged<canonical>` — sem colisão.
- Teste: logar com email/senha e com Google no mesmo dono deve mostrar os mesmos dados.
- Feche a **MOVT-18** só depois de validar em prod.

## Arquivos

- `movt18-diag-duplicate-accounts.cjs` — diagnóstico read-only + gera o plano.
- `movt18-merge-duplicate-accounts.cjs` — merge (dry-run por padrão; `--apply` travado).
- `movt18-plan.SUGGESTED.json` — gerado pelo diag; copie para `movt18-plan.json` e preencha.
