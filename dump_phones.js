const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL);

async function check() {
  try {
    const res = await sql`SELECT nome, dados_google_cache FROM academias`;
    for (const r of res) {
        console.log(`Nome: ${r.nome}`);
        console.log(`Phone: ${r.dados_google_cache?.formatted_phone_number || 'N/A'}`);
        console.log('---');
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
