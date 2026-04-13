const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false }
});

async function checkFollows() {
  try {
    console.log("--- ULTIMOS FOLLOWS ---");
    const follows = await sql`
      SELECT f.*, u1.username as follower, u2.username as followed
      FROM follows f
      JOIN usuarios u1 ON f.follower_user_id = u1.id_us
      JOIN usuarios u2 ON f.followed_user_id = u2.id_us
      ORDER BY f.created_at DESC
      LIMIT 10
    `;
    console.table(follows);

    console.log("\n--- ULTIMAS NOTIFICACOES ---");
    const notifs = await sql`
      SELECT n.*, u.username as sender
      FROM notifications n
      LEFT JOIN usuarios u ON n.sender_id = u.id_us
      ORDER BY n.created_at DESC
      LIMIT 10
    `;
    console.table(notifs);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkFollows();
