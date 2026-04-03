const crypto = require("crypto");

const algorithm = "aes-256-cbc";
// Use a 32 byte key. If JWT_SECRET is shorter/longer, we derive it.
const secretKey = crypto.createHash('sha256').update(String(process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'movt-fallback-secret')).digest();
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
