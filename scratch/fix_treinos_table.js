const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false } });

async function fix() {
  try {
    console.log('Adding columns...');
    await sql`ALTER TABLE conteudo_treinos ADD COLUMN IF NOT EXISTS description TEXT`;
    await sql`ALTER TABLE conteudo_treinos ADD COLUMN IF NOT EXISTS exercicios JSONB DEFAULT '[]'`;
    await sql`ALTER TABLE conteudo_treinos ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE`;
    
    // Garantir que treinos existentes tenham ativo = true
    await sql`UPDATE conteudo_treinos SET ativo = TRUE WHERE ativo IS NULL`;
    
    console.log('Table conteudo_treinos updated successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Error updating table:', err);
    process.exit(1);
  }
}

fix();
