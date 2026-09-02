import { parseVideoId, thumbnailUrl } from "./room.js";
import { clientId } from "./config.js";
import { getToken, initGoogle, signIn, signedIn } from "./google-auth.js";
import {
  bumpDown,
  bumpUp,
  createPlaylist,
  deleteItem,
  getPlaylist,
  insertVideo,
  listItems,
  myChannelId,
  parsePlaylistId,
  playlistWatchUrl,
  searchVideos,
  shortCode,
  videoMeta,
} from "./yt-playlist.js";
import { createHostPlayer, loadIframeApi, lookupOEmbed } from "./youtube.js";
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
  authStatus: $("auth-status"),
  clientIdInput: $("google-client-id"),
};

const LS_OWNED = "nextup.ownedPlaylists";
const LS_NICK = "nextup.nickname";
const LS_CID = "nextup.googleClientId";

function ownedIds() {
  try {
    return JSON.parse(localStorage.getItem(LS_OWNED) || "[]");
  } catch {
    return [];
  }
}
function rememberOwned(id) {
  const a = ownedIds();
  if (!a.includes(id)) {
    a.push(id);
    localStorage.setItem(LS_OWNED, JSON.stringify(a));
  }
}

ui.nick.value = localStorage.getItem(LS_NICK) || "";
if (ui.clientIdInput) ui.clientIdInput.value = localStorage.getItem(LS_CID) || "";

let playlistId = null;
let playlistOwner = null;
let myChannel = null;
let items = [];
let isHost = false;
let canWrite = false;
let started = false;
let paused = false;
let player = null;
let playerBoot = null;
let lastLoaded = null;
let searchTimer = 0;
let wakeLock = null;
let toastTimer = 0;
let ignoreEndedUntil = 0;
let actuallyPlaying = false;
let leaving = false;
let pollTimer = 0;
let etag = null;
let lastError = "";

function nickname() {
  return (ui.nick.value || localStorage.getItem(LS_NICK) || "").trim().slice(0, 20);
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
  toastTimer = setTimeout(() => ui.toast.classList.remove("on"), 2800);
}

function setBanner(text, bad) {
  ui.banner.textContent = text || "";
  ui.banner.classList.toggle("on", !!text);
  ui.banner.classList.toggle("bad", !!bad);
}

function joinUrl() {
  return `${location.origin}${location.pathname}#/p/${playlistId}`;
}

function tokenOrThrow() {
  const t = getToken();
  if (!t) {
    signIn();
    throw new Error("Sign in with Google first");
  }
  return t;
}

function toastAuth() {
  if (ui.authStatus) {
    ui.authStatus.textContent = signedIn() ? "Signed in with Google" : "Not signed in";
  }
}

function renderHomeAuth() {
  toastAuth();
  const need = !clientId();
  const setup = $("setup-panel");
  if (setup) setup.hidden = !need;
}

async function requestWake() {
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}

