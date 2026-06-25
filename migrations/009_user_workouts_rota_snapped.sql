-- Migration: adiciona 'rota_snapped' em user_workouts.
-- É a rota encaixada na malha viária (map-matching via Mapbox) — usada SÓ para
-- exibição no mapa. A coluna 'rota' (crua) continua sendo a fonte de verdade da
-- distância/pace. Idempotente (ADD COLUMN IF NOT EXISTS).

ALTER TABLE user_workouts ADD COLUMN IF NOT EXISTS rota_snapped JSONB DEFAULT '[]'::jsonb;
