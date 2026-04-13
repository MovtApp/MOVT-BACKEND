const postgres = require('postgres');
require('dotenv').config();

const sql = postgres(process.env.DATABASE_URL);

async function fullReset() {
  try {
    console.log('--- OPERAÇÃO: FULL RESET COMUNIDADES ---');
    
    // 1. Limpar tabela de membros confirmados (para permitir que entrem de novo)
    console.log('Limpando community_members...');
    await sql`DELETE FROM community_members`;
    
    // 2. Zerar contadores na tabela de comunidades
    console.log('Zerando contadores na tabela comunidades...');
    await sql`UPDATE comunidades SET participantes = 0`;
    
    // 3. Resetar limite mensal de todos os usuários (para testes ficarem livres)
    console.log('Resetando limites de planos dos usuários...');
    await sql`UPDATE usuarios SET community_joins_month = 0`;

    console.log('✅ SUCESSO: Tudo limpo e zerado. Agora você pode participar normalmente.');
    
    const status = await sql`SELECT id_comunidade, nome, participantes FROM comunidades ORDER BY id_comunidade ASC`;
    console.table(status);
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro no reset:', err);
    process.exit(1);
  }
}

fullReset();
