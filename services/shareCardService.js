/**
 * shareCardService — gera um CARD compartilhável (estilo Strava) de um treino de
 * corrida/ciclismo: o mapa real (Mapbox Static Images) com a rota desenhada por
 * cima + os números do treino e o logo MOVT "queimados" na imagem.
 *
 * FORMATOS: `feed` (1080x1350, 4:5) e `stories` (1080x1920, 9:16). A largura é
 * fixa; a faixa de stats fica ancorada na BASE (y = H - offset), então o mesmo
 * layout serve para os dois formatos — no stories o mapa só ocupa mais altura.
 *
 * TEXTO/FONTE: @resvg/resvg-js. ⚠️ No Linux do Vercel o resvg IGNORA `fontBuffers`
 * (texto não renderiza) mas respeita `fontFiles` → gravamos a fonte (do módulo
 * base64) em /tmp e passamos o caminho. O sharp compõe overlay + logo sobre o mapa.
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

const OUT_W = 1080; // largura fixa
const FEED_H = 1350; // 4:5
const STORIES_H = 1920; // 9:16

/** Dimensões por formato. O Mapbox renderiza em metade (@2x dobra). */
function dimsFor(format) {
  const H = format === "stories" ? STORIES_H : FEED_H;
  return { W: OUT_W, H, mapW: OUT_W / 2, mapH: Math.round(H / 2) };
}

// Teto de pontos enviados à Static Images API (limite de tamanho da URL).
const MAX_PATH_POINTS = 280;

