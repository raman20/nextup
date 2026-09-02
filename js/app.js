import {
  applyAction,
  createRoom,
  formatDuration,
  generateCode,
  generateId,
  HOST_GONE_MS,
  isValidCode,
  normalizeCode,
  parseVideoId,
  thumbnailUrl,
} from "./room.js";
import { connectRoom } from "./net.js";
import { createHostPlayer, loadIframeApi, lookupOEmbed, searchYoutube } from "./youtube.js";
import { drawQr } from "./qr.js";

const $ = (id) => document.getElementById(id);

const ui = {
  viewHome: $("view-home"),
  viewRoom: $("view-room"),
  nick: $("nick"),
  joinCode: $("join-code"),
  roomCode: $("room-code"),
  banner: $("banner"),
  playerWrap: $("player-wrap"),
  startOverlay: $("start-overlay"),
  nowImg: $("now-img"),
  nowKicker: $("now-kicker"),
  nowTitle: $("now-title"),
  nowSub: $("now-sub"),
  queue: $("queue"),
  results: $("results"),
  search: $("search"),
  toast: $("toast"),
  btnLock: $("btn-lock"),
  btnGear: $("btn-gear"),
  btnPause: $("btn-pause"),
  modalQr: $("modal-qr"),
  modalGear: $("modal-gear"),
  qrCanvas: $("qr-canvas"),
  qrLabel: $("qr-code-label"),
  qrUrl: $("qr-url"),
  ytKey: $("yt-key"),
};

const LS_ID = "nextup.memberId";
const LS_NICK = "nextup.nickname";
const LS_KEY = "nextup.ytKey";
const LS_HOSTS = "nextup.hostCodes";

function loadHosts() {
  try {
    return JSON.parse(localStorage.getItem(LS_HOSTS) || "[]");
  } catch {
    return [];
  }
}
function saveHosts(arr) {
  localStorage.setItem(LS_HOSTS, JSON.stringify(arr));
}

const memberId = localStorage.getItem(LS_ID) || (() => {
  const id = generateId();
  localStorage.setItem(LS_ID, id);
  return id;
})();

ui.nick.value = localStorage.getItem(LS_NICK) || "";
ui.ytKey.value = localStorage.getItem(LS_KEY) || "";

let bus = null;
let room = null;
let isHost = false;
let started = false;
let player = null;
let lastLoaded = null;
let lastHostBeat = 0;
let hostWatch = null;
let pendingSearch = null;
let searchTimer = 0;
let wakeLock = null;
let toastTimer = 0;
let ignoreEndedUntil = 0;
let statusText = "";

function nickname() {
  return (ui.nick.value || localStorage.getItem(LS_NICK) || "Guest").trim().slice(0, 20) || "Guest";
}

function showHome() {
  ui.viewHome.classList.add("on");
  ui.viewRoom.classList.remove("on");
}

function showRoom() {
  ui.viewHome.classList.remove("on");
  ui.viewRoom.classList.add("on");
}

function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("on"), 2600);
}

function setBanner(text, bad) {
  ui.banner.textContent = text || "";
  ui.banner.classList.toggle("on", !!text);
  ui.banner.classList.toggle("bad", !!bad);
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}#/r/${code}`;
}

function publishState() {
  if (!bus || !isHost || !room) return;
  bus.publish("state", { from: memberId, room }, true);
  bus.publish("host", { memberId, online: true, ts: Date.now() }, true);
}

function remountPlayer() {
  const stage = document.querySelector(".stage");
  const overlay = $("start-overlay");
  const old = $("yt-player");
  if (old) old.remove();
  const d = document.createElement("div");
  d.id = "yt-player";
  stage.insertBefore(d, overlay);
}

function localApply(from, action) {
  const res = applyAction(room, from, action);
  if (res.error) {
    toast(res.error);
    return false;
  }
  room = res.room;
  if (isHost && started && !room.nowPlaying && room.queue.length && action.type === "add") {
    room = applyAction(room, memberId, { type: "start" }).room;
  }
  lastHostBeat = Date.now();
  render();
  if (isHost) {
    publishState();
    syncPlayer();
  }
  return true;
}

function send(action) {
  if (!room) return;
  if (isHost) localApply(memberId, action);
  else if (bus) bus.publish("action", { ...action, from: memberId });
}

async function requestWake() {
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}

function dropWake() {
  try {
    if (wakeLock) wakeLock.release();
  } catch {}
  wakeLock = null;
}