function nowItem() {
  return items[0] || null;
}
function upNext() {
  return items.slice(1);
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

function render() {
  if (!playlistId) return;
  ui.roomCode.textContent = shortCode(playlistId);
  const hostBits = document.querySelectorAll(".host-only");
  hostBits.forEach((el) => {
    el.hidden = !isHost;
  });
  if (ui.btnLock) ui.btnLock.hidden = true;
  ui.playerWrap.classList.toggle("on", isHost);
  if (ui.btnPause) ui.btnPause.textContent = paused ? "Resume" : "Pause";
  const startBtn = $("btn-start");
  if (startBtn) startBtn.textContent = started ? "Tap to play" : "Start the party";
  ui.startOverlay.classList.toggle("gone", actuallyPlaying && !paused);

  const np = nowItem();
  if (np) {
    ui.nowImg.src = np.thumbnail || thumbnailUrl(np.videoId);
    ui.nowKicker.textContent = !started ? "UP NEXT" : paused ? "PAUSED" : actuallyPlaying ? "NOW PLAYING" : "READY";
    ui.nowTitle.textContent = np.title;
    ui.nowSub.textContent = [np.channelTitle, np.addedBy].filter(Boolean).join(" · ");
  } else {
    ui.nowImg.removeAttribute("src");
    ui.nowKicker.textContent = "NOTHING PLAYING";
    ui.nowTitle.textContent = "Queue a song to begin";
    ui.nowSub.textContent = canWrite ? "Paste a YouTube link or search" : "Sign in to add songs";
  }

  ui.queue.replaceChildren();
  const rest = started ? upNext() : items;
  if (!rest.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing queued. Search or paste a YouTube link.";
    ui.queue.appendChild(empty);
  } else {
    for (const t of rest) ui.queue.appendChild(trackEl(t, started ? 1 : 0));
  }

  if (lastError) setBanner(lastError, true);
  else if (isHost) setBanner("Keep this tab open. This phone is the speaker. Queue is a YouTube playlist.", false);
  else setBanner(canWrite ? "" : "Sign in with Google to add. If add fails, ask the host to enable Collaborate on the playlist.", false);
}

function trackEl(t, minPos) {
  const row = document.createElement("div");
  row.className = "q-item";
  const votes = document.createElement("div");
  votes.className = "votes";
  const up = document.createElement("button");
  up.textContent = "▲";
  up.onclick = () => vote(t, -1, minPos);
  const sc = document.createElement("div");
  sc.className = "score";
  sc.textContent = String((t.position || 0) + 1);
  const down = document.createElement("button");
  down.textContent = "▼";
  down.onclick = () => vote(t, +1, minPos);
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
  sub.textContent = [t.channelTitle, t.addedBy].filter(Boolean).join(" · ");
  meta.append(title, sub);

  const x = document.createElement("button");
  x.className = "x";
  x.textContent = "✕";
  x.onclick = () => removeItem(t);

  row.append(votes, img, meta, x);
  return row;
}

function showResults(list, error) {
  ui.results.hidden = !error && (!list || !list.length);
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
  for (const it of list || []) {
    const b = document.createElement("button");
    b.className = "res";
    const img = document.createElement("img");
    img.src = it.thumbnail || thumbnailUrl(it.videoId);
    img.alt = "";
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = it.title;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = it.channelTitle || "";
    meta.append(title, sub);
    b.append(img, meta);
    b.onclick = () => {
      addVideo(it.videoId);
      ui.results.hidden = true;
      ui.search.value = "";
    };
    ui.results.appendChild(b);
  }
}

async function refreshQueue() {
  if (!playlistId || leaving) return;
  const tok = getToken();
  if (!tok) return;
  try {
    const data = await listItems(tok, playlistId, etag);
    lastError = "";
    if (data.unchanged) return;
    etag = data.etag;
    items = data.items || [];
    render();
    syncPlayer();
  } catch (e) {
    if (e.status === 401) {
      lastError = "Google sign-in expired — tap Sign in.";
      render();
      return;
    }
    lastError = e.message || "Could not read playlist";
    render();
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    if (document.visibilityState === "hidden" && !isHost) return;
    refreshQueue();
  }, isHost ? 3000 : 5000);
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
}

async function addVideo(videoId) {
  try {
    const tok = tokenOrThrow();
    await insertVideo(tok, playlistId, videoId);
    etag = null;
    await refreshQueue();
  } catch (e) {
    if (e.status === 403 || e.reason === "forbidden" || /forbidden|insufficient/i.test(e.message || "")) {
      toast("YouTube blocked the add. Owner/collaborator only — enable Collaborate on the playlist.");
    } else if (e.status === 409 || /duplicate/i.test(e.message || "")) {
      toast("Already in the playlist");
    } else toast(e.message || "Add failed");
  }
}

async function vote(item, dir, minPos) {
  try {
    const tok = tokenOrThrow();
    if (dir < 0) await bumpUp(tok, playlistId, item, minPos);
    else await bumpDown(tok, playlistId, item);
    etag = null;
    await refreshQueue();
  } catch (e) {
    toast(e.message || "Could not move song");
  }
}

