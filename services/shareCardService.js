/**
 * shareCardService — gera um CARD compartilhável (estilo Strava) de um treino de
 * corrida/ciclismo: o mapa real (Mapbox Static Images) com a rota desenhada por
 * cima + os números do treino e a marca MOVT "queimados" na imagem.
 *
 * POR QUE NO BACKEND: a chave da Mapbox (MAPBOX_TOKEN) vive só aqui, e gerar a
 * imagem no servidor evita um rebuild nativo do app (nada de capturar o MapView,
 * que sai preto no Android). O app só baixa o PNG pronto e abre o menu nativo de
 * compartilhamento (Instagram, WhatsApp, etc.).
 *
 * PIPELINE: rota → (downsample p/ caber na URL) → polyline codificada → URL da
 * Mapbox Static Images (path + pins) → baixa o PNG do mapa → renderiza um overlay
 * SVG (gradiente + título + data + 4 métricas + "MOVT") e compõe sobre o mapa.
 *
 * TEXTO/FONTE: usamos @resvg/resvg-js passando o BUFFER da fonte Oswald
 * (assets/fonts/Oswald.ttf) direto no render. É determinístico e idêntico em
 * Windows (dev) e Linux (Vercel) — ao contrário do fontconfig do librsvg do
 * sharp, que ignora fontes fora do sistema e cai em fallback. O sharp entra só
 * na composição final (imagem sobre imagem, sem texto).
 */
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");
// Fonte e logo embutidos em base64 (require → o bundler do Vercel sempre inclui).
const OSWALD_BASE64 = require("./oswaldFontBase64");
const LOGO_BASE64 = require("./logoBase64");

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

// Saída final (retrato 4:5 — bom para feed e stories). O Mapbox renderiza em
// metade da dimensão com @2x (540x675 @2x = 1080x1350).
const OUT_W = 1080;
const OUT_H = 1350;
const MAP_W = OUT_W / 2; // 540 — dentro do teto de 1280 da Static Images API
const MAP_H = OUT_H / 2; // 675

// Teto de pontos enviados à Static Images API (a URL tem limite de tamanho;
// no zoom do card esse nível de detalhe é mais que suficiente).
const MAX_PATH_POINTS = 280;

