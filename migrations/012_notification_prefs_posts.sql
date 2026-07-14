-- Migration: 012_notification_prefs_posts.sql
-- Adiciona a categoria "posts" às preferências de notificação: push quando
-- alguém que você segue publica.
--
-- Política opt-out (igual às 4 categorias existentes): nasce TRUE, ou seja,
-- todo seguidor recebe por padrão e desliga se quiser. Decisão do dono
-- (2026-07-14) — a alternativa "opt-in por perfil, tipo Instagram" foi
-- considerada e descartada por exigir tabela + sininho no perfil.
--
-- ⚠️ Consequência assumida: fan-out para TODOS os seguidores em todo post.
-- Se virar spam ou deixar o POST /api/user/posts lento, o lugar de mudar é o
-- `notifyNewPostToFollowers` em services/pushService.js.
-- Rode no SQL Editor do Supabase (ou: node migrations/run_012_notification_prefs_posts.js).

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS push_posts BOOLEAN NOT NULL DEFAULT TRUE;

-- VERIFICAR.
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'notification_prefs'
ORDER BY ordinal_position;
