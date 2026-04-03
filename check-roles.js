const postgres = require('postgres');
const databaseUrl = process.env.DATABASE_URL;
const sql = postgres(databaseUrl, { ssl: { rejectUnauthorized: false } });

async function checkRoles() {
  try {
    const roles = await sql`SELECT role, COUNT(*) FROM usuarios GROUP BY role`;
    console.log(JSON.stringify(roles, null, 2));
    
    const admin = await sql`SELECT email, role FROM usuarios WHERE email = 'comercial.movtapp@gmail.com'`;
    console.log("Admin user current state in DB:");
    console.log(JSON.stringify(admin, null, 2));
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkRoles();
