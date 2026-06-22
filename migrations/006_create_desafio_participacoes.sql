-- Migration: cria 'desafio_participacoes' (quem participou de qual desafio e quando).
-- Desafios = treinos com secao_home='desafio'. Base para o limite MENSAL por plano
-- (free 2 / premium 8 / família ilimitado — ver ADR-0013).
-- RLS deny-all: acesso só pelo backend (service_role), mesmo padrão de user_workouts.

CREATE TABLE IF NOT EXISTS desafio_participacoes (
  id BIGSERIAL PRIMARY KEY,
  id_us INTEGER NOT NULL,
  id_desafio TEXT NOT NULL,            -- treinos.id_treino do desafio (tratado como texto)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT desafio_part_unique UNIQUE (id_us, id_desafio)
);

-- Índice para a contagem mensal: participações de um usuário, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_desafio_part_user ON desafio_participacoes(id_us, created_at DESC);

-- Deny-all: nenhuma policy → anon/authenticated não enxergam nada. Só o backend
-- (service_role) acessa, ignorando RLS.
ALTER TABLE desafio_participacoes ENABLE ROW LEVEL SECURITY;
