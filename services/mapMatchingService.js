/**
 * mapMatchingService — encaixa uma sequência de pontos GPS na malha viária real
 * (snap-to-roads) usando a Mapbox Map Matching API, de forma HÍBRIDA.
 *
 * POR QUE HÍBRIDO: a versão anterior devolvia só a GEOMETRIA das vias casadas.
 * Ao entrar em parque, viela, calçadão ou passarela (sem via mapeada), a Mapbox
 * ou "grudava" o trajeto na rua da borda ou descartava aquele trecho — a linha do
 * treino congelava na entrada do parque, mesmo com o GPS registrando o percurso
 * lá dentro. Como o piso de confiança era o MÍNIMO de todos os trechos, um pedaço
 * off-road ainda derrubava o snap inteiro.
 *
 * COMO RESOLVE: usamos os `tracepoints` da própria Mapbox — o campo que diz, ponto
 * a ponto enviado, se ele CASOU com uma via (objeto) ou NÃO (null = off-road).
 * Cada ponto começa como o ponto CRU (suavizado no app) e só recebe "upgrade" para
 * a posição encaixada quando a Mapbox casou com uma via. O resultado é UMA linha
 * contínua: encaixada onde há rua/calçada mapeada, seguindo o trajeto real onde
 * não há. Nunca abandona o usuário e nunca gruda numa rua errada.
 *
 * ALINHAMENTO: `tidy:"false"` é essencial — com tidy ligado a Mapbox reordena/
 * descarta pontos e os `tracepoints` deixam de alinhar 1:1 com o que enviamos.
 * O jitter de GPS parado já é tratado no app (Kalman + gate de acurácia) e o
 * Douglas-Peucker de exibição colapsa pontos coincidentes.
 *
 * PERFIL: `walking` (corrida) inclui calçadas/vias de pedestre do OSM, então
 * trechos de parque MAPEADOS como footway chegam a encaixar também; só o que é
 * de fato não mapeado permanece cru.
 *
 * SEGURANÇA: a chave (MAPBOX_TOKEN) vive só aqui, no servidor. O app fala com o
 * proxy /api/route/snap, nunca direto com a Mapbox.
 *
 * CONFIANÇA: com o híbrido não há mais risco de "grudar na via errada" (off-road
 * fica cru), então `confidence` virou binário: 1 quando produzimos uma linha
 * híbrida (ao menos um ponto casou) e 0 quando nada casou / a Mapbox falhou — aí
 * o cliente mantém a própria linha crua, como antes. O piso de confiança do app
 * (legado) segue funcionando sem alteração.
 *
 * DISTÂNCIA: NÃO é recalculada aqui. A distância/pace continuam vindo da rota crua
 * no cliente.
 */
const axios = require("axios");

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const BASE_URL = "https://api.mapbox.com/matching/v5/mapbox";

// Limites da Mapbox / parâmetros de qualidade.
const MAX_COORDS = 100; // máximo de coordenadas por requisição de matching
const OVERLAP = 4; // pontos de sobreposição entre janelas (continuidade nas bordas)
const MIN_RADIUS_M = 4; // raio de busca mínimo por ponto
const MAX_RADIUS_M = 50; // teto da Mapbox para o raio de busca

/** Perfil de roteamento por modalidade. */
function profileFor(kind) {
  return kind === "Ciclismo" ? "cycling" : "walking";
}

/** Raio de busca por ponto, derivado da acurácia do GPS (clampado ao teto da Mapbox).
 * É também o "detector" de off-road: se não houver via dentro do raio, a Mapbox
 * devolve tracepoint null e o ponto permanece cru. */
function clampRadius(accuracy) {
  const a =
    typeof accuracy === "number" && isFinite(accuracy) && accuracy > 0 ? accuracy : 20;
  return Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, a)));
}

