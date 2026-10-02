const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const db = require("./db");
const auth = require("./auth");

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 5;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

function roomMembers(roomCode) {
  return rooms.get(roomCode) || new Map();
}

function validCredentials(username, password) {
  const name = db.normalize(username);
  if (name.length < 3 || name.length > 20) {
    return "Ник должен быть от 3 до 20 символов.";
  }
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]+$/.test(name)) {
    return "Только буквы, цифры и подчёркивание.";
  }
  if (!password || password.length < 4) {
    return "Пароль минимум 4 символа.";
  }
  return null;
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("register", async ({ username, password }, ack) => {
    if (typeof ack !== "function") return;
    const problem = validCredentials(username, password);
    if (problem) return ack({ ok: false, reason: problem });

    try {
      const result = await db.createUser(username, password);
      if (!result.ok) return ack(result);
      socket.data.username = result.displayName;
      ack({
        ok: true,
        displayName: result.displayName,
        token: auth.issueToken(result.displayName),
      });
    } catch (err) {
      console.error("register error", err);
      ack({ ok: false, reason: "Что-то сломалось на сервере, попробуй ещё раз." });
    }
  });

  socket.on("login", async ({ username, password }, ack) => {
    if (typeof ack !== "function") return;
    try {
      const result = await db.verifyUser(username, password);
      if (!result.ok) return ack(result);
      socket.data.username = result.displayName;
      ack({
        ok: true,
        displayName: result.displayName,
        token: auth.issueToken(result.displayName),
      });
    } catch (err) {
      console.error("login error", err);
      ack({ ok: false, reason: "Что-то сломалось на сервере, попробуй ещё раз." });
    }
  });

  socket.on("resume-session", ({ token }, ack) => {
    if (typeof ack !== "function") return;
    const displayName = auth.verifyToken(token);
    if (!displayName) return ack({ ok: false });
    socket.data.username = displayName;
    ack({ ok: true, displayName });
  });

  socket.on("join-room", ({ roomCode } = {}, ack) => {
    if (typeof ack !== "function") return;
    if (!socket.data.username) {
      return ack({ ok: false, reason: "Сначала войди в аккаунт." });
    }
    if (currentRoom) {
      return ack({ ok: false, reason: "Ты уже в комнате." });
    }

    const callsign = socket.data.username;
    const code = (roomCode || "").trim().toUpperCase().slice(0, 12);

    if (!code) {
      return ack({ ok: false, reason: "Введи код отряда." });
    }

    if (!rooms.has(code)) rooms.set(code, new Map());
    const members = rooms.get(code);

    if (members.size >= MAX_PER_ROOM) {
      return ack({ ok: false, reason: "Отряд полон (максимум 5)." });
    }

    currentRoom = code;
    members.set(socket.id, callsign);
    socket.join(code);

    const existingPeers = Array.from(members.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({ id, callsign: name }));

    ack({ ok: true, selfId: socket.id, peers: existingPeers });

    socket.to(code).emit("peer-joined", { id: socket.id, callsign });
  });

  socket.on("signal", ({ to, data } = {}) => {
    if (!currentRoom || !to || !data) return;
    const members = roomMembers(currentRoom);
    if (!members.has(to)) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("chat-message", ({ text } = {}) => {
    if (!currentRoom || !text) return;
    const callsign = roomMembers(currentRoom).get(socket.id) || "Operator";
    io.to(currentRoom).emit("chat-message", {
      from: socket.id,
      callsign,
      text: String(text).slice(0, 500),
      ts: Date.now(),
    });
  });

  socket.on("mic-state", ({ muted } = {}) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("peer-mic-state", { id: socket.id, muted: !!muted });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const members = rooms.get(currentRoom);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) rooms.delete(currentRoom);
    }
    socket.to(currentRoom).emit("peer-left", { id: socket.id });
    currentRoom = null;
  });
});

server.listen(PORT, () => {
  console.log(`Squad Comms running on port ${PORT}`);
});
