const crypto = require("crypto");

const algorithm = "aes-256-cbc";
// Use a 32 byte key derived via sha256. C2 (fail-closed): sem chave configurada
// o módulo aborta em vez de cair num segredo conhecido no fonte. Preserva a
// ordem de origem (ENCRYPTION_KEY -> JWT_SECRET) e a derivação sha256 para não
// quebrar dados já cifrados por este módulo.
const _rawEncKey = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
if (!_rawEncKey) {
  throw new Error("ENCRYPTION_KEY/JWT_SECRET não configurada — abortando (fail-closed).");
}
const secretKey = crypto.createHash('sha256').update(String(_rawEncKey)).digest();
const ivSize = 16;

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(ivSize);
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(text) {
  if (!text) return null;
  try {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv(algorithm, secretKey, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.error("Decryption failed:", error);
    return null;
  }
}

module.exports = { encrypt, decrypt };
