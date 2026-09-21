/**
 * mapMatchingService — encaixa uma sequência de pontos GPS na malha viária real
 * (snap-to-roads) usando a Mapbox Map Matching API.
 *
 * A versão anterior usava `tracepoints[].location`, isto é, encaixava cada ping
 * isoladamente. Em paralelas, alças e viadutos isso permite alternar entre vias e
 * deixa retas tremidas. Agora usamos `matchings[].geometry` completa: a sequência
 * é resolvida na rede viária como um trajeto, com timestamps e amostragem estável.
 *
 * PERFIL: `walking` (corrida) inclui calçadas/vias de pedestre do OSM, então
 * trechos de parque MAPEADOS como footway chegam a encaixar também; só o que é
 * de fato não mapeado permanece cru.
 *
 * SEGURANÇA: a chave (MAPBOX_TOKEN) vive só aqui, no servidor. O app fala com o
 * proxy /api/route/snap, nunca direto com a Mapbox.
 *
 * CONFIANÇA: matches ambíguos ou fracos não são usados. Nesse caso devolvemos
 * vazio e o app mantém a rota filtrada, em vez de inventar uma rua ou passarela.
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
const MAX_RADIUS_M = 25; // não cruza para vias paralelas quando o GPS está limpo
const TARGET_SAMPLE_MS = 5000; // cadência recomendada pela Mapbox para matching
const MIN_MATCH_CONFIDENCE = 0.7;

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
  // Pequena margem cobre a diferença entre a estimativa do dispositivo e a via,
  // sem permitir o salto para uma rua/nível paralelo distante.
  return Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, a + 3)));
}

/** Reduz uma trilha densa para uma cadência útil ao algoritmo sem perder início/fim. */
function sampleTrace(points) {
  if (points.length <= 2) return points;
  const sampled = [points[0]];
  let lastTs = typeof points[0].timestamp === "number" ? points[0].timestamp : null;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const ts = typeof p.timestamp === "number" ? p.timestamp : null;
    if (lastTs === null || ts === null || ts - lastTs >= TARGET_SAMPLE_MS) {
      sampled.push(p);
      lastTs = ts;
    }
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

function timestampsFor(points) {
  const seconds = points.map((p) =>
    typeof p.timestamp === "number" && isFinite(p.timestamp) ? Math.floor(p.timestamp / 1000) : null
  );
  if (seconds.some((ts) => ts === null)) return null;
  for (let i = 1; i < seconds.length; i++) {
    if (seconds[i] <= seconds[i - 1]) return null;
  }
  return seconds.join(";");
}

/** Casa uma janela de até 100 pontos e devolve a geometria contínua da via. */
async function matchWindow(points, profile) {
  const coordsStr = points.map((p) => `${p.longitude},${p.latitude}`).join(";");
  const radiuses = points.map((p) => clampRadius(p.accuracy)).join(";");

  const timestamps = timestampsFor(points);
  const res = await axios.get(`${BASE_URL}/${profile}/${coordsStr}`, {
    params: {
      access_token: MAPBOX_TOKEN,
      geometries: "geojson",
      overview: "full",
      tidy: "true",
      steps: "false",
      radiuses,
      ...(timestamps ? { timestamps } : {}),
    },
    timeout: 8000,
  });

  const data = res.data;
  if (!data || data.code !== "Ok" || !Array.isArray(data.matchings)) return null;
  const matches = data.matchings.filter(
    (match) =>
      typeof match?.confidence === "number" &&
      match.confidence >= MIN_MATCH_CONFIDENCE &&
      Array.isArray(match?.geometry?.coordinates) &&
      match.geometry.coordinates.length >= 2
  );
  // Vários submatches indicam ambiguidade. Não os conectamos artificialmente:
  // o cliente preserva a rota filtrada, que é mais honesta que uma via errada.
  if (matches.length !== 1) return null;
  return {
    confidence: matches[0].confidence,
    coordinates: matches[0].geometry.coordinates,
  };
}

function appendGeometry(out, coordinates) {
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const [longitude, latitude] = coordinate;
    if (!isFinite(latitude) || !isFinite(longitude)) continue;
    const previous = out[out.length - 1];
    if (previous && previous.latitude === latitude && previous.longitude === longitude) continue;
    out.push({ latitude, longitude });
  }
}

