#!/usr/bin/env node
/* Deploy de produção SÓ deste projeto (movt-backend), autenticando com um TOKEN
 * do Vercel da conta DONA (tiagomatsukura) — sem tocar no `vercel login` global
 * da máquina (que segue jvlima22 para os outros projetos).
 *
 * O token vem de MOVT-BACKEND/.env.deploy (gitignored). NUNCA commitar/colar em chat.
 * Gere em https://vercel.com/account/tokens logado como a conta dona.
 *
 * Uso:  npm run deploy:prod
 */
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env.deploy") });

const token = process.env.VERCEL_TOKEN;
if (!token) {
  console.error(
    "\n✗ VERCEL_TOKEN não definido.\n" +
      "  Crie o arquivo MOVT-BACKEND/.env.deploy (gitignored) com:\n" +
      "      VERCEL_TOKEN=<token do Vercel da conta tiagomatsukura>\n" +
      "  Gere o token em https://vercel.com/account/tokens (logado como tiagomatsukura).\n"
  );
  process.exit(1);
}

console.log("→ Deploy de produção do movt-backend pela conta dona (token local, sem mexer no login global)…");
try {
  // O Vercel CLI lê VERCEL_TOKEN do ambiente. Passamos só para ESTE processo
  // filho — não exporta globalmente nem afeta os outros projetos. O projeto/equipe
  // de destino vêm do link em .vercel/project.json.
  execSync("vercel --prod --yes", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VERCEL_TOKEN: token },
  });
} catch (err) {
  console.error("✗ Falha no deploy:", err.message);
  process.exit(1);
}
