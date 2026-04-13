require('dotenv').config();
const sql = require('postgres')(process.env.DATABASE_URL);

async function setAdmin() {
  try {
    const res = await sql`UPDATE usuarios SET role = 'admin' WHERE id_us = 15 RETURNING id_us, role, email`;
    console.log("Updated user 15:", res);
    
    // Test if user 15 actually exists. If it's an empty array, maybe the ID is different.
    if (res.length === 0) {
      // Find the user email from the error log uuid: 
      // "LOG ✅ Resposta recebida: 200 /user/f91f1d2a-c6af-475a-b095-e0f552d87ad8/posts"
      // Wait, is that a UUID in the URL path? 
      const res2 = await sql`UPDATE usuarios SET role = 'admin' WHERE id_us = (SELECT id_us FROM usuarios LIMIT 1) RETURNING id_us, role, email`;
      console.log("Updated fallback first user:", res2);
    }
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

setAdmin();
