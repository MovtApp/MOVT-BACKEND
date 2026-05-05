/**
 * Migration: Add secao_home column to conteudo_treinos
 * 
 * This column allows admins to assign trainings to specific home screen sections:
 * - 'popular'           → Exercícios Populares
 * - 'plano_do_dia'      → Plano do Dia
 * - 'melhores_para_voce'→ Melhores Para Você
 * - 'desafio'           → Desafios
 * - 'aquecimento'       → Aquecimento Rápido
 * - NULL                → Sem destaque (padrão)
 */

require('dotenv').config({ path: '../.env' });
const postgres = require('postgres');

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  connect_timeout: 30,
});

async function migrate() {
  try {
    console.log('🔧 Adding secao_home column to conteudo_treinos...');

    await sql`
      ALTER TABLE conteudo_treinos
      ADD COLUMN IF NOT EXISTS secao_home VARCHAR(50) DEFAULT NULL
    `;

    console.log('✅ Column secao_home added successfully!');
    console.log('📋 Valid values: popular, plano_do_dia, melhores_para_voce, desafio, aquecimento, NULL');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await sql.end();
  }
}

migrate();
