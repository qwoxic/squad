const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const socket = io();

const screenJoin = document.getElementById("screen-join");
const screenRoom = document.getElementById("screen-room");
const inputCallsign = document.getElementById("input-callsign");
const inputRoom = document.getElementById("input-room");
const btnJoin = document.getElementById("btn-join");
const joinError = document.getElementById("join-error");

const roomCodeDisplay = document.getElementById("room-code-display");
const roster = document.getElementById("roster");
const btnMute = document.getElementById("btn-mute");
const muteLabel = document.getElementById("mute-label");
const btnLeave = document.getElementById("btn-leave");
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let selfId = null;
let selfCallsign = "Operator";
let roomCode = "";
let localStream = null;
let muted = false;

// peerId -> { pc, audioEl, callsign }
const peers = new Map();

function addChatLine({ callsign, text, system }) {
  const line = document.createElement("div");
  line.className = system ? "chat-line system" : "chat-line";
  if (system) {
    line.textContent = text;
  } else {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = callsign;
    line.appendChild(who);
    line.appendChild(document.createTextNode(text));
  }
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderRoster() {
  roster.innerHTML = "";

  const selfTile = makeTile(selfId, selfCallsign, true, muted);
  roster.appendChild(selfTile);

  for (const [id, peer] of peers) {
    roster.appendChild(makeTile(id, peer.callsign, false, peer.remoteMuted));
  }
}

function makeTile(id, callsign, isSelf, isMuted) {
  const tile = document.createElement("div");
  tile.className = "tile" + (isSelf ? " is-self" : "") + (isMuted ? " muted" : "");
  tile.dataset.peerId = id;

  const led = document.createElement("span");
  led.className = "tile-led";

  const info = document.createElement("div");
  const name = document.createElement("div");
  name.className = "tile-name";
  name.textContent = callsign + (isSelf ? " (ты)" : "");
  const sub = document.createElement("div");
  sub.className = "tile-sub";
  sub.textContent = isMuted ? "микрофон выключен" : "на связи";

  info.appendChild(name);
  info.appendChild(sub);
  tile.appendChild(led);
  tile.appendChild(info);
  return tile;
}

function setSpeaking(peerId, isSpeaking) {
  const tile = roster.querySelector(`[data-peer-id="${peerId}"]`);
  if (tile) tile.classList.toggle("speaking", isSpeaking);
}

async function initMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  watchLocalVolume(localStream, (speaking) => setSpeaking(selfId, speaking));
}

function watchLocalVolume(stream, cb) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let speaking = false;

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const nowSpeaking = avg > 12 && !muted;
    if (nowSpeaking !== speaking) {
      speaking = nowSpeaking;
      cb(speaking);
    }
    requestAnimationFrame(tick);
  }
  tick();
}

function createPeerConnection(peerId, callsign) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal", { to: peerId, data: { type: "ice", candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.srcObject = e.streams[0];
    document.body.appendChild(audioEl);
    peers.get(peerId).audioEl = audioEl;
    watchLocalVolume(e.streams[0], (speaking) => setSpeaking(peerId, speaking));
  };

  peers.set(peerId, { pc, callsign, audioEl: null, remoteMuted: false });
  return pc;
}

async function callPeer(peerId, callsign) {
  const pc = createPeerConnection(peerId, callsign);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("signal", { to: peerId, data: { type: "offer", sdp: offer } });
  renderRoster();
}

async function handleSignal({ from, data }) {
  if (data.type === "offer") {
    const existing = peers.get(from);
    const pc = existing ? existing.pc : createPeerConnection(from, existing ? existing.callsign : "Operator");
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("signal", { to: from, data: { type: "answer", sdp: answer } });
  } else if (data.type === "answer") {
    const peer = peers.get(from);
    if (peer) await peer.pc.setRemoteDescription(data.sdp);
  } else if (data.type === "ice") {
    const peer = peers.get(from);
    if (peer) {
      try {
        await peer.pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn("ICE candidate error", err);
      }
    }
  }
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  if (peer.audioEl) peer.audioEl.remove();
  peers.delete(peerId);
  renderRoster();
}

// ---------- Socket wiring ----------

socket.on("signal", handleSignal);

socket.on("peer-joined", async ({ id, callsign }) => {
  peers.set(id, { pc: null, callsign, audioEl: null, remoteMuted: false });
  addChatLine({ system: true, text: `${callsign} вышел на связь.` });
  await callPeer(id, callsign);
});

socket.on("peer-left", ({ id }) => {
  const callsign = peers.get(id)?.callsign || "Оператор";
  removePeer(id);
  addChatLine({ system: true, text: `${callsign} отключился.` });
});

socket.on("peer-mic-state", ({ id, muted: isMuted }) => {
  const peer = peers.get(id);
  if (peer) {
    peer.remoteMuted = isMuted;
    renderRoster();
  }
});

socket.on("chat-message", ({ callsign, text }) => {
  addChatLine({ callsign, text });
});

// ---------- UI events ----------

btnJoin.addEventListener("click", async () => {
  const callsign = inputCallsign.value.trim() || "Operator";
  const code = inputRoom.value.trim();
  if (!code) {
    joinError.textContent = "Введи код отряда.";
    return;
  }

  btnJoin.disabled = true;
  joinError.textContent = "";

  try {
    await initMedia();
  } catch (err) {
    joinError.textContent = "Не получилось включить микрофон. Разреши доступ и попробуй снова.";
    btnJoin.disabled = false;
    return;
  }

  socket.emit("join-room", { roomCode: code, callsign }, async (res) => {
    if (!res.ok) {
      joinError.textContent = res.reason;
      btnJoin.disabled = false;
      return;
    }

    selfId = res.selfId;
    selfCallsign = callsign;
    roomCode = code.toUpperCase();

    screenJoin.classList.add("hidden");
    screenRoom.classList.remove("hidden");
    roomCodeDisplay.textContent = roomCode;
    addChatLine({ system: true, text: `Ты на канале ${roomCode}.` });

    for (const p of res.peers) {
      peers.set(p.id, { pc: null, callsign: p.callsign, audioEl: null, remoteMuted: false });
      await callPeer(p.id, p.callsign);
    }
    renderRoster();
  });
});

[inputCallsign, inputRoom].forEach((el) =>
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnJoin.click();
  })
);

btnMute.addEventListener("click", () => {
  muted = !muted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  muteLabel.textContent = muted ? "Микрофон выключен" : "Микрофон включён";
  btnMute.setAttribute("aria-pressed", String(muted));
  socket.emit("mic-state", { muted });
  renderRoster();
});

btnLeave.addEventListener("click", () => {
  window.location.reload();
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat-message", { text });
  chatInput.value = "";
});
