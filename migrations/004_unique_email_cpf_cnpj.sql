-- Migration: 004_unique_email_cpf_cnpj.sql
-- Impede e-mail, CPF e CNPJ duplicados na tabela `usuarios`.
-- Colunas separadas: `email`, `cpf`, `cnpj`.
-- Rode os blocos NA ORDEM no SQL Editor do Supabase.

-- 1) DIAGNÓSTICO — existem duplicados hoje? Se voltar linhas, resolva antes do passo 3.
SELECT lower(trim(email)) AS email_norm, count(*) AS qtd, array_agg(id_us) AS ids
FROM usuarios
WHERE email IS NOT NULL AND trim(email) <> ''
GROUP BY lower(trim(email)) HAVING count(*) > 1;

SELECT regexp_replace(cpf, '\D', '', 'g') AS cpf_norm, count(*) AS qtd, array_agg(id_us) AS ids
FROM usuarios
WHERE cpf IS NOT NULL AND regexp_replace(cpf, '\D', '', 'g') <> ''
GROUP BY regexp_replace(cpf, '\D', '', 'g') HAVING count(*) > 1;

SELECT regexp_replace(cnpj, '\D', '', 'g') AS cnpj_norm, count(*) AS qtd, array_agg(id_us) AS ids
FROM usuarios
WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '\D', '', 'g') <> ''
GROUP BY regexp_replace(cnpj, '\D', '', 'g') HAVING count(*) > 1;

-- 2) LIMPEZA (só se o passo 1 retornou duplicados) — decida MANUALMENTE qual
--    linha de cada grupo manter (pode haver treinos/posts atrelados). Não apague
--    em massa às cegas. Use os `ids` retornados acima.

-- 3) NORMALIZAR os dados existentes para os índices baterem de forma consistente.
UPDATE usuarios SET email = lower(trim(email))
WHERE email IS NOT NULL AND email <> lower(trim(email));

UPDATE usuarios SET cpf = regexp_replace(cpf, '\D', '', 'g')
WHERE cpf IS NOT NULL AND cpf <> regexp_replace(cpf, '\D', '', 'g');

UPDATE usuarios SET cnpj = regexp_replace(cnpj, '\D', '', 'g')
WHERE cnpj IS NOT NULL AND cnpj <> regexp_replace(cnpj, '\D', '', 'g');

-- 4) CRIAR as travas únicas (a defesa real). Índices funcionais normalizados;
--    parciais para NULL/vazio não conflitarem entre si. Os nomes contêm "email",
--    "cpf" e "cnpj" — o handler /api/register usa isso para identificar o campo
--    em violação 23505.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_unique
  ON usuarios (lower(trim(email)))
  WHERE email IS NOT NULL AND trim(email) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_cpf_unique
  ON usuarios (regexp_replace(cpf, '\D', '', 'g'))
  WHERE cpf IS NOT NULL AND regexp_replace(cpf, '\D', '', 'g') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_cnpj_unique
  ON usuarios (regexp_replace(cnpj, '\D', '', 'g'))
  WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '\D', '', 'g') <> '';

-- 5) VERIFICAR.
SELECT indexname FROM pg_indexes
WHERE tablename = 'usuarios'
  AND indexname IN ('usuarios_email_unique', 'usuarios_cpf_unique', 'usuarios_cnpj_unique');
