const postgres = require("postgres");
const axios = require("axios");
require("dotenv").config();

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_PLACES_BASE_URL = 'https://maps.googleapis.com/maps/api/place';
const sql = postgres(process.env.DATABASE_URL);

async function fixGyms() {
  try {
    const gyms = await sql`SELECT id_academia, google_place_id, nome FROM academias WHERE (telefone IS NULL OR telefone = '') AND google_place_id IS NOT NULL`;
    console.log(`Encontradas ${gyms.length} academias sem telefone.`);

    for (const gym of gyms) {
      console.log(`Buscando telefone para: ${gym.nome} (${gym.google_place_id})`);
      const response = await axios.get(`${GOOGLE_PLACES_BASE_URL}/details/json`, {
        params: {
          place_id: gym.google_place_id,
          fields: 'formatted_phone_number,international_phone_number',
          key: GOOGLE_PLACES_API_KEY
        }
      });

      if (response.data.status === 'OK' && response.data.result) {
        const phone = response.data.result.formatted_phone_number || response.data.result.international_phone_number;
        if (phone) {
          console.log(`Telefone encontrado: ${phone}. Atualizando...`);
          await sql`UPDATE academias SET telefone = ${phone} WHERE id_academia = ${gym.id_academia}`;
        } else {
          console.log(`Nenhum telefone encontrado no Google para esta unidade.`);
        }
      } else {
        console.log(`Erro ao buscar no Google: ${response.data.status}`);
      }
    }

    console.log("Processo concluído.");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixGyms();
