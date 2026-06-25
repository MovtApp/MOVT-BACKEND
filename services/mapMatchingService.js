/**
 * mapMatchingService — encaixa uma sequência de pontos GPS na malha viária real
 * (snap-to-roads) usando a Mapbox Map Matching API.
 *
 * POR QUE: a linha do treino ligava os pings de GPS com retas, cortando esquinas
 * e curvas. O map-matching casa os pontos com as ruas reais e devolve a GEOMETRIA
 * da via, fazendo o traçado seguir o caminho de verdade.
 *
 * SEGURANÇA: a chave (MAPBOX_TOKEN) vive só aqui, no servidor. O app fala com o
 * proxy /api/route/snap, nunca direto com a Mapbox.
 *
 * GUARDA-CORPO: a API devolve um `confidence` (0..1). Quem chama decide um piso —
 * se o match for fraco (correu em parque/trilha/pista sem rua mapeada), o cliente
 * mantém a linha suavizada crua em vez de "grudar" o trajeto numa rua errada.
 *
 * DISTÂNCIA: NÃO é recalculada aqui. O snap muda levemente o comprimento; a
 * distância/pace continuam vindo da rota crua no cliente.
 */
const axios = require("axios");

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BASE_URL = "https://api.mapbox.com/matching/v5/mapbox";

// Limites da Mapbox / parâmetros de qualidade.
const MAX_COORDS = 100; // máximo de coordenadas por requisição de matching
const OVERLAP = 4; // pontos de sobreposição entre janelas (costura o traçado)
const MIN_RADIUS_M = 4; // raio de busca mínimo por ponto
const MAX_RADIUS_M = 50; // teto da Mapbox para o raio de busca

/** Perfil de roteamento por modalidade. */
function profileFor(kind) {
  return kind === "Ciclismo" ? "cycling" : "walking";
}

/** Raio de busca por ponto, derivado da acurácia do GPS (clampado ao teto da Mapbox). */
function clampRadius(accuracy) {
  const a =
    typeof accuracy === "number" && isFinite(accuracy) && accuracy > 0 ? accuracy : 20;
  return Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, a)));
}

/** Casa um lote de até 100 pontos. Retorna { coords:[[lon,lat]], confidence } ou null. */
async function matchChunk(points, profile) {
  const coordsStr = points.map((p) => `${p.longitude},${p.latitude}`).join(";");
  const radiuses = points.map((p) => clampRadius(p.accuracy)).join(";");

  const res = await axios.get(`${BASE_URL}/${profile}/${coordsStr}`, {
    params: {
      access_token: MAPBOX_TOKEN,
      geometries: "geojson",
      overview: "full",
      tidy: "true", // remove pontos amontoados (jitter de GPS parado)
      steps: "false",
      radiuses,
    },
    timeout: 8000,
  });

  const data = res.data;
  if (
    !data ||
    data.code !== "Ok" ||
    !Array.isArray(data.matchings) ||
    data.matchings.length === 0
  ) {
    return null;
  }

  // A API quebra em vários "matchings" quando há um gap grande entre pontos.
  // Concatena na ordem; a confiança final é a MENOR (conservador).
  let coords = [];
  let minConf = 1;
  for (const m of data.matchings) {
    const g = m.geometry && Array.isArray(m.geometry.coordinates) ? m.geometry.coordinates : [];
    coords = coords.concat(g);
    if (typeof m.confidence === "number") minConf = Math.min(minConf, m.confidence);
  }
  return coords.length > 0 ? { coords, confidence: minConf } : null;
}

/**
 * Encaixa a rota inteira nas ruas. Faz o chunking de 100 pts com sobreposição.
 * @param {Array<{latitude:number,longitude:number,accuracy?:number}>} points
 * @param {"Corrida"|"Ciclismo"} kind
 * @returns {Promise<{snapped:Array<{latitude:number,longitude:number}>, confidence:number}>}
 */
async function snapRoute(points, kind) {
  if (!MAPBOX_TOKEN) throw new Error("MAPBOX_TOKEN ausente no ambiente.");

  const clean = (Array.isArray(points) ? points : []).filter(
    (p) =>
      p &&
      typeof p.latitude === "number" &&
      isFinite(p.latitude) &&
      typeof p.longitude === "number" &&
      isFinite(p.longitude)
  );
  if (clean.length < 2) return { snapped: [], confidence: 0 };

  const profile = profileFor(kind);
  const toLatLng = ([lon, lat]) => ({ latitude: lat, longitude: lon });

  // Janela única quando cabe no limite da Mapbox.
  if (clean.length <= MAX_COORDS) {
    const r = await matchChunk(clean, profile);
    if (!r) return { snapped: [], confidence: 0 };
    return { snapped: r.coords.map(toLatLng), confidence: r.confidence };
  }

  // Várias janelas com sobreposição (costura contínua).
  let outCoords = [];
  let minConf = 1;
  let i = 0;
  let firstChunk = true;
  while (i < clean.length) {
    const chunk = clean.slice(i, i + MAX_COORDS);
    const r = await matchChunk(chunk, profile);
    if (r) {
      // Descarta o 1º ponto das janelas seguintes para não duplicar a costura.
      outCoords = outCoords.concat(firstChunk ? r.coords : r.coords.slice(1));
      minConf = Math.min(minConf, r.confidence);
    }
    firstChunk = false;
    if (i + MAX_COORDS >= clean.length) break;
    i += MAX_COORDS - OVERLAP;
  }
  if (outCoords.length === 0) return { snapped: [], confidence: 0 };
  return { snapped: outCoords.map(toLatLng), confidence: minConf };
}

module.exports = { snapRoute };
