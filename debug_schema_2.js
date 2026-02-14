const postgres = require('postgres');
require('dotenv').config();

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false }
});

async function check() {
    try {
        const tables = ['avaliacoes_treinos', 'personal_profiles', 'agendamentos'];
        for (const table of tables) {
            const cols = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = ${table}
      `;
            console.log(`--- ${table} ---`);
            cols.forEach(c => console.log(`${c.column_name}: ${c.data_type}`));
        }
    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit();
    }
}

check();
