require("dotenv").config();
const postgres = require("postgres");

const databaseUrl = process.env.DATABASE_URL;

const sql = postgres(databaseUrl, {
  ssl: {
    rejectUnauthorized: false
  }
});

async function resetCalories() {
  try {
    console.log("🚀 Iniciando o reset de calorias para todos os usuários...");
    
    // Podemos escolher entre setar para 0 ou deletar os registros. 
    // "Zerar" geralmente implica em colocar o valor como 0.
    const result = await sql`
      UPDATE dados_saude 
      SET calories = 0 
      WHERE calories IS NOT NULL
    `;
    
    console.log(`✅ Sucesso! O valor de calorias foi zerado em todos os registros.`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Erro ao zerar calorias:", err);
    process.exit(1);
  }
}

resetCalories();