function render() {
  if (!room) return;
  ui.roomCode.textContent = room.code;
  const hostBits = document.querySelectorAll(".host-only");
  hostBits.forEach((el) => {
    el.hidden = !isHost;
  });
  ui.playerWrap.classList.toggle("on", isHost);
  ui.btnLock.textContent = room.locked ? "🔒" : "🔓";
  ui.btnPause.textContent = room.paused ? "Resume" : "Pause";
  ui.startOverlay.classList.toggle("gone", started && !!room.nowPlaying);

  const np = room.nowPlaying;
  if (np) {
    ui.nowImg.src = np.thumbnail || thumbnailUrl(np.videoId);
    ui.nowKicker.textContent = room.paused ? "PAUSED" : "NOW PLAYING";
    ui.nowTitle.textContent = np.title;
    const who = np.addedBy && np.addedBy.name ? np.addedBy.name : "someone";
    const dur = formatDuration(np.durationSec);
    ui.nowSub.textContent = [who, np.channelTitle, dur].filter(Boolean).join(" · ");
  } else {
    ui.nowImg.removeAttribute("src");
    ui.nowKicker.textContent = "NOTHING PLAYING";
    ui.nowTitle.textContent = room.queue.length ? "Host: tap Start the party" : "Queue a song to begin";
    ui.nowSub.textContent = room.locked ? "Queue is locked" : `${room.members.filter((m) => m.connected).length} here`;
  }

  ui.queue.replaceChildren();
  if (!room.queue.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = room.locked ? "Queue locked by host." : "Nothing queued. Search or paste a YouTube link.";
    ui.queue.appendChild(empty);
  } else {
    for (const t of room.queue) ui.queue.appendChild(trackEl(t));
  }

  const gone = !isHost && Date.now() - lastHostBeat > HOST_GONE_MS && lastHostBeat > 0;
  if (statusText) setBanner(statusText, statusText !== "connected" && statusText !== "live");
  else if (gone) setBanner("Host left — playback pauses until they reopen this room.", true);
  else if (isHost && document.visibilityState === "hidden") setBanner("This tab is in the background. iPhone will stop YouTube.", true);
  else if (isHost) setBanner("Keep this tab open. This phone is the speaker.", false);
  else setBanner("", false);
}

function trackEl(t) {
  const my = (t.votes && t.votes[memberId]) || 0;
  const row = document.createElement("div");
  row.className = "q-item";

  const votes = document.createElement("div");
  votes.className = "votes";
  const up = document.createElement("button");
  up.textContent = "▲";
  up.className = my === 1 ? "on-up" : "";
  up.onclick = () => send({ type: "vote", trackId: t.id, value: 1 });
  const sc = document.createElement("div");
  sc.className = "score";
  sc.textContent = String(t.score);
  const down = document.createElement("button");
  down.textContent = "▼";
  down.className = my === -1 ? "on-down" : "";
  down.onclick = () => send({ type: "vote", trackId: t.id, value: -1 });
  votes.append(up, sc, down);

  const img = document.createElement("img");
  img.alt = "";
  img.src = t.thumbnail || thumbnailUrl(t.videoId);

  const meta = document.createElement("div");
  meta.className = "meta";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = t.title;
  const sub = document.createElement("div");
  sub.className = "sub";
  const who = t.addedBy && t.addedBy.name ? t.addedBy.name : "someone";
  sub.textContent = [who, t.channelTitle, formatDuration(t.durationSec)].filter(Boolean).join(" · ");
  meta.append(title, sub);

  const x = document.createElement("button");
  x.className = "x";
  x.textContent = "✕";
  x.title = "Remove";
  x.onclick = () => send({ type: "remove", trackId: t.id });

  row.append(votes, img, meta, x);
  return row;
}

function showResults(items, error) {
  ui.results.hidden = !error && (!items || !items.length);
  ui.results.replaceChildren();
  if (error) {
    const p = document.createElement("div");
    p.className = "hint";
    p.style.padding = "8px";
    p.textContent = error;
    ui.results.appendChild(p);
    ui.results.hidden = false;
    return;
  }
  for (const it of items || []) {
    const b = document.createElement("button");
    b.className = "res";
    const img = document.createElement("img");
    img.src = it.thumbnail;
    img.alt = "";
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = it.title;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = [it.channelTitle, formatDuration(it.durationSec)].filter(Boolean).join(" · ");
    meta.append(title, sub);
    b.append(img, meta);
    b.onclick = () => {
      addTrack(it);
      ui.results.hidden = true;
      ui.search.value = "";
    };
    ui.results.appendChild(b);
  }
}

