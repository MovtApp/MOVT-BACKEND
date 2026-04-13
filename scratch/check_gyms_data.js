const postgres = require("postgres");
require("dotenv").config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false }
});

async function checkGyms() {
  try {
    console.log("--- COLUNAS DA TABELA ACADEMIAS ---");
    const cols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'academias'
    `;
    console.table(cols);

    console.log("\n--- ÚLTIMA ACADEMIA ADICIONADA ---");
    const gym = await sql`
      SELECT id_academia, nome, horarios_funcionamento, dados_google_cache, google_place_id 
      FROM academias 
      ORDER BY createdat DESC 
      LIMIT 1
    `;
    
    if (gym.length > 0) {
      console.log("ID:", gym[0].id_academia);
      console.log("Nome:", gym[0].nome);
      console.log("Horários Tipo:", typeof gym[0].horarios_funcionamento);
      console.log("Horários Valor:", gym[0].horarios_funcionamento);
      console.log("Cache Tipo:", typeof gym[0].dados_google_cache);
      console.log("Cache Valor:", gym[0].dados_google_cache);
    } else {
      console.log("Nenhuma academia encontrada.");
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkGyms();