/** Um ponto do tracepoint é válido para "upgrade" se tem location [lon,lat] finita. */
function tracepointLatLng(tp) {
  if (!tp || !Array.isArray(tp.location) || tp.location.length < 2) return null;
  const [lon, lat] = tp.location;
  if (typeof lat !== "number" || !isFinite(lat)) return null;
  if (typeof lon !== "number" || !isFinite(lon)) return null;
  return { latitude: lat, longitude: lon };
}

/**
 * Casa uma janela de até 100 pontos e devolve os `tracepoints` alinhados 1:1 com
 * a entrada (ou null em erro/resposta inválida). Não usamos a geometria das vias —
 * o encaixe é ponto-a-ponto via tracepoint.location, o que preserva a densidade
 * dos pings (a ~0,5–2 s a linha já fica lisa) e permite manter o cru off-road.
 */
async function matchWindow(points, profile) {
  const coordsStr = points.map((p) => `${p.longitude},${p.latitude}`).join(";");
  const radiuses = points.map((p) => clampRadius(p.accuracy)).join(";");

  const res = await axios.get(`${BASE_URL}/${profile}/${coordsStr}`, {
    params: {
      access_token: MAPBOX_TOKEN,
      geometries: "geojson",
      overview: "false", // não usamos a geometria da via; encaixe é por tracepoint
      tidy: "false", // ESSENCIAL: mantém tracepoints alinhados 1:1 com a entrada
      steps: "false",
      radiuses,
    },
    timeout: 8000,
  });

  const data = res.data;
  if (!data || data.code !== "Ok" || !Array.isArray(data.tracepoints)) return null;
  return data.tracepoints;
}

/**
 * Aplica o matching de uma janela sobre o array de saída `out` (default cru),
 * fazendo upgrade dos pontos que casaram com uma via. `start` é o índice do
 * primeiro ponto da janela no array completo. Retorna quantos casaram.
 */
function applyWindow(out, tracepoints, start) {
  let matched = 0;
  for (let j = 0; j < tracepoints.length; j++) {
    const idx = start + j;
    if (idx >= out.length) break; // guarda: nunca escreve fora do array de saída
    const ll = tracepointLatLng(tracepoints[j]);
    if (ll) {
      out[idx] = ll;
      matched++;
    }
  }
  return matched;
}

/**
 * Encaixa a rota inteira nas ruas de forma híbrida. Faz o chunking de 100 pts com
 * sobreposição. Cada ponto começa cru e recebe upgrade só onde há via.
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

  // Default: cada ponto é o CRU. As janelas de matching só fazem upgrade dos que
  // casam com uma via — off-road (e falhas da Mapbox) permanecem crus.
  const out = clean.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
  let totalMatched = 0;

  // Janela única quando cabe no limite da Mapbox.
  if (clean.length <= MAX_COORDS) {
    const tps = await matchWindow(clean, profile);
    if (tps) totalMatched += applyWindow(out, tps, 0);
  } else {
    // Várias janelas com sobreposição. A saída é indexada pelo ponto de entrada,
    // então janelas que se sobrepõem apenas reescrevem os mesmos índices — sem
    // duplicação e sem necessidade de "costurar" bordas manualmente.
    let i = 0;
    while (i < clean.length) {
      const chunk = clean.slice(i, i + MAX_COORDS);
      const tps = await matchWindow(chunk, profile);
      if (tps) totalMatched += applyWindow(out, tps, i);
      if (i + MAX_COORDS >= clean.length) break;
      i += MAX_COORDS - OVERLAP;
    }
  }

  // Nada casou (rota 100% off-road ou Mapbox indisponível): devolve vazio para o
  // cliente manter a própria linha crua — comportamento idêntico ao legado, sem
  // trafegar uma cópia redundante do cru.
  if (totalMatched === 0) return { snapped: [], confidence: 0 };

  // Ao menos um trecho casou: entregamos a linha híbrida. Confiança binária (1) —
  // não há risco de "rua errada" porque off-road ficou cru (ver cabeçalho).
  return { snapped: out, confidence: 1 };
}

module.exports = { snapRoute };
