
require("dotenv").config();
const postgres = require("postgres");

const databaseUrl = process.env.DATABASE_URL;

const sql = postgres(databaseUrl, {
  ssl: {
    rejectUnauthorized: false
  }
});

async function setup() {
  console.log("Iniciando setup das categorias de comunidade...");
  try {
    // Criar tabela se não existir
    await sql`
      CREATE TABLE IF NOT EXISTS comunidade_categorias (
        id SERIAL PRIMARY KEY,
        nome TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log("Tabela comunidade_categorias ok.");

    // Inserir categorias padrão
    const defaultCategories = ["Corrida", "Funcional", "Yoga", "Ciclismo", "Outros"];
    for (const cat of defaultCategories) {
      await sql`
        INSERT INTO comunidade_categorias (nome)
        VALUES (${cat})
        ON CONFLICT (nome) DO NOTHING
      `;
    }
    console.log("Categorias padrão inseridas.");

  } catch (error) {
    console.error("Erro no setup:", error);
  } finally {
    await sql.end();
  }
}

setup();
