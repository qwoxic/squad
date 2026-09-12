const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

const CONNECT_TIMEOUT_MS = 9000;

const socket = io();

const screenJoin = document.getElementById("screen-join");
const screenRoom = document.getElementById("screen-room");
const inputCallsign = document.getElementById("input-callsign");
const inputRoom = document.getElementById("input-room");
const btnJoin = document.getElementById("btn-join");
const joinError = document.getElementById("join-error");

const roomCodeDisplay = document.getElementById("room-code-display");
const roster = document.getElementById("roster");
const rosterCount = document.getElementById("roster-count");
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

function statusLabel(status, isMuted) {
  if (status === "failed") return "не удалось соединиться";
  if (status === "connecting") return "соединение…";
  return isMuted ? "микрофон выключен" : "на связи";
}

function renderRoster() {
  roster.innerHTML = "";
  roster.appendChild(makeTile(selfId, selfCallsign, true, muted, "connected"));
  for (const [id, peer] of peers) {
    roster.appendChild(makeTile(id, peer.callsign, false, peer.remoteMuted, peer.status));
  }
  if (rosterCount) rosterCount.textContent = `${peers.size + 1}/5 на связи`;
}

function makeTile(id, callsign, isSelf, isMuted, status) {
  const tile = document.createElement("div");
  tile.className =
    "tile" +
    (isSelf ? " is-self" : "") +
    (isMuted ? " muted" : "") +
    (status === "failed" ? " failed" : "") +
    (status === "connecting" ? " connecting" : "");
  tile.dataset.peerId = id;

  const badge = document.createElement("span");
  badge.className = "tile-badge";
  badge.textContent = (callsign || "?").trim().charAt(0).toUpperCase() || "?";

  const led = document.createElement("span");
  led.className = "tile-led";
  badge.appendChild(led);

  const info = document.createElement("div");
  info.className = "tile-info";
  const name = document.createElement("div");
  name.className = "tile-name";
  name.textContent = callsign + (isSelf ? " (ты)" : "");
  const sub = document.createElement("div");
  sub.className = "tile-sub";
  sub.textContent = statusLabel(status, isMuted);

  info.appendChild(name);
  info.appendChild(sub);
  tile.appendChild(badge);
  tile.appendChild(info);
  return tile;
}

function setSpeaking(peerId, isSpeaking) {
  const tile = roster.querySelector(`[data-peer-id="${peerId}"]`);
  if (tile) tile.classList.toggle("speaking", isSpeaking);
}

function setPeerStatus(peerId, status) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.status = status;
  renderRoster();
}

async function initMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  watchLocalVolume(localStream, (speaking) => setSpeaking(selfId, speaking));
}

function watchLocalVolume(stream, cb) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

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

function shouldInitiate(peerId) {
  return selfId < peerId;
}

function clearConnectTimer(peer) {
  if (peer && peer.connectTimer) {
    clearTimeout(peer.connectTimer);
    peer.connectTimer = null;
  }
}

function armConnectTimer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  clearConnectTimer(peer);
  peer.connectTimer = setTimeout(() => {
    const p = peers.get(peerId);
    if (!p || !p.pc) return;
    const state = p.pc.iceConnectionState;
    if (state !== "connected" && state !== "completed") {
      if (shouldInitiate(peerId)) {
        p.pc.restartIce();
      }
    }
  }, CONNECT_TIMEOUT_MS);
}

function createPeerConnection(peerId, callsign) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal", { to: peerId, data: { type: "ice", candidate: e.candidate } });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    const peer = peers.get(peerId);
    if (state === "connected" || state === "completed") {
      clearConnectTimer(peer);
      setPeerStatus(peerId, "connected");
    } else if (state === "failed") {
      clearConnectTimer(peer);
      if (shouldInitiate(peerId)) pc.restartIce();
      setPeerStatus(peerId, "failed");
    } else if (state === "disconnected") {
      setPeerStatus(peerId, "connecting");
    } else if (state === "checking" || state === "new") {
      armConnectTimer(peerId);
    }
  };

  pc.ontrack = (e) => {
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.srcObject = e.streams[0];
    document.body.appendChild(audioEl);
    const peer = peers.get(peerId);
    if (peer) peer.audioEl = audioEl;
    watchLocalVolume(e.streams[0], (speaking) => setSpeaking(peerId, speaking));
  };

  const existing = peers.get(peerId) || {};
  peers.set(peerId, {
    ...existing,
    pc,
    callsign,
    audioEl: existing.audioEl || null,
    remoteMuted: existing.remoteMuted || false,
    status: "connecting",
    pendingCandidates: existing.pendingCandidates || [],
    connectTimer: null,
  });
  return pc;
}

async function flushPendingCandidates(peerId) {
  const peer = peers.get(peerId);
  if (!peer || !peer.pc || !peer.pendingCandidates.length) return;
  const queued = peer.pendingCandidates.splice(0);
  for (const candidate of queued) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("ice candidate failed", err);
    }
  }
}

async function callPeer(peerId, callsign) {
  const pc = createPeerConnection(peerId, callsign);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("signal", { to: peerId, data: { type: "offer", sdp: offer } });
  renderRoster();
}

async function connectToPeer(peerId, callsign) {
  if (shouldInitiate(peerId)) {
    await callPeer(peerId, callsign);
  } else {
    peers.set(peerId, {
      pc: null,
      callsign,
      audioEl: null,
      remoteMuted: false,
      status: "connecting",
      pendingCandidates: [],
      connectTimer: null,
    });
    renderRoster();
  }
}

async function handleSignal({ from, data }) {
  if (data.type === "offer") {
    const existing = peers.get(from);
    const pc = existing && existing.pc ? existing.pc : createPeerConnection(from, existing ? existing.callsign : "Operator");
    await pc.setRemoteDescription(data.sdp);
    await flushPendingCandidates(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("signal", { to: from, data: { type: "answer", sdp: answer } });
  } else if (data.type === "answer") {
    const peer = peers.get(from);
    if (peer && peer.pc) {
      await peer.pc.setRemoteDescription(data.sdp);
      await flushPendingCandidates(from);
    }
  } else if (data.type === "ice") {
    const peer = peers.get(from);
    if (!peer) return;
    if (peer.pc && peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
      try {
        await peer.pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn("ice candidate failed", err);
      }
    } else {
      peer.pendingCandidates.push(data.candidate);
    }
  }
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  clearConnectTimer(peer);
  if (peer.pc) peer.pc.close();
  if (peer.audioEl) peer.audioEl.remove();
  peers.delete(peerId);
  renderRoster();
}

socket.on("signal", handleSignal);

socket.on("peer-joined", async ({ id, callsign }) => {
  addChatLine({ system: true, text: `${callsign} вышел на связь.` });
  await connectToPeer(id, callsign);
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
