-- Migration: Add Google Places API fields to academias table
-- Created: 2026-02-09

-- Add new columns for Google Places data caching
ALTER TABLE academias
ADD COLUMN IF NOT EXISTS google_place_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS website VARCHAR(500),
ADD COLUMN IF NOT EXISTS horarios_funcionamento JSONB,
ADD COLUMN IF NOT EXISTS fotos JSONB,
ADD COLUMN IF NOT EXISTS ultima_atualizacao_google TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS dados_google_cache JSONB;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_academias_google_place_id ON academias(google_place_id);

-- Add comment explaining the cache strategy
COMMENT ON COLUMN academias.google_place_id IS 'Google Places API Place ID for this gym';
COMMENT ON COLUMN academias.horarios_funcionamento IS 'Opening hours from Google Places API, format: {day: {open, close}}';
COMMENT ON COLUMN academias.fotos IS 'Array of photo references from Google Places API';
COMMENT ON COLUMN academias.ultima_atualizacao_google IS 'Last time Google Places data was fetched';
COMMENT ON COLUMN academias.dados_google_cache IS 'Full cache of Google Places API response for analytics';
