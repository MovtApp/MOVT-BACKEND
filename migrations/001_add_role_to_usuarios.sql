-- Migration: 001_add_role_to_usuarios.sql
-- Adiciona coluna `role` na tabela `usuarios` e popula valores iniciais
-- Recomenda-se revisar antes de executar em produção.

-- 1) Criar enum user_role caso não exista
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('admin','trainer','client_pf','client_pj','other');
  END IF;
END$$;

-- 2) Adicionar coluna role com DEFAULT 'client_pf' quando não existir
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS role user_role DEFAULT 'client_pf';

-- 3) Popular role com base em tipo_documento (CNPJ -> trainer)
-- Ajuste o nome da coluna 'tipo_documento' se for diferente no seu schema
UPDATE usuarios
SET role = 'trainer'
WHERE tipo_documento = 'CNPJ';

-- 4) Marcar como trainer usuários que possuem posts (se existir a tabela trainer_posts)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'trainer_posts') THEN
    UPDATE usuarios
    SET role = 'trainer'
    WHERE id_us IN (SELECT DISTINCT trainer_id FROM trainer_posts);
  END IF;
END$$;

-- 5) Criar índice para buscas por role
CREATE INDEX IF NOT EXISTS idx_usuarios_role ON usuarios (role);

-- Observação: após rodar a migration, verifique se os valores estão corretos.
-- Caso prefira coluna TEXT em vez de ENUM, adapte o migration para usar TEXT.
