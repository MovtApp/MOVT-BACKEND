-- Migration: idempotência das escritas de saúde (offline-first / syncQueue).
--
-- O POST /api/dados/:metric faz INSERT de histórico. Com a fila de escrita do
-- app (syncQueue), um mesmo registro pode ser reenviado após reconexão. Para o
-- reenvio NÃO duplicar a linha, o app passa um `client_id` (gerado no device) e
-- o backend usa ON CONFLICT DO NOTHING sobre (id_us, client_id).
--
-- Índice ÚNICO PARCIAL: linhas legadas (client_id NULL) não colidem entre si —
-- só registros com client_id participam da deduplicação. Idempotente.

ALTER TABLE dados_saude
  ADD COLUMN IF NOT EXISTS client_id TEXT; -- id gerado no app p/ idempotência

CREATE UNIQUE INDEX IF NOT EXISTS dados_saude_client_unique
  ON dados_saude (id_us, client_id)
  WHERE client_id IS NOT NULL;
