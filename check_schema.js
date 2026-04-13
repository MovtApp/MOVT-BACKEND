const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false }
});

async function checkSchema() {
  try {
    const follows = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'follows'`;
    console.log('FOLLOWS:', follows.map(f => f.column_name).join(', '));

    const notifs = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'`;
    console.log('NOTIFICATIONS:', notifs.map(n => n.column_name).join(', '));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkSchema();
