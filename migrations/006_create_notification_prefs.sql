-- Migration: 006_create_notification_prefs.sql
-- Preferências de notificação push por categoria, por usuário. Política opt-out:
-- TUDO ligado por padrão (sem linha = recebe tudo). O backend só deixa de enviar
-- quando o usuário desliga explicitamente uma categoria.
--
-- Segurança: RLS deny-all, igual a `push_tokens` — só o backend lê/escreve.
-- Rode os blocos NA ORDEM no SQL Editor do Supabase.

-- 1) TABELA
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id        INTEGER PRIMARY KEY REFERENCES usuarios (id_us) ON DELETE CASCADE,
  push_chat      BOOLEAN NOT NULL DEFAULT TRUE,   -- mensagens de chat
  push_likes     BOOLEAN NOT NULL DEFAULT TRUE,   -- curtidas (post + dieta)
  push_comments  BOOLEAN NOT NULL DEFAULT TRUE,   -- comentários (post + dieta)
  push_follows   BOOLEAN NOT NULL DEFAULT TRUE,   -- seguidores / solicitações aceitas
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) RLS deny-all.
ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;

-- 3) VERIFICAR.
SELECT to_regclass('public.notification_prefs') AS tabela,
       relrowsecurity                            AS rls_ligada
FROM pg_class
WHERE relname = 'notification_prefs';
