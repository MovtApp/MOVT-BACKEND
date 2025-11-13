-- =====================================================
-- MOVT APP - Database Schema
-- =====================================================

-- Tabela de Usuários
CREATE TABLE IF NOT EXISTS usuarios (
  id_us SERIAL PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  senha VARCHAR(255) NOT NULL,
  cpf VARCHAR(14) UNIQUE,
  cnpj VARCHAR(18) UNIQUE,
  data_nascimento TIMESTAMP,
  telefone VARCHAR(20),
  session_id VARCHAR(255),
  verification_code VARCHAR(6),
  email_verified BOOLEAN DEFAULT FALSE,
  verification_code_expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para melhorar performance
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_usuarios_session_id ON usuarios(session_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_cpf ON usuarios(cpf);
CREATE INDEX IF NOT EXISTS idx_usuarios_cnpj ON usuarios(cnpj);

-- =====================================================
-- Tabela de Dietas
-- =====================================================
CREATE TABLE IF NOT EXISTS dietas (
  id_dieta SERIAL PRIMARY KEY,
  id_us INTEGER NOT NULL REFERENCES usuarios(id_us) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  imageurl TEXT,
  calorias INTEGER,
  tempo_preparo VARCHAR(50),
  gordura DECIMAL(10, 2),
  proteina DECIMAL(10, 2),
  carboidratos DECIMAL(10, 2),
  nome_autor VARCHAR(255),
  avatar_autor_url TEXT,
  categoria VARCHAR(100),
  createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para dietas
CREATE INDEX IF NOT EXISTS idx_dietas_usuario ON dietas(id_us);
CREATE INDEX IF NOT EXISTS idx_dietas_categoria ON dietas(categoria);
CREATE INDEX IF NOT EXISTS idx_dietas_createdat ON dietas(createdat DESC);

-- =====================================================
-- Tabela de Dados de Saúde
-- =====================================================
CREATE TABLE IF NOT EXISTS dados_saude (
  id_dado SERIAL PRIMARY KEY,
  id_us INTEGER NOT NULL REFERENCES usuarios(id_us) ON DELETE CASCADE,
  
  -- Dados de atividade física
  calories INTEGER,              -- Calorias queimadas
  steps INTEGER,                 -- Passos
  distance_km DECIMAL(10, 2),   -- Distância percorrida em km
  active_minutes INTEGER,        -- Minutos ativos
  
  -- Dados vitais
  heart_rate INTEGER,            -- Batimentos por minuto
  blood_pressure_systolic INTEGER,  -- Pressão arterial sistólica
  blood_pressure_diastolic INTEGER, -- Pressão arterial diastólica
  blood_oxygen INTEGER,          -- Saturação de oxigênio (%)
  
  -- Dados de sono
  sleep_hours DECIMAL(4, 2),    -- Horas de sono
  sleep_quality VARCHAR(50),     -- Qualidade do sono (poor, fair, good, excellent)
  
  -- Dados de hidratação
  water_intake_ml INTEGER,       -- Ingestão de água em ml
  
  -- Dados de peso e medidas
  weight_kg DECIMAL(5, 2),      -- Peso em kg
  height_cm DECIMAL(5, 2),      -- Altura em cm
  bmi DECIMAL(4, 2),            -- Índice de massa corporal
  body_fat_percentage DECIMAL(4, 2), -- Percentual de gordura corporal
  
  -- Dados de ciclismo
  cycling_distance_km DECIMAL(10, 2), -- Distância de ciclismo em km
  cycling_duration_minutes INTEGER,   -- Duração do ciclismo em minutos
  
  -- Metadados
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Data/hora do registro
  data_source VARCHAR(100),      -- Fonte dos dados (manual, google_fit, apple_health, etc.)
  notes TEXT,                    -- Notas adicionais
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para dados de saúde
CREATE INDEX IF NOT EXISTS idx_dados_saude_usuario ON dados_saude(id_us);
CREATE INDEX IF NOT EXISTS idx_dados_saude_timestamp ON dados_saude(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_dados_saude_usuario_timestamp ON dados_saude(id_us, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_dados_saude_calories ON dados_saude(id_us, calories) WHERE calories IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dados_saude_steps ON dados_saude(id_us, steps) WHERE steps IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dados_saude_heart_rate ON dados_saude(id_us, heart_rate) WHERE heart_rate IS NOT NULL;

-- =====================================================
-- Função para atualizar updated_at automaticamente
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para atualizar updated_at
DROP TRIGGER IF EXISTS update_usuarios_updated_at ON usuarios;
CREATE TRIGGER update_usuarios_updated_at
BEFORE UPDATE ON usuarios
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_dietas_updated_at ON dietas;
CREATE TRIGGER update_dietas_updated_at
BEFORE UPDATE ON dietas
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_dados_saude_updated_at ON dados_saude;
CREATE TRIGGER update_dados_saude_updated_at
BEFORE UPDATE ON dados_saude
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- Views úteis
-- =====================================================

-- View para estatísticas diárias de saúde
CREATE OR REPLACE VIEW v_estatisticas_diarias AS
SELECT 
  id_us,
  DATE(timestamp) as data,
  SUM(calories) as total_calories,
  SUM(steps) as total_steps,
  SUM(distance_km) as total_distance_km,
  SUM(active_minutes) as total_active_minutes,
  AVG(heart_rate) as avg_heart_rate,
  SUM(water_intake_ml) as total_water_intake_ml,
  AVG(sleep_hours) as avg_sleep_hours,
  COUNT(*) as total_records
FROM dados_saude
GROUP BY id_us, DATE(timestamp)
ORDER BY id_us, data DESC;

-- View para resumo mensal
CREATE OR REPLACE VIEW v_estatisticas_mensais AS
SELECT 
  id_us,
  DATE_TRUNC('month', timestamp) as mes,
  SUM(calories) as total_calories,
  SUM(steps) as total_steps,
  AVG(heart_rate) as avg_heart_rate,
  AVG(sleep_hours) as avg_sleep_hours,
  COUNT(*) as total_records
FROM dados_saude
GROUP BY id_us, DATE_TRUNC('month', timestamp)
ORDER BY id_us, mes DESC;

-- =====================================================
-- Dados de exemplo (opcional - comentar em produção)
-- =====================================================

-- Inserir dados de exemplo para testes
-- IMPORTANTE: Remover ou comentar em produção!

/*
-- Exemplo de usuário de teste
INSERT INTO usuarios (nome, username, email, senha, email_verified, session_id)
VALUES (
  'Usuário Teste',
  'usuario_teste',
  'teste@movtapp.com',
  '$2b$10$XQxJKZvJKvDIr8yzqVZqJOEUjD4qW4GqKK7YZ0OqC0T9cD6yZvJKZ', -- senha: teste123
  TRUE,
  'test-session-id-123'
);

-- Exemplo de dados de calorias (últimos 7 dias)
INSERT INTO dados_saude (id_us, calories, steps, heart_rate, water_intake_ml, timestamp)
SELECT 
  1,
  FLOOR(1400 + RANDOM() * 600)::INTEGER,
  FLOOR(5000 + RANDOM() * 10000)::INTEGER,
  FLOOR(60 + RANDOM() * 40)::INTEGER,
  FLOOR(1500 + RANDOM() * 2000)::INTEGER,
  CURRENT_TIMESTAMP - (n || ' days')::INTERVAL
FROM generate_series(0, 6) as n;
*/

-- =====================================================
-- Comentários úteis
-- =====================================================

COMMENT ON TABLE dados_saude IS 'Armazena todos os dados de saúde e atividades físicas dos usuários';
COMMENT ON COLUMN dados_saude.calories IS 'Calorias queimadas no período';
COMMENT ON COLUMN dados_saude.steps IS 'Número de passos dados';
COMMENT ON COLUMN dados_saude.heart_rate IS 'Batimentos cardíacos por minuto';
COMMENT ON COLUMN dados_saude.water_intake_ml IS 'Quantidade de água ingerida em mililitros';
COMMENT ON COLUMN dados_saude.timestamp IS 'Data e hora do registro dos dados';
COMMENT ON COLUMN dados_saude.data_source IS 'Origem dos dados: manual, google_fit, apple_health, etc.';
