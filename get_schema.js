require("dotenv").config();
const postgres = require("postgres");
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false } });
async function run() {
  try {
    const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'academias'`;
    console.log(JSON.stringify(cols.map(c => c.column_name)));
  } catch (e) { console.error(e); }
  finally { process.exit(0); }
}
run();
