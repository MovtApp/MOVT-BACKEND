-- Migration: cria tabela 'follows' para representar arestas do grafo
-- Execute este SQL no seu banco (Supabase) para habilitar a rede de seguidores

CREATE TABLE IF NOT EXISTS follows (
  id BIGSERIAL PRIMARY KEY,
  follower_user_id INTEGER NOT NULL,
  trainer_id INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT follows_unique UNIQUE (follower_user_id, trainer_id)
);

-- Índices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_user_id);
CREATE INDEX IF NOT EXISTS idx_follows_trainer ON follows(trainer_id);

-- Observação: a coluna 'trainer_id' foi mantida por compatibilidade com o código
-- do backend. Funcionalmente representa o usuário seguido (target).
