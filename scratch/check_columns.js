const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false } });

async function check() {
  try {
    const res = await sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'conteudo_treinos'
    `;
    console.log('Columns in conteudo_treinos:');
    res.forEach(r => console.log('- ' + r.column_name));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