async function addTrack(meta) {
  send({
    type: "add",
    videoId: meta.videoId,
    title: meta.title,
    thumbnail: meta.thumbnail,
    channelTitle: meta.channelTitle,
    durationSec: meta.durationSec,
  });
}

async function addByVideoId(videoId) {
  let meta = {
    videoId,
    title: "YouTube video",
    thumbnail: thumbnailUrl(videoId),
    channelTitle: "",
    durationSec: null,
  };
  try {
    meta = { ...meta, ...(await lookupOEmbed(videoId)) };
  } catch {}
  addTrack(meta);
}

async function handleSearch(q) {
  const id = parseVideoId(q);
  if (id) {
    showResults([]);
    await addByVideoId(id);
    ui.search.value = "";
    return;
  }
  if (isHost) {
    const key = localStorage.getItem(LS_KEY);
    if (!key) {
      showResults(null, "Host has not enabled search. Paste a YouTube link, or add an API key in ⚙.");
      return;
    }
    try {
      const items = await searchYoutube(q, key);
      showResults(items, items.length ? "" : "No embeddable videos.");
    } catch (e) {
      const m = String(e.message || e);
      showResults(null, m === "QUOTA" ? "YouTube search quota is used up for today. Paste links instead." : m);
    }
    return;
  }
  pendingSearch = generateId();
  if (bus) bus.publish("action", { type: "search", from: memberId, q, requestId: pendingSearch });
}

async function hostSearchFor(obj) {
  const key = localStorage.getItem(LS_KEY);
  let payload = { requestId: obj.requestId, items: [], error: null };
  if (!key) payload.error = "Host has not enabled search. Paste a YouTube link.";
  else {
    try {
      payload.items = await searchYoutube(obj.q, key);
      if (!payload.items.length) payload.error = "No embeddable videos.";
    } catch (e) {
      const m = String(e.message || e);
      payload.error = m === "QUOTA" ? "YouTube search quota is used up for today. Paste links instead." : m;
    }
  }
  bus.publish("search/" + obj.requestId, payload);
}

function onBus(tail, obj) {
  if (!obj) return;
  if (tail === "state" && obj.room && obj.from === obj.room.hostId) {
    room = obj.room;
    lastHostBeat = Date.now();
    statusText = "live";
    render();
    return;
  }
  if (tail === "host") {
    if (obj.online) lastHostBeat = Date.now();
    render();
    return;
  }
  if (!isHost) {
    if (tail.startsWith("search/") && obj.requestId === pendingSearch) {
      showResults(obj.items, obj.error);
    }
    return;
  }
  if (tail === "hello" && obj.memberId) {
    localApply(obj.memberId, { type: "hello", name: obj.name });
    return;
  }
  if (tail === "bye" && obj.memberId) {
    localApply(obj.memberId, { type: "bye" });
    return;
  }
  if (tail === "action" && obj.from && obj.from !== memberId) {
    if (obj.type === "search") {
      hostSearchFor(obj);
      return;
    }
    localApply(obj.from, obj);
  }
}

async function ensurePlayer() {
  if (!isHost || player) return;
  await loadIframeApi();
  player = createHostPlayer("yt-player", {
    onEnded() {
      if (Date.now() < ignoreEndedUntil) return;
      ignoreEndedUntil = Date.now() + 1200;
      send({ type: "ended" });
    },
    onError() {
      toast("Video can’t play here — skipping");
      ignoreEndedUntil = Date.now() + 1200;
      send({ type: "error" });
    },
    onPlaying(data) {
      if (data && data.title && room && room.nowPlaying && room.nowPlaying.videoId === data.video_id) {
        if (room.nowPlaying.title === "YouTube video") {
          send({ type: "retitle", videoId: data.video_id, title: data.title, channelTitle: data.author });
        }
      }
    },
  });
}

function syncPlayer() {
  if (!isHost || !player || !room) return;
  const np = room.nowPlaying;
  if (!np) return;
  if (np.videoId !== lastLoaded) {
    lastLoaded = np.videoId;
    ignoreEndedUntil = Date.now() + 1500;
    player.load(np.videoId, started);
  } else if (started) {
    if (room.paused) player.pause();
    else player.play();
  }
}

