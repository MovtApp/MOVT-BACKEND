-- Migration: data de registro no CONFEF/CREF (autodeclarada) em usuarios.
-- Fonte dos "anos de experiência" do perfil do personal:
--   experienceYears = ano_atual − ano(cref_data_registro)  (computado em GET /api/trainers/:id).
-- Sem IA/OCR. Idempotente (ADD COLUMN IF NOT EXISTS).
-- Necessária porque o ALTER em initDb() só roda no app.listen local, NÃO no Vercel serverless.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cref_data_registro DATE DEFAULT NULL;
