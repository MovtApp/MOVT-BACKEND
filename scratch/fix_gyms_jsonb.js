const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false }
});

async function fixGymData() {
  try {
    console.log("--- INICIANDO CORREÇÃO DE DADOS DE ACADEMIAS ---");
    
    // Buscar todas as academias
    const gyms = await sql`SELECT id_academia, nome, horarios_funcionamento, dados_google_cache FROM academias`;
    console.log(`Encontradas ${gyms.length} academias.`);

    let fixedCount = 0;

    for (const gym of gyms) {
      let needsUpdate = false;
      let newHorarios = gym.horarios_funcionamento;
      let newCache = gym.dados_google_cache;

      // Corrigir horarios_funcionamento se for string
      if (typeof gym.horarios_funcionamento === 'string') {
        try {
          newHorarios = JSON.parse(gym.horarios_funcionamento);
          needsUpdate = true;
          console.log(`Corrigindo horarios_funcionamento para: ${gym.nome}`);
        } catch (e) {
          console.warn(`Erro ao parsear horarios_funcionamento para ${gym.nome}:`, e.message);
        }
      }

      // Corrigir dados_google_cache se for string
      if (typeof gym.dados_google_cache === 'string') {
        try {
          newCache = JSON.parse(gym.dados_google_cache);
          needsUpdate = true;
          console.log(`Corrigindo dados_google_cache para: ${gym.nome}`);
        } catch (e) {
          console.warn(`Erro ao parsear dados_google_cache para ${gym.nome}:`, e.message);
        }
      }

      if (needsUpdate) {
        await sql`
          UPDATE academias 
          SET 
            horarios_funcionamento = ${sql.json(newHorarios)},
            dados_google_cache = ${sql.json(newCache)}
          WHERE id_academia = ${gym.id_academia}
        `;
        fixedCount++;
      }
    }

    console.log(`\n--- SUCESSO: ${fixedCount} academias corrigidas. ---`);
    process.exit(0);
  } catch (err) {
    console.error("Erro fatal na migração:", err);
    process.exit(1);
  }
}

fixGymData();
