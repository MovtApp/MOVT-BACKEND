const postgres = require('postgres');
require('dotenv').config();

const sql = postgres(process.env.DATABASE_URL);

async function zeroParticipants() {
  try {
    console.log('--- OPERAÇÃO: ZERAR PARTICIPANTES ---');
    
    // Primeiro, vamos ver o estado atual
    const antes = await sql`SELECT SUM(CAST(participantes AS INTEGER)) as total FROM comunidades`;
    console.log(`Total antes da operação: ${antes[0].total}`);

    // Executa o update enviando 0 (ou '0' se for string, o postgres-js lida bem com tipos)
    await sql`UPDATE comunidades SET participantes = 0`;
    
    console.log('✅ Sucesso: Todas as comunidades agora possuem 0 participantes confirmados.');
    
    // Verifica o resultado
    const depois = await sql`SELECT id_comunidade, nome, participantes FROM comunidades ORDER BY id_comunidade ASC`;
    console.table(depois);
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro ao zerar participantes:', err);
    process.exit(1);
  }
}

zeroParticipants();
