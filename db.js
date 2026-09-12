const crypto = require("crypto");
const { createClient } = require("@libsql/client");

const dbUrl = process.env.TURSO_DATABASE_URL || "file:./data.db";
const authToken = process.env.TURSO_AUTH_TOKEN;

const db = createClient(
  authToken ? { url: dbUrl, authToken } : { url: dbUrl }
);

const ready = db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    username_lower TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function normalize(username) {
  return String(username || "").trim();
}

async function usernameTaken(username) {
  await ready;
  const lower = normalize(username).toLowerCase();
  const res = await db.execute({
    sql: "SELECT 1 FROM users WHERE username_lower = ?",
    args: [lower],
  });
  return res.rows.length > 0;
}

async function createUser(username, password) {
  await ready;
  const display = normalize(username);
  const lower = display.toLowerCase();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);

  try {
    await db.execute({
      sql: "INSERT INTO users (username_lower, display_name, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [lower, display, salt, hash, Date.now()],
    });
    return { ok: true, displayName: display };
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      return { ok: false, reason: "Этот ник уже занят." };
    }
    throw err;
  }
}

async function verifyUser(username, password) {
  await ready;
  const lower = normalize(username).toLowerCase();
  const res = await db.execute({
    sql: "SELECT display_name, salt, hash FROM users WHERE username_lower = ?",
    args: [lower],
  });
  if (res.rows.length === 0) return { ok: false, reason: "Такого аккаунта нет." };

  const row = res.rows[0];
  const attempt = hashPassword(password, row.salt);
  const match =
    attempt.length === row.hash.length &&
    crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(row.hash));

  if (!match) return { ok: false, reason: "Неверный пароль." };
  return { ok: true, displayName: row.display_name };
}

module.exports = { usernameTaken, createUser, verifyUser, normalize };
