const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false }
});

async function checkRaw() {
  try {
    console.log("--- FOLLOWS (RAW) ---");
    const follows = await sql`SELECT * FROM follows ORDER BY created_at DESC LIMIT 5`;
    console.log(JSON.stringify(follows, null, 2));

    console.log("\n--- NOTIFICAÇÕES (RAW) ---");
    const notifs = await sql`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5`;
    console.log(JSON.stringify(notifs, null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkRaw();
