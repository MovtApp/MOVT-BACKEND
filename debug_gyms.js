const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL);

async function check() {
  try {
    const res = await sql`SELECT nome, dados_google_cache FROM academias WHERE nome LIKE '%Nitro%'`;
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