function appendRawPoints(out, points) {
  for (const point of points) {
    if (!point || !isFinite(point.latitude) || !isFinite(point.longitude)) continue;
    const previous = out[out.length - 1];
    if (previous && previous.latitude === point.latitude && previous.longitude === point.longitude) continue;
    out.push({ latitude: point.latitude, longitude: point.longitude });
  }
}

/**
 * Encaixa a rota inteira nas ruas de forma híbrida. Faz o chunking de 100 pts com
 * sobreposição. Cada ponto começa cru e recebe upgrade só onde há via.
 * @param {Array<{latitude:number,longitude:number,accuracy?:number}>} points
 * @param {"Corrida"|"Ciclismo"} kind
 * @returns {Promise<{snapped:Array<{latitude:number,longitude:number}>, confidence:number}>}
 */
async function snapContinuousRoute(points, kind) {
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

  const sampled = sampleTrace(clean);
  const out = [];
  let confidenceSum = 0;
  let matchCount = 0;

  // Janela única quando cabe no limite da Mapbox.
  if (sampled.length <= MAX_COORDS) {
    const match = await matchWindow(sampled, profile);
    if (match) {
      appendGeometry(out, match.coordinates);
      confidenceSum += match.confidence;
      matchCount++;
    } else {
      // Parque, viela ou trilha não mapeada: mantém a sequência GPS em vez de
      // deslocar o atleta para a rua mais próxima.
      appendRawPoints(out, sampled);
    }
  } else {
    // Janelas com sobreposição para preservar continuidade nas bordas.
    let i = 0;
    while (i < sampled.length) {
      const chunk = sampled.slice(i, i + MAX_COORDS);
      const match = await matchWindow(chunk, profile);
      if (match) {
        appendGeometry(out, match.coordinates);
        confidenceSum += match.confidence;
        matchCount++;
      } else {
        // Só este chunk cai para GPS; os chunks de rua continuam respeitando a
        // geometria real. Não abortamos a rota inteira por uma trilha ambígua.
        appendRawPoints(out, chunk);
      }
      if (i + MAX_COORDS >= sampled.length) break;
      i += MAX_COORDS - OVERLAP;
    }
  }

  // Nada casou (rota 100% off-road ou Mapbox indisponível): confiança zero faz o
  // cliente manter sua rota filtrada completa, enquanto os casos híbridos acima
  // aproveitam apenas os trechos de rua confirmados.
  if (out.length < 2 || matchCount === 0) return { snapped: [], confidence: 0 };

  return { snapped: out, confidence: confidenceSum / matchCount };
}

/**
 * Processa cada trecho contínuo de forma isolada. Um gap explícito nunca pode
 * virar uma ligação reta entre o último ponto anterior e o primeiro posterior.
 */
async function snapRoute(points, kind) {
  const clean = (Array.isArray(points) ? points : []).filter(
    (p) => p && typeof p.latitude === "number" && isFinite(p.latitude)
      && typeof p.longitude === "number" && isFinite(p.longitude)
  );
  if (clean.length < 2) return { snapped: [], confidence: 0 };

  const segments = [[]];
  for (const point of clean) {
    if (point.gap && segments[segments.length - 1].length > 0) segments.push([]);
    segments[segments.length - 1].push(point);
  }

  const snapped = [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const segment of segments.filter((item) => item.length > 0)) {
    const result = segment.length >= 2
      ? await snapContinuousRoute(segment, kind)
      : { snapped: segment, confidence: 0 };
    const chosen = Array.isArray(result.snapped) && result.snapped.length > 0
      ? result.snapped
      : segment;
    if (snapped.length > 0 && chosen.length > 0) chosen[0] = { ...chosen[0], gap: true };
    snapped.push(...chosen);
    if (result.confidence > 0) {
      confidenceSum += result.confidence;
      confidenceCount += 1;
    }
  }

  return {
    snapped,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
  };
}

module.exports = { snapRoute };