// Fonte empacotada (decodificada uma vez). Vem de um módulo base64 para o
// bundler do Vercel garantir que a fonte vá no pacote da função serverless —
// um fs.readFileSync do .ttf NÃO é incluído pelo bundler (texto sumia em prod).
const FONT_BUFFER = (() => {
  try {
    const buf = Buffer.from(OSWALD_BASE64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    console.warn("[shareCard] fonte Oswald indisponível — usando fontes do sistema.");
    return null;
  }
})();

// IMPORTANTE: o @resvg/resvg-js no Linux do Vercel IGNORA `fontBuffers` (texto não
// renderiza), mas respeita `fontFiles` (caminho). Então escrevemos a fonte em /tmp
// uma vez e usamos o caminho. (Confirmado por sonda em produção.)
const FONT_FILE = (() => {
  if (!FONT_BUFFER) return null;
  try {
    const p = path.join(os.tmpdir(), "movt-oswald.ttf");
    if (!fs.existsSync(p)) fs.writeFileSync(p, FONT_BUFFER);
    return p;
  } catch (e) {
    console.warn("[shareCard] não consegui gravar a fonte em tmp:", e.message);
    return null;
  }
})();

// Logo MOVT (lime, transparente). Compomos com sharp (não no SVG) — confiável no
// Linux do Vercel. Posicionado onde ficava o texto "MOVT" em cada layout.
const LOGO_BUFFER = (() => {
  try {
    const b = Buffer.from(LOGO_BASE64, "base64");
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
})();
const LOGO_RATIO = 386 / 75; // proporção do logo (largura/altura)
// Por layout: altura do logo + onde sua borda direita e centro vertical ficam.
const LOGO_PLACEMENT = {
  classic: { h: 46, rightX: OUT_W - 64, centerY: 1090 },
  overlay: { h: 40, rightX: 44 + (OUT_W - 88) - 40, centerY: 1052 },
  minimal: { h: 42, rightX: OUT_W - 64, centerY: 1100 },
};
const logoCache = {};

/** Camada (composite) do logo para um layout: redimensiona e posiciona à direita. */
async function logoLayerFor(layout) {
  if (!LOGO_BUFFER) return null;
  const place = LOGO_PLACEMENT[layout] || LOGO_PLACEMENT.classic;
  if (!logoCache[layout]) {
    logoCache[layout] = await sharp(LOGO_BUFFER).resize({ height: place.h }).png().toBuffer();
  }
  const w = Math.round(place.h * LOGO_RATIO);
  return {
    input: logoCache[layout],
    top: Math.round(place.centerY - place.h / 2),
    left: place.rightX - w,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

const isValidPoint = (p) =>
  p &&
  typeof p.latitude === "number" &&
  isFinite(p.latitude) &&
  typeof p.longitude === "number" &&
  isFinite(p.longitude);

/** Reduz a rota para no máximo `max` pontos, preservando início e fim. */
function downsample(points, max) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * Codifica uma lista de pontos no formato "encoded polyline" (precisão 1e5),
 * o mesmo que a Mapbox aceita no overlay `path(...)`. Evita uma dependência só
 * para isto.
 */
function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let result = "";
  const encode = (v) => {
    let value = v < 0 ? ~(v << 1) : v << 1;
    let out = "";
    while (value >= 0x20) {
      out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    out += String.fromCharCode(value + 63);
    return out;
  };
  for (const p of points) {
    const lat = Math.round(p.latitude * 1e5);
    const lng = Math.round(p.longitude * 1e5);
    result += encode(lat - lastLat) + encode(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return result;
}

/** Monta a URL da Mapbox Static Images com a rota (path) e pins de início/fim. */
function buildMapUrl(points, routeColor) {
  const poly = encodePolyline(points);
  const start = points[0];
  const end = points[points.length - 1];
  const fix = (n) => n.toFixed(5);

  const pathLayer = `path-6+${routeColor}-1(${encodeURIComponent(poly)})`;
  const startPin = `pin-s+10b981(${fix(start.longitude)},${fix(start.latitude)})`;
  const endPin = `pin-s+1e293b(${fix(end.longitude)},${fix(end.latitude)})`;
  const overlay = `${pathLayer},${startPin},${endPin}`;

  // padding: topo,direita,baixo,esquerda — folga maior embaixo p/ a faixa de stats.
  return (
    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${overlay}` +
    `/auto/${MAP_W}x${MAP_H}@2x?padding=70,55,250,55&access_token=${MAPBOX_TOKEN}`
  );
}

/** Escapa texto para inclusão segura no SVG. */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** <defs> com o gradiente de escurecimento (scrim) reutilizado pelos layouts. */
const SCRIM_DEFS =
  `<defs>` +
  `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0%" stop-color="#020617" stop-opacity="0"/>` +
  `<stop offset="55%" stop-color="#020617" stop-opacity="0.55"/>` +
  `<stop offset="100%" stop-color="#020617" stop-opacity="0.94"/>` +
  `</linearGradient>` +
  `</defs>`;

const svgWrap = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}">${inner}</svg>`;

/** Layout "classic": faixa inferior com título/data + 4 métricas + marca. */
function overlayClassic({ title, subtitle, stats, accent }) {
  const padX = 64;
  const tiles = stats.slice(0, 4);
  const colW = tiles.length > 0 ? (OUT_W - padX * 2) / tiles.length : 0;
  const tilesSvg = tiles
    .map((t, i) => {
      const x = padX + i * colW;
      return (
        `<text x="${x}" y="1235" font-family="Oswald" font-weight="700" font-size="74" fill="#FFFFFF">${esc(t.value)}</text>` +
        `<text x="${x}" y="1282" font-family="Oswald" font-weight="500" font-size="29" letter-spacing="2" fill="#94A3B8">${esc(String(t.label).toUpperCase())}</text>`
      );
    })
    .join("");
  return svgWrap(
    SCRIM_DEFS +
      `<rect x="0" y="880" width="${OUT_W}" height="${OUT_H - 880}" fill="url(#scrim)"/>` +
      `<rect x="64" y="1038" width="54" height="6" rx="3" fill="${accent}"/>` +
      `<text x="64" y="1108" font-family="Oswald" font-weight="700" font-size="58" letter-spacing="3" fill="#FFFFFF">${esc(String(title).toUpperCase())}</text>` +
      `<text x="64" y="1150" font-family="Oswald" font-weight="400" font-size="31" fill="#CBD5E1">${esc(subtitle)}</text>` +
      tilesSvg
  );
}

/** Layout "overlay": cartão flutuante semitransparente sobre o mapa (estilo Strava). */
function overlayCard({ title, subtitle, stats, accent }) {
  const cardX = 44;
  const cardY = 952;
  const cardW = OUT_W - cardX * 2;
  const cardH = 346;
  const inX = cardX + 40; // padding interno
  const tiles = stats.slice(0, 4);
  const colW = tiles.length > 0 ? (cardW - 80) / tiles.length : 0;
  const tilesSvg = tiles
    .map((t, i) => {
      const x = inX + i * colW;
      return (
        `<text x="${x}" y="1212" font-family="Oswald" font-weight="700" font-size="66" fill="#FFFFFF">${esc(t.value)}</text>` +
        `<text x="${x}" y="1256" font-family="Oswald" font-weight="500" font-size="27" letter-spacing="2" fill="#94A3B8">${esc(String(t.label).toUpperCase())}</text>`
      );
    })
    .join("");
  return svgWrap(
    SCRIM_DEFS +
      `<rect x="0" y="980" width="${OUT_W}" height="${OUT_H - 980}" fill="url(#scrim)"/>` +
      `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="30" fill="#020617" fill-opacity="0.8" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="1.5"/>` +
      `<rect x="${inX}" y="1006" width="50" height="6" rx="3" fill="${accent}"/>` +
      `<text x="${inX}" y="1068" font-family="Oswald" font-weight="700" font-size="50" letter-spacing="2" fill="#FFFFFF">${esc(String(title).toUpperCase())}</text>` +
      `<text x="${inX}" y="1106" font-family="Oswald" font-weight="400" font-size="28" fill="#CBD5E1">${esc(subtitle)}</text>` +
      tilesSvg
  );
}

/** Layout "minimal": distância em destaque + linha resumo + marca. */
function overlayMinimal({ title, subtitle, stats, accent }) {
  const hero = stats[0] || { value: "", label: "" };
  const rest = stats.slice(1).filter((s) => s && s.value);
  const summary = rest.map((s) => `${esc(s.value)} ${esc(String(s.label))}`).join("   ·   ");
  const eyebrow = `${esc(String(title).toUpperCase())}${subtitle ? `  ·  ${esc(subtitle)}` : ""}`;
  return svgWrap(
    SCRIM_DEFS +
      `<rect x="0" y="900" width="${OUT_W}" height="${OUT_H - 900}" fill="url(#scrim)"/>` +
      `<text x="64" y="1118" font-family="Oswald" font-weight="500" font-size="32" letter-spacing="2" fill="${accent}">${eyebrow}</text>` +
      `<text x="60" y="1248" font-family="Oswald" font-weight="700" font-size="150" fill="#FFFFFF">${esc(hero.value)}` +
      `<tspan font-size="50" letter-spacing="2" fill="${accent}" dx="16">${esc(String(hero.label).toUpperCase())}</tspan></text>` +
      `<text x="64" y="1306" font-family="Oswald" font-weight="400" font-size="38" fill="#CBD5E1">${summary}</text>`
  );
}

/** Despacha para o layout escolhido (default: classic). */
function buildOverlaySvg({ layout, title, subtitle, stats, accent }) {
  const args = { title, subtitle, stats: Array.isArray(stats) ? stats : [], accent };
  if (layout === "overlay") return overlayCard(args);
  if (layout === "minimal") return overlayMinimal(args);
  return overlayClassic(args);
}

/** Renderiza o overlay SVG em PNG (fundo transparente) usando a fonte Oswald. */
function renderOverlayPng(svg) {
  const resvg = new Resvg(svg, {
    background: "rgba(0,0,0,0)",
    font: FONT_FILE
      ? { fontFiles: [FONT_FILE], defaultFontFamily: "Oswald", loadSystemFonts: false }
      : { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

// ─── Núcleo: baixa o mapa uma vez, compõe cada card ──────────────────────────────

/** Baixa o mapa da Mapbox (com a rota) uma única vez. Retorna o buffer + accent. */
async function fetchRouteMap({ route, type }) {
  if (!MAPBOX_TOKEN) throw new Error("MAPBOX_TOKEN ausente no ambiente.");

  const clean = (Array.isArray(route) ? route : []).filter(isValidPoint);
  if (clean.length < 2) throw new Error("Rota insuficiente para gerar o card.");

  const points = downsample(clean, MAX_PATH_POINTS);
  const accentHex = type === "Ciclismo" ? "3b82f6" : "10b981";

  const url = buildMapUrl(points, accentHex);
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 12000 });
  return { mapBuffer: Buffer.from(resp.data), accentHex };
}

/** Compõe UM card (overlay + logo sobre o mapa já baixado). */
async function composeCard(mapBuffer, accentHex, { layout, title, subtitle, stats }) {
  const overlayPng = renderOverlayPng(
    buildOverlaySvg({ layout, title, subtitle, stats, accent: `#${accentHex}` })
  );
  const composites = [{ input: overlayPng, top: 0, left: 0 }];
  const logo = await logoLayerFor(layout);
  if (logo) composites.push(logo);
  return sharp(mapBuffer).composite(composites).png().toBuffer();
}

// ─── API pública ─────────────────────────────────────────────────────────────────

/**
 * Gera UM PNG do card de compartilhamento.
 * @returns {Promise<Buffer>} PNG
 */
async function buildShareCard({ route, type, title, subtitle, stats, layout }) {
  const { mapBuffer, accentHex } = await fetchRouteMap({ route, type });
  return composeCard(mapBuffer, accentHex, { layout, title, subtitle, stats });
}

/**
 * Gera VÁRIOS cards de uma vez (carrossel): baixa o mapa só uma vez e compõe
 * cada variante (layout + stats) sobre ele. title/subtitle são comuns.
 * @param {Object} input
 * @param {Array<{latitude:number,longitude:number}>} input.route
 * @param {"Corrida"|"Ciclismo"} input.type
 * @param {string} input.title
 * @param {string} input.subtitle
 * @param {Array<{layout?:string, stats:Array<{label:string,value:string}>}>} input.variants
 * @returns {Promise<Buffer[]>} PNGs na mesma ordem das variantes
 */
async function buildShareCards({ route, type, title, subtitle, variants }) {
  const { mapBuffer, accentHex } = await fetchRouteMap({ route, type });
  const list = Array.isArray(variants) ? variants : [];
  return Promise.all(
    list.map((v) =>
      composeCard(mapBuffer, accentHex, {
        layout: v.layout,
        title,
        subtitle,
        stats: v.stats,
      })
    )
  );
}

module.exports = { buildShareCard, buildShareCards };
