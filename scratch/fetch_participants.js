const postgres = require('postgres');
require('dotenv').config();

const sql = postgres(process.env.DATABASE_URL);

async function fetchParticipants() {
  try {
    const comunidades = await sql`
      SELECT id_comunidade, nome, participantes, max_participantes 
      FROM comunidades 
      ORDER BY id_comunidade ASC
    `;
    
    console.log('--- RESULTADO DA BUSCA NO BANCO ---');
    console.table(comunidades);
    
    const totalConfirmados = comunidades.reduce((acc, c) => acc + (Number(c.participantes) || 0), 0);
    console.log(`\nTOTAL DE PARTICIPANTES CONFIRMADOS EM TODAS AS COMUNIDADES: ${totalConfirmados}`);
    
    process.exit(0);
  } catch (err) {
    console.error('Erro ao buscar dados:', err);
    process.exit(1);
  }
}

fetchParticipants();
