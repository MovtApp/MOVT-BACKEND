const axios = require('axios');

/**
 * Busca academias próximas via Google Places API
 * @param {number} lat Latitude
 * @param {number} lng Longitude
 * @param {number} radius Raio em metros
 * @returns {Promise<Array>} Lista de academias formatadas
 */
async function searchNearbyGyms(lat, lng, radius = 5000) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("⚠️ GOOGLE_PLACES_API_KEY não configurada no backend.");
    return [];
  }

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=gym&key=${apiKey}`;

  try {
    const response = await axios.get(url);
    if (response.data.status !== "OK" && response.data.status !== "ZERO_RESULTS") {
      console.error("❌ Erro Google Places API:", response.data.status, response.data.error_message);
      return [];
    }

    const places = response.data.results || [];
    
    // Formatar para o padrão do MOVT
    return places.map(place => ({
      google_place_id: place.place_id,
      nome: place.name,
      rating: place.rating || 0,
      total_avaliacoes: place.user_ratings_total || 0,
      endereco_completo: place.vicinity || "",
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
      fotos: place.photos ? place.photos.map(p => ({
        reference: p.photo_reference,
        width: p.width,
        height: p.height
      })) : [],
      open_now: place.opening_hours ? place.opening_hours.open_now : null,
      source: "google_places_api",
      ativo: true
    }));
  } catch (error) {
    console.error("❌ Erro ao chamar Google Places:", error.message);
    return [];
  }
}

module.exports = {
  searchNearbyGyms
};
