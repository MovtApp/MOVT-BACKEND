-- Migration: disponibilidade do personal com duração de sessão.
-- Garante a tabela disponibilidade_trainer (hoje criada via ensureDisponibilidadeTable)
-- e adiciona 'duracao_min' — a duração de cada sessão em minutos. A geração de slots
-- (GET /api/appointments/availability/:trainerId) fatia a faixa hora_inicio→hora_fim
-- em blocos dessa duração. Idempotente (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS disponibilidade_trainer (
  id SERIAL PRIMARY KEY,
  id_trainer INTEGER NOT NULL,
  dia_semana INTEGER NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fim TIME NOT NULL,
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE disponibilidade_trainer ADD COLUMN IF NOT EXISTS duracao_min INTEGER NOT NULL DEFAULT 60;
