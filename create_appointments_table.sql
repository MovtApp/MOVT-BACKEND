-- Script para criar apenas a tabela de agendamentos
CREATE TABLE IF NOT EXISTS agendamentos (
    id_agendamento SERIAL PRIMARY KEY,
    id_trainer INTEGER NOT NULL,
    id_usuario INTEGER NOT NULL,
    data_agendamento DATE NOT NULL,
    hora_inicio TIME NOT NULL,
    hora_fim TIME NOT NULL,
    status VARCHAR(20) DEFAULT 'pendente' NOT NULL,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índice para otimizar consultas por trainer e data
CREATE INDEX IF NOT EXISTS idx_agendamentos_trainer_data ON agendamentos (id_trainer, data_agendamento);

-- Índice para otimizar consultas por usuário
CREATE INDEX IF NOT EXISTS idx_agendamentos_usuario ON agendamentos (id_usuario);

-- Índice para otimizar consultas por status
CREATE INDEX IF NOT EXISTS idx_agendamentos_status ON agendamentos (status);

-- Função para verificar disponibilidade de agendamento
CREATE OR REPLACE FUNCTION verificar_disponibilidade(
    p_id_trainer INTEGER,
    p_data_agendamento DATE,
    p_hora_inicio TIME,
    p_hora_fim TIME
)
RETURNS TABLE(disponivel BOOLEAN, motivo VARCHAR) AS $$
DECLARE
    conflito RECORD;
BEGIN
    -- Verificar conflitos de horário
    SELECT * INTO conflito
    FROM agendamentos
    WHERE id_trainer = p_id_trainer
      AND data_agendamento = p_data_agendamento
      AND status != 'cancelado'
      AND (
          (p_hora_inicio < hora_fim AND p_hora_fim > hora_inicio)
          OR
          (p_hora_inicio = hora_inicio AND p_hora_fim = hora_fim)
      )
    LIMIT 1;

    IF conflito IS NOT NULL THEN
        RETURN QUERY SELECT FALSE, 'Horário já agendado';
    ELSE
        -- Verificar disponibilidade semanal do trainer
        IF NOT EXISTS (
            SELECT 1 FROM disponibilidade_trainer
            WHERE id_trainer = p_id_trainer
              AND dia_semana = EXTRACT(DOW FROM p_data_agendamento)
              AND ativo = TRUE
              AND p_hora_inicio >= hora_inicio
              AND p_hora_fim <= hora_fim
        ) THEN
            RETURN QUERY SELECT FALSE, 'Trainer não tem disponibilidade neste dia/horário';
        ELSE
            RETURN QUERY SELECT TRUE, NULL;
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;