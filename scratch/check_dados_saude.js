const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    const cols = await sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'dados_saude'`;
    console.log('DADOS_SAUDE COLUMNS:');
    cols.forEach(c => console.log(`${c.column_name}: ${c.is_nullable}`));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
check();
