// Inicialização do Sentry para o backend Node.
// DEVE ser carregado ANTES de qualquer outro módulo (primeira linha do index.js).
// O DSN é lido de SENTRY_DSN; se não estiver definido, o Sentry fica inativo
// (no-op) e o servidor roda normalmente.
require("dotenv").config();
const Sentry = require("@sentry/node");

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "production",
    // Amostragem de performance: 10% das transações (ajuste se quiser)
    tracesSampleRate: 0.1,
    // Não envia dados de requisição sensíveis (corpo/headers) por padrão
    sendDefaultPii: false,
  });
  console.log("🛡️  Sentry inicializado (backend).");
} else {
  console.warn(
    "⚠️  SENTRY_DSN não definido — Sentry desativado no backend. " +
      "Defina SENTRY_DSN no .env para ativar o reporte de erros."
  );
}

module.exports = Sentry;
