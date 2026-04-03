require("dotenv").config();
const postgres = require("postgres");
const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});
async function up() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS family_groups (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER REFERENCES usuarios(id_us) ON DELETE CASCADE,
        max_members INTEGER NOT NULL DEFAULT 1,
        stripe_subscription_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("family_groups created");

    await sql`
      CREATE TABLE IF NOT EXISTS family_invites (
        id SERIAL PRIMARY KEY,
        group_id INTEGER REFERENCES family_groups(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("family_invites created");

    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS family_group_id INTEGER REFERENCES family_groups(id) ON DELETE SET NULL`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS family_role VARCHAR(50) DEFAULT 'none'`;
    console.log("usuarios altered");
  } catch (error) {
    console.error(error);
  } finally {
    process.exit(0);
  }
}
up();
