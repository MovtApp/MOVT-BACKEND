-- Migration: cria tabela 'user_workouts' para o histórico de treinos de
-- performance (Corrida / Ciclismo) do MOVT Performance.
-- Execute este SQL no banco (Supabase). RLS habilitado em modo deny-all:
-- o acesso é feito exclusivamente pelo backend via service_role (mesmo padrão
-- de 'dispositivos' e 'user_mission').

CREATE TABLE IF NOT EXISTS user_workouts (
  id BIGSERIAL PRIMARY KEY,
  id_us INTEGER NOT NULL,
  client_id TEXT,                    -- id gerado no app, para idempotência no sync
  tipo TEXT NOT NULL,                -- 'Corrida' | 'Ciclismo'
  data TIMESTAMPTZ NOT NULL,
  duracao_seg INTEGER NOT NULL,
  distancia_km NUMERIC(8,2) NOT NULL,
  pace_medio TEXT,
  velocidade_media_kmh NUMERIC(6,2),
  kcal INTEGER,
  rota JSONB DEFAULT '[]'::jsonb,
  splits JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT user_workouts_client_unique UNIQUE (id_us, client_id)
);

-- Índice para a consulta principal: treinos de um usuário, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_user_workouts_user ON user_workouts(id_us, data DESC);

-- Deny-all: nenhuma policy é criada, então clientes anon/authenticated não
-- enxergam nada. Apenas o backend (service_role) acessa, ignorando RLS.
ALTER TABLE user_workouts ENABLE ROW LEVEL SECURITY;
