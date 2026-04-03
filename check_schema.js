const postgres = require("postgres");
const fs = require("fs");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL);

async function check() {
  try {
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    fs.writeFileSync('tables.txt', tables.map(t => t.table_name).join(', '));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
