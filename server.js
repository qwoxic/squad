const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 5;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

// roomCode -> Map(socketId -> callsign)
const rooms = new Map();

function roomMembers(roomCode) {
  return rooms.get(roomCode) || new Map();
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", ({ roomCode, callsign }, ack) => {
    roomCode = (roomCode || "").trim().toUpperCase().slice(0, 12);
    callsign = (callsign || "Operator").trim().slice(0, 16);

    if (!roomCode) {
      return ack({ ok: false, reason: "Введи код отряда." });
    }

    const members = roomMembers(roomCode);
    if (members.size >= MAX_PER_ROOM) {
      return ack({ ok: false, reason: "Отряд полон (максимум 5)." });
    }

    currentRoom = roomCode;
    if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
    rooms.get(roomCode).set(socket.id, callsign);
    socket.join(roomCode);

    // Tell the new peer who is already here (they will initiate offers to each)
    const existingPeers = Array.from(rooms.get(roomCode).entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({ id, callsign: name }));

    ack({ ok: true, selfId: socket.id, peers: existingPeers });

    // Tell existing peers a new one joined
    socket.to(roomCode).emit("peer-joined", { id: socket.id, callsign });
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("chat-message", ({ text }) => {
    if (!currentRoom || !text) return;
    const callsign = roomMembers(currentRoom).get(socket.id) || "Operator";
    io.to(currentRoom).emit("chat-message", {
      from: socket.id,
      callsign,
      text: String(text).slice(0, 500),
      ts: Date.now(),
    });
  });

  socket.on("mic-state", ({ muted }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("peer-mic-state", { id: socket.id, muted });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const members = rooms.get(currentRoom);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) rooms.delete(currentRoom);
    }
    socket.to(currentRoom).emit("peer-left", { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Squad Comms running on port ${PORT}`);
});