// Fonte empacotada (base64 → /tmp → fontFiles, ver nota no topo).
const FONT_BUFFER = (() => {
  try {
    const buf = Buffer.from(OSWALD_BASE64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
})();
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

// Logo MOVT (lime, transparente), composto com sharp no lugar do antigo texto.
const LOGO_BUFFER = (() => {
  try {
    const b = Buffer.from(LOGO_BASE64, "base64");
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
})();
const LOGO_RATIO = 386 / 75; // largura/altura
// Por layout: altura do logo + borda direita + offset do centro vertical A PARTIR
// DA BASE (centerY = H - centerBot).
const LOGO_PLACEMENT = {
  classic: { h: 46, rightX: OUT_W - 64, centerBot: 260 },
  overlay: { h: 40, rightX: 44 + (OUT_W - 88) - 40, centerBot: 298 },
  minimal: { h: 42, rightX: OUT_W - 64, centerBot: 250 },
};
const logoCache = {};

/** Camada (composite) do logo: redimensiona (cache por layout) e posiciona. */
async function logoLayerFor(layout, H) {
  if (!LOGO_BUFFER) return null;
  const place = LOGO_PLACEMENT[layout] || LOGO_PLACEMENT.classic;
  if (!logoCache[layout]) {
    logoCache[layout] = await sharp(LOGO_BUFFER).resize({ height: place.h }).png().toBuffer();
  }
  const w = Math.round(place.h * LOGO_RATIO);
  return {
    input: logoCache[layout],
    top: Math.round(H - place.centerBot - place.h / 2),
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

/** Codifica pontos no formato "encoded polyline" (precisão 1e5) p/ a Mapbox. */
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

/** URL da Mapbox Static Images com a rota (path) e pins, no tamanho do formato. */
function buildMapUrl(points, routeColor, mapW, mapH) {
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
    `/auto/${mapW}x${mapH}@2x?padding=70,55,250,55&access_token=${MAPBOX_TOKEN}`
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

const svgWrap = (inner, W, H) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${inner}</svg>`;

// As posições verticais são offsets A PARTIR DA BASE (y = H - off), p/ servir tanto
// ao feed (H=1350) quanto ao stories (H=1920) com a faixa colada embaixo.

/** Layout "classic": faixa inferior com título/data + métricas. */
function overlayClassic({ title, subtitle, stats, accent }, W, H) {
  const padX = 64;
  const tiles = stats.slice(0, 4);
  const colW = tiles.length > 0 ? (W - padX * 2) / tiles.length : 0;
  const tilesSvg = tiles
    .map((t, i) => {
      const x = padX + i * colW;
      return (
        `<text x="${x}" y="${H - 115}" font-family="Oswald" font-weight="700" font-size="74" fill="#FFFFFF">${esc(t.value)}</text>` +
        `<text x="${x}" y="${H - 68}" font-family="Oswald" font-weight="500" font-size="29" letter-spacing="2" fill="#94A3B8">${esc(String(t.label).toUpperCase())}</text>`
      );
    })
    .join("");
  return svgWrap(
    SCRIM_DEFS +
      `<rect x="0" y="${H - 470}" width="${W}" height="470" fill="url(#scrim)"/>` +
      `<rect x="64" y="${H - 312}" width="54" height="6" rx="3" fill="${accent}"/>` +
      `<text x="64" y="${H - 242}" font-family="Oswald" font-weight="700" font-size="58" letter-spacing="3" fill="#FFFFFF">${esc(String(title).toUpperCase())}</text>` +
      `<text x="64" y="${H - 200}" font-family="Oswald" font-weight="400" font-size="31" fill="#CBD5E1">${esc(subtitle)}</text>` +
      tilesSvg,
    W,
    H
  );
}

/** Layout "overlay": cartão flutuante semitransparente sobre o mapa. */
function overlayCard({ title, subtitle, stats, accent }, W, H) {
  const cardX = 44;
  const cardW = W - cardX * 2;
  const cardH = 346;
  const cardY = H - 398;
  const inX = cardX + 40;
  const tiles = stats.slice(0, 4);
  const colW = tiles.length > 0 ? (cardW - 80) / tiles.length : 0;
  const tilesSvg = tiles
    .map((t, i) => {
      const x = inX + i * colW;
      return (
        `<text x="${x}" y="${H - 138}" font-family="Oswald" font-weight="700" font-size="66" fill="#FFFFFF">${esc(t.value)}</text>` +
        `<text x="${x}" y="${H - 94}" font-family="Oswald" font-weight="500" font-size="27" letter-spacing="2" fill="#94A3B8">${esc(String(t.label).toUpperCase())}</text>`
      );
    })
    .join("");
  return svgWrap(
    SCRIM_DEFS +
      `<rect x="0" y="${H - 370}" width="${W}" height="370" fill="url(#scrim)"/>` +
      `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="30" fill="#020617" fill-opacity="0.8" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="1.5"/>` +
      `<rect x="${inX}" y="${H - 344}" width="50" height="6" rx="3" fill="${accent}"/>` +
      `<text x="${inX}" y="${H - 282}" font-family="Oswald" font-weight="700" font-size="50" letter-spacing="2" fill="#FFFFFF">${esc(String(title).toUpperCase())}</text>` +
      `<text x="${inX}" y="${H - 244}" font-family="Oswald" font-weight="400" font-size="28" fill="#CBD5E1">${esc(subtitle)}</text>` +
      tilesSvg,
    W,
    H
  );
}

/** Layout "minimal": distância em destaque + linha resumo. */
function overlayMinimal({ title, subtitle, stats, accent }, W, H) {
  const hero = stats[0] || { value: "", label: "" };
  const rest = stats.slice(1).filter((s) => s && s.value);
  const summary = rest.map((s) => `${esc(s.value)} ${esc(String(s.label))}`).join("   ·   ");
  const eyebrow = `${esc(String(title).toUpperCase())}${subtitle ? `  ·  ${esc(subtitle)}` : ""}`;
  return svgWrap(
    SCRIM_DEFS +
      `<rect x="0" y="${H - 450}" width="${W}" height="450" fill="url(#scrim)"/>` +
      `<text x="64" y="${H - 232}" font-family="Oswald" font-weight="500" font-size="32" letter-spacing="2" fill="${accent}">${eyebrow}</text>` +
      `<text x="60" y="${H - 102}" font-family="Oswald" font-weight="700" font-size="150" fill="#FFFFFF">${esc(hero.value)}` +
      `<tspan font-size="50" letter-spacing="2" fill="${accent}" dx="16">${esc(String(hero.label).toUpperCase())}</tspan></text>` +
      `<text x="64" y="${H - 44}" font-family="Oswald" font-weight="400" font-size="38" fill="#CBD5E1">${summary}</text>`,
    W,
    H
  );
}

/** Despacha para o layout escolhido (default: classic). */
function buildOverlaySvg({ layout, title, subtitle, stats, accent }, W, H) {
  const args = { title, subtitle, stats: Array.isArray(stats) ? stats : [], accent };
  if (layout === "overlay") return overlayCard(args, W, H);
  if (layout === "minimal") return overlayMinimal(args, W, H);
  return overlayClassic(args, W, H);
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

/** Baixa o mapa da Mapbox (com a rota) uma vez, no tamanho do formato. */
async function fetchRouteMap({ route, type, dims }) {
  if (!MAPBOX_TOKEN) throw new Error("MAPBOX_TOKEN ausente no ambiente.");

  const clean = (Array.isArray(route) ? route : []).filter(isValidPoint);
  if (clean.length < 2) throw new Error("Rota insuficiente para gerar o card.");

  const points = downsample(clean, MAX_PATH_POINTS);
  const accentHex = type === "Ciclismo" ? "3b82f6" : "10b981";

  const url = buildMapUrl(points, accentHex, dims.mapW, dims.mapH);
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 12000 });
  return { mapBuffer: Buffer.from(resp.data), accentHex };
}

/** Compõe UM card (overlay + logo sobre o mapa já baixado). */
async function composeCard(mapBuffer, accentHex, { layout, title, subtitle, stats }, dims) {
  const overlayPng = renderOverlayPng(
    buildOverlaySvg({ layout, title, subtitle, stats, accent: `#${accentHex}` }, dims.W, dims.H)
  );
  const composites = [{ input: overlayPng, top: 0, left: 0 }];
  const logo = await logoLayerFor(layout, dims.H);
  if (logo) composites.push(logo);
  return sharp(mapBuffer).composite(composites).png().toBuffer();
}

// ─── API pública ─────────────────────────────────────────────────────────────────

/** Gera UM PNG do card. `format` = "feed" (default) | "stories". */
async function buildShareCard({ route, type, title, subtitle, stats, layout, format }) {
  const dims = dimsFor(format);
  const { mapBuffer, accentHex } = await fetchRouteMap({ route, type, dims });
  return composeCard(mapBuffer, accentHex, { layout, title, subtitle, stats }, dims);
}

/**
 * Gera VÁRIOS cards de uma vez (carrossel): baixa o mapa só uma vez e compõe
 * cada variante (layout + stats). title/subtitle/format são comuns.
 */
async function buildShareCards({ route, type, title, subtitle, variants, format }) {
  const dims = dimsFor(format);
  const { mapBuffer, accentHex } = await fetchRouteMap({ route, type, dims });
  const list = Array.isArray(variants) ? variants : [];
  return Promise.all(
    list.map((v) =>
      composeCard(mapBuffer, accentHex, { layout: v.layout, title, subtitle, stats: v.stats }, dims)
    )
  );
}

module.exports = { buildShareCard, buildShareCards };
