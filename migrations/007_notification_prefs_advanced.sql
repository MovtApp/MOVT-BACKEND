-- Migration: 007_notification_prefs_advanced.sql
-- Fase 3: adiciona à `notification_prefs` o "ocultar prévia da mensagem" e o
-- "horário silencioso" (não perturbe). Tudo opcional e desligado por padrão,
-- então não muda o comportamento de quem não configurar.
--
--  - hide_message_preview: esconde o TEXTO da mensagem no push de chat (mantém
--    quem mandou no título).
--  - quiet_hours_*: janela em que o backend NÃO envia push. Suporta cruzar a
--    meia-noite (ex.: 22:00–07:00). `timezone` é o fuso IANA do device (ex.:
--    'America/Sao_Paulo'), enviado pelo app para o cálculo do horário local.
-- Rode no SQL Editor do Supabase.

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS hide_message_preview BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quiet_hours_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quiet_start          TEXT,   -- 'HH:MM'
  ADD COLUMN IF NOT EXISTS quiet_end            TEXT,   -- 'HH:MM'
  ADD COLUMN IF NOT EXISTS timezone             TEXT;   -- IANA, ex.: 'America/Sao_Paulo'

-- VERIFICAR.
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'notification_prefs'
ORDER BY ordinal_position;
