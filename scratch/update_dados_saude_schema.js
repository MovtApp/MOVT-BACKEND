const postgres = require('postgres');
require('dotenv').config();

const sql = postgres(process.env.DATABASE_URL);

async function run() {
  try {
    console.log("Adicionando colunas de saúde à tabela dados_saude...");
    
    await sql`ALTER TABLE dados_saude ADD COLUMN IF NOT EXISTS steps INTEGER DEFAULT 0`;
    await sql`ALTER TABLE dados_saude ADD COLUMN IF NOT EXISTS heart_rate INTEGER DEFAULT 0`;
    await sql`ALTER TABLE dados_saude ADD COLUMN IF NOT EXISTS water_intake_ml INTEGER DEFAULT 0`;
    await sql`ALTER TABLE dados_saude ADD COLUMN IF NOT EXISTS sleep_hours FLOAT DEFAULT 0`;
    await sql`ALTER TABLE dados_saude ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()`;
    
    console.log("Colunas adicionadas com sucesso!");
    process.exit(0);
  } catch (e) {
    console.error("Erro ao adicionar colunas:", e);
    process.exit(1);
  }
}

run();
