-- Migration: 005_create_push_tokens.sql
-- Armazena os tokens de push (Expo Push Token) de cada dispositivo do usuário,
-- para o backend conseguir entregar notificações de SO (FCM/APNs via Expo) com o
-- app fechado, em background ou com a tela bloqueada.
--
-- Segurança: mesma postura da tabela `dispositivos` — RLS deny-all. Nenhuma key
-- pública (anon/authenticated) lê ou escreve aqui; só o backend, que usa a
-- conexão direta (DATABASE_URL / service_role) e por isso não é barrado pela RLS.
-- Rode os blocos NA ORDEM no SQL Editor do Supabase.

-- 1) TABELA
CREATE TABLE IF NOT EXISTS push_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES usuarios (id_us) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,           -- ExponentPushToken[...]
  platform    TEXT,                           -- 'ios' | 'android'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) ÍNDICE para buscar rápido todos os tokens de um usuário no envio.
CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx ON push_tokens (user_id);

-- 3) RLS deny-all: liga a RLS e NÃO cria nenhuma policy. Assim as keys públicas
--    ficam sem acesso; o backend (owner/service_role) continua passando.
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;

-- 4) VERIFICAR.
SELECT to_regclass('public.push_tokens') AS tabela,
       relrowsecurity                    AS rls_ligada
FROM pg_class
WHERE relname = 'push_tokens';