async function removeItem(item) {
  try {
    const tok = tokenOrThrow();
    await deleteItem(tok, item.playlistItemId);
    etag = null;
    await refreshQueue();
  } catch (e) {
    toast(e.message || "Could not remove");
  }
}

async function skip() {
  const np = nowItem();
  if (!np) return;
  try {
    const tok = tokenOrThrow();
    await deleteItem(tok, np.playlistItemId);
    actuallyPlaying = false;
    lastLoaded = null;
    etag = null;
    await refreshQueue();
    if (started) kickPlay();
  } catch (e) {
    toast(e.message || "Skip failed");
  }
}

async function ensurePlayer() {
  if (!isHost) return;
  if (player) return;
  if (playerBoot) return playerBoot;
  playerBoot = (async () => {
    await loadIframeApi();
    if (player) return;
    player = createHostPlayer("yt-player", {
      onReady() {
        syncPlayer();
      },
      onEnded() {
        if (Date.now() < ignoreEndedUntil) return;
        ignoreEndedUntil = Date.now() + 1200;
        actuallyPlaying = false;
        skip();
      },
      onError() {
        toast("This video can’t play in the embed — skipping");
        ignoreEndedUntil = Date.now() + 1200;
        actuallyPlaying = false;
        skip();
      },
      onPlaying() {
        actuallyPlaying = true;
        ui.startOverlay.classList.add("gone");
        render();
      },
      onPaused() {
        actuallyPlaying = false;
        render();
      },
    });
  })();
  return playerBoot;
}

function syncPlayer() {
  if (!isHost || !player) return;
  const np = nowItem();
  if (!np) return;
  const shouldPlay = started && !paused;
  if (np.videoId !== lastLoaded) {
    lastLoaded = np.videoId;
    ignoreEndedUntil = Date.now() + 1500;
    player.load(np.videoId, shouldPlay);
  } else if (shouldPlay) player.play();
  else if (paused) player.pause();
}

function kickPlay() {
  started = true;
  paused = false;
  if (!nowItem()) {
    toast("Queue a song first");
    return;
  }
  syncPlayer();
  if (player) player.play();
  requestWake();
}

async function enterPlaylist(id, asHost) {
  const pid = parsePlaylistId(id) || id;
  if (!pid) {
    toast("Need a YouTube playlist URL or ID");
    return;
  }
  leaving = false;
  localStorage.setItem(LS_NICK, nickname());
  playlistId = pid;
  isHost = asHost || ownedIds().includes(pid);
  started = false;
  paused = false;
  actuallyPlaying = false;
  lastLoaded = null;
  items = [];
  etag = null;
  lastError = "";
  location.hash = "#/p/" + pid;
  showRoom();
  render();
  if (isHost) ensurePlayer();

  if (!signedIn()) {
    lastError = "Sign in with Google to load this playlist.";
    render();
    try {
      signIn();
    } catch {}
    return;
  }

  try {
    const tok = getToken();
    const pl = await getPlaylist(tok, pid);
    if (!pl) throw new Error("Playlist not found (sign in, and use an unlisted/public list)");
    playlistOwner = pl.snippet && pl.snippet.channelId;
    try {
      myChannel = await myChannelId(tok);
    } catch {}
    isHost = ownedIds().includes(pid);
    canWrite = isHost || (myChannel && playlistOwner && myChannel === playlistOwner);
    await refreshQueue();
    startPoll();
    if (isHost) await ensurePlayer();
    render();
  } catch (e) {
    lastError = e.message || "Could not open playlist";
    render();
  }
}

async function createRoom() {
  if (!clientId()) {
    toast("Add a Google OAuth client ID in setup first");
    return;
  }
  if (!signedIn()) {
    signIn();
    toast("Sign in, then tap Create again");
    return;
  }
  const title = "NextUp " + (nickname() || "party") + " " + new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    const pl = await createPlaylist(getToken(), title);
    const id = pl.id;
    rememberOwned(id);
    isHost = true;
    canWrite = true;
    await enterPlaylist(id, true);
  } catch (e) {
    toast(e.message || "Could not create playlist");
  }
}

