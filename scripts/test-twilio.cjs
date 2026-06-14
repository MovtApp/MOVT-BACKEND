// Teste de conexão com o Twilio Verify — NÃO envia SMS.
// Faz uma leitura do Verify Service para validar credenciais + Service SID.
// Uso: node scripts/test-twilio.cjs   (a partir da pasta MOVT-BACKEND)
require("dotenv").config();
const twilio = require("twilio");

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;

// Mostra presença/formato SEM expor valores secretos.
const mask = (v) => (v ? `${v.slice(0, 4)}…(${v.length} chars)` : "AUSENTE");
console.log("Variáveis encontradas:");
console.log("  TWILIO_ACCOUNT_SID       =", mask(sid), sid?.startsWith("AC") ? "✓ formato AC" : "✗ deveria começar com AC");
console.log("  TWILIO_AUTH_TOKEN        =", token ? `presente (${token.length} chars)` : "AUSENTE");
console.log("  TWILIO_VERIFY_SERVICE_SID=", mask(verifySid), verifySid?.startsWith("VA") ? "✓ formato VA" : "✗ deveria começar com VA");
console.log("");

if (!sid || !token || !verifySid) {
  console.error("❌ Faltam variáveis no .env. Preencha as 3 e rode de novo.");
  process.exit(1);
}

(async () => {
  try {
    const client = twilio(sid, token);
    const service = await client.verify.v2.services(verifySid).fetch();
    console.log("✅ Conexão OK! Verify Service válido:");
    console.log("   Nome :", service.friendlyName);
    console.log("   SID  :", service.sid);
    console.log("   Canais SMS/WhatsApp prontos para uso.");
  } catch (err) {
    console.error("❌ Falha ao conectar no Twilio:");
    console.error("   Código :", err.code || "—");
    console.error("   Status :", err.status || "—");
    console.error("   Mensagem:", err.message);
    if (err.status === 401) {
      console.error("   → 401 = Account SID ou Auth Token incorretos.");
    } else if (err.status === 404) {
      console.error("   → 404 = Verify Service SID não encontrado (confira o VA...).");
    }
    process.exit(1);
  }
})();