async function enterRoom(code, asHost) {
  code = normalizeCode(code);
  if (!isValidCode(code)) {
    toast("Bad room code");
    return;
  }
  localStorage.setItem(LS_NICK, nickname());
  isHost = asHost;
  started = false;
  lastLoaded = null;
  lastHostBeat = Date.now();
  statusText = "connecting…";
  if (asHost && !room) room = createRoom(code, memberId, nickname());
  if (!asHost) room = createRoom(code, "unknown", "Host");
  showRoom();
  render();
  if (bus) {
    bus.close();
    bus = null;
  }
  try {
    bus = await connectRoom({
      code,
      memberId,
      isHost,
      onMessage: onBus,
      onStatus(s) {
        statusText = s;
        render();
      },
    });
    bus.publish("hello", { memberId, name: nickname(), role: isHost ? "host" : "guest" });
    if (isHost) {
      publishState();
      await ensurePlayer();
      if (!hostWatch) {
        hostWatch = setInterval(() => {
          if (isHost && bus) bus.publish("host", { memberId, online: true, ts: Date.now() }, true);
          render();
        }, 10000);
      }
    }
    location.hash = "#/r/" + code;
    statusText = "live";
    render();
  } catch (e) {
    statusText = "";
    setBanner("Could not reach the message bus. Try again in a moment.", true);
    toast(e.message || "connect failed");
  }
}

function leave() {
  if (hostWatch) {
    clearInterval(hostWatch);
    hostWatch = null;
  }
  if (bus) bus.close();
  bus = null;
  if (player) {
    player.destroy();
    player = null;
  }
  remountPlayer();
  dropWake();
  room = null;
  isHost = false;
  started = false;
  showHome();
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

function route() {
  const m = /^#\/r\/([A-Za-z0-9]+)/.exec(location.hash || "");
  if (!m) {
    if (room) return;
    showHome();
    return;
  }
  const code = normalizeCode(m[1]);
  const hosts = loadHosts();
  const asHost = hosts.includes(code);
  if (room && room.code === code) return;
  enterRoom(code, asHost);
}

$("btn-create").onclick = () => {
  if (!nickname()) {
    toast("Pick a name first");
    ui.nick.focus();
    return;
  }
  const code = generateCode();
  const hosts = loadHosts();
  hosts.push(code);
  saveHosts(hosts);
  room = createRoom(code, memberId, nickname());
  enterRoom(code, true);
};

$("btn-join").onclick = () => {
  if (!nickname()) {
    toast("Pick a name first");
    ui.nick.focus();
    return;
  }
  enterRoom(ui.joinCode.value, false);
};

ui.joinCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

$("btn-leave").onclick = leave;

$("btn-start").onclick = async () => {
  started = true;
  ui.startOverlay.classList.add("gone");
  send({ type: "start" });
  await requestWake();
  syncPlayer();
};

$("btn-skip").onclick = () => send({ type: "skip" });
$("btn-pause").onclick = () => send({ type: "pause", paused: !room.paused });
$("btn-lock").onclick = () => send({ type: "lock", locked: !room.locked });

$("btn-qr").onclick = () => {
  if (!room) return;
  const url = joinUrl(room.code);
  ui.qrLabel.textContent = room.code;
  ui.qrUrl.textContent = url;
  try {
    drawQr(ui.qrCanvas, url);
  } catch (e) {
    toast("QR failed: " + e.message);
  }
  ui.modalQr.classList.add("on");
};
$("btn-close-qr").onclick = () => ui.modalQr.classList.remove("on");
$("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(joinUrl(room.code));
    toast("Link copied");
  } catch {
    toast(joinUrl(room.code));
  }
};

$("btn-gear").onclick = () => ui.modalGear.classList.add("on");
$("btn-close-gear").onclick = () => ui.modalGear.classList.remove("on");
$("btn-save-key").onclick = () => {
  localStorage.setItem(LS_KEY, ui.ytKey.value.trim());
  toast("Key saved on this phone only");
  ui.modalGear.classList.remove("on");
};

ui.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = ui.search.value.trim();
  if (!q) {
    ui.results.hidden = true;
    return;
  }
  searchTimer = setTimeout(() => handleSearch(q), 400);
});
ui.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchTimer);
    handleSearch(ui.search.value.trim());
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isHost && started) requestWake();
  render();
});

window.addEventListener("hashchange", route);
route();