function leave() {
  leaving = true;
  stopPoll();
  if (player) {
    player.destroy();
    player = null;
  }
  playerBoot = null;
  remountPlayer();
  playlistId = null;
  items = [];
  isHost = false;
  started = false;
  actuallyPlaying = false;
  showHome();
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  renderHomeAuth();
}

function route() {
  const m = /^#\/p\/(PL[\w-]+)/i.exec(location.hash || "");
  if (!m) {
    if (playlistId) return;
    showHome();
    renderHomeAuth();
    return;
  }
  if (playlistId && playlistId === m[1]) return;
  enterPlaylist(m[1], ownedIds().includes(m[1]));
}

function bootGoogle() {
  const id = clientId();
  if (!id) {
    renderHomeAuth();
    return;
  }
  const ok = initGoogle(id, (yes, err) => {
    toastAuth();
    if (yes && playlistId) enterPlaylist(playlistId, isHost);
    if (!yes && err) toast(String(err));
    renderHomeAuth();
  });
  if (!ok) {
    setTimeout(bootGoogle, 250);
  }
  renderHomeAuth();
}

$("btn-create").onclick = () => createRoom();
$("btn-join").onclick = () => enterPlaylist(ui.joinCode.value, false);
$("btn-google").onclick = () => {
  if (!clientId()) {
    toast("Paste a Google client ID in setup first");
    return;
  }
  try {
    signIn();
  } catch (e) {
    toast(e.message);
  }
};
$("btn-save-setup").onclick = () => {
  const v = (ui.clientIdInput && ui.clientIdInput.value.trim()) || "";
  if (v) localStorage.setItem(LS_CID, v);
  else localStorage.removeItem(LS_CID);
  toast("Saved on this phone. For everyone, put it in js/config.js and deploy.");
  bootGoogle();
};

ui.joinCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

$("btn-leave").onclick = leave;
$("btn-start").onclick = () => kickPlay();
$("btn-skip").onclick = () => skip();
$("btn-pause").onclick = () => {
  paused = !paused;
  if (paused && player) player.pause();
  else kickPlay();
  render();
};

$("btn-qr").onclick = () => {
  if (!playlistId) return;
  const url = joinUrl();
  ui.qrLabel.textContent = shortCode(playlistId);
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
    await navigator.clipboard.writeText(joinUrl());
    toast("Link copied");
  } catch {
    toast(joinUrl());
  }
};

$("btn-gear").onclick = () => {
  const link = $("playlist-link");
  if (link && playlistId) {
    link.href = playlistWatchUrl(playlistId);
    link.textContent = "Open this playlist on YouTube";
  }
  if (ui.ytKey) ui.ytKey.value = localStorage.getItem(LS_CID) || "";
  ui.modalGear.classList.add("on");
};
$("btn-close-gear").onclick = () => ui.modalGear.classList.remove("on");
$("btn-save-key").onclick = () => {
  const v = (ui.ytKey && ui.ytKey.value.trim()) || "";
  if (v) localStorage.setItem(LS_CID, v);
  else localStorage.removeItem(LS_CID);
  toast("Client ID saved on this phone");
  ui.modalGear.classList.remove("on");
  bootGoogle();
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

async function handleSearch(q) {
  const vid = parseVideoId(q);
  if (vid) {
    let meta = null;
    try {
      meta = await videoMeta(tokenOrThrow(), vid);
    } catch {
      try {
        meta = await lookupOEmbed(vid);
      } catch {}
    }
    await addVideo(vid);
    ui.search.value = "";
    ui.results.hidden = true;
    return;
  }
  try {
    const list = await searchVideos(tokenOrThrow(), q);
    showResults(list, list.length ? "" : "No embeddable videos");
  } catch (e) {
    showResults(null, e.message || "Search failed");
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && playlistId) refreshQueue();
  render();
});

window.addEventListener("hashchange", route);
window.addEventListener("load", () => {
  bootGoogle();
  route();
});
bootGoogle();
route();
