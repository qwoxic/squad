const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

function sign(payloadStr) {
  return crypto.createHmac("sha256", SECRET).update(payloadStr).digest("hex");
}

function issueToken(displayName) {
  const payload = JSON.stringify({ u: displayName, exp: Date.now() + TOKEN_TTL_MS });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  if (sign(encoded) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload.u;
  } catch {
    return null;
  }
}

module.exports = { issueToken, verifyToken };
