const postgres = require('postgres');
require('dotenv').config();

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false }
});

async function check() {
    try {
        const table_name = 'avaliacoes_treinos';
        const cols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = ${table_name}
    `;
        console.log('avaliacoes_treinos columns:', cols);

        const table_name2 = 'personal_profiles';
        const cols2 = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = ${table_name2}
    `;
        console.log('personal_profiles columns:', cols2);

        const table_name3 = 'agendamentos';
        const cols3 = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = ${table_name3}
    `;
        console.log('agendamentos columns:', cols3);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit();
    }
}

check();
