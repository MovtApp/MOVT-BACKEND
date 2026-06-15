// Diagnóstico read-only: mostra os selos do funil dos últimos usuários criados.
// Uso: node scripts/debug-user-flags.cjs   (a partir de MOVT-BACKEND)
require("dotenv").config();
const postgres = require("postgres");
const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false }, prepare: false });

const maskEmail = (e) => (e ? e.replace(/^(.).*(@.*)$/, "$1***$2") : "—");

(async () => {
  try {
    const rows = await sql`
      SELECT id_us, email, role, cnpj IS NOT NULL AS is_cnpj,
             email_verified, phone_verified, cnpj_verified, cref_verified,
             status_verificacao, onboarding_completed, createdat
      FROM usuarios
      ORDER BY id_us DESC
      LIMIT 8
    `;
    console.log("Últimos usuários (mais recente primeiro):\n");
    for (const u of rows) {
      console.log(`#${u.id_us} ${maskEmail(u.email)} ${u.is_cnpj ? "CNPJ" : "CPF"} role=${u.role || "-"}`);
      console.log(
        `   email_verified=${u.email_verified}  phone_verified=${u.phone_verified}  ` +
        `cnpj_verified=${u.cnpj_verified}  cref_verified=${u.cref_verified}  ` +
        `onboarding_completed=${u.onboarding_completed}  status=${u.status_verificacao}`
      );
    }
  } catch (err) {
    console.error("Erro:", err.message);
  } finally {
    await sql.end();
  }
})();
