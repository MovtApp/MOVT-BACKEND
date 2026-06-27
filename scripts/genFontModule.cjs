/**
 * Gera services/oswaldFontBase64.js a partir de assets/fonts/Oswald.ttf.
 *
 * POR QUE: o bundler do Vercel (@vercel/node/ncc) só empacota o que é `require`-ado
 * estaticamente — um `fs.readFileSync("assets/fonts/Oswald.ttf")` NÃO inclui o
 * arquivo no pacote da função, então a fonte some em produção e o texto do card
 * não renderiza. Embutindo a fonte como base64 num módulo JS, o `require` garante
 * que ela vá junto. Rode este script se trocar a fonte.
 */
const fs = require("fs");
const path = require("path");

const ttfPath = path.join(__dirname, "..", "assets", "fonts", "Oswald.ttf");
const outPath = path.join(__dirname, "..", "services", "oswaldFontBase64.js");

const b = fs.readFileSync(ttfPath);
const out =
  "// Fonte Oswald (OFL) embutida em base64 para o gerador de share-card.\n" +
  "// Embutida em JS (nao lida do disco) para o bundler do Vercel SEMPRE incluir\n" +
  "// a fonte no pacote da funcao serverless. Regenerar: scripts/genFontModule.cjs\n" +
  "module.exports = " +
  JSON.stringify(b.toString("base64")) +
  ";\n";
fs.writeFileSync(outPath, out);
console.log(`OK: ${outPath} (${(out.length / 1024).toFixed(0)} KB, ttf ${b.length} bytes)`);
