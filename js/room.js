/** Pure room/queue rules. No DOM, no network. */

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const MAX_UNPLAYED = 3;
export const HOST_GONE_MS = 30000;

export function generateCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function isValidCode(code) {
  if (!code || code.length < 4 || code.length > 8) return false;
  const u = code.toUpperCase();
  for (const ch of u) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function normalizeCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Extract an 11-char YouTube video id from a URL or raw id. */
export function parseVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const parts = u.pathname.split("/").filter(Boolean);
    if ((parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" || parts[0] === "v") && /^[\w-]{11}$/.test(parts[1])) {
      return parts[1];
    }
  }
  return null;
}

export function thumbnailUrl(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function scoreOf(votes) {
  let s = 0;
  for (const v of Object.values(votes || {})) s += v;
  return s;
}

export function rankQueue(tracks) {
  return [...tracks].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.addedAt - b.addedAt;
  });
}

export function createRoom(code, hostId, hostName) {
  return {
    code,
    hostId,
    locked: false,
    createdAt: Date.now(),
    paused: false,
    members: [{ id: hostId, name: hostName, connected: true }],
    nowPlaying: null,
    queue: [],
  };
}

export function cloneRoom(room) {
  return JSON.parse(JSON.stringify(room));
}

function unplayedCount(room, memberId) {
  let n = 0;
  for (const t of room.queue) if (t.addedBy.memberId === memberId) n++;
  return n;
}

function hasVideo(room, videoId) {
  if (room.nowPlaying && room.nowPlaying.videoId === videoId) return true;
  return room.queue.some((t) => t.videoId === videoId);
}

function findTrack(room, trackId) {
  return room.queue.find((t) => t.id === trackId) || null;
}

function takeNext(room) {
  if (room.queue.length === 0) {
    room.nowPlaying = null;
    room.paused = false;
    return;
  }
  room.queue = rankQueue(room.queue);
  const next = room.queue[0];
  room.queue = room.queue.slice(1);
  room.nowPlaying = { ...next, startedAt: Date.now() };
  room.paused = false;
}

function upsertMember(room, id, name, connected) {
  const existing = room.members.find((m) => m.id === id);
  if (existing) {
    existing.connected = connected;
    if (name) existing.name = name;
  } else {
    room.members.push({ id, name: name || "Guest", connected });
  }
}

/**
 * Apply an action. Returns { room } on success or { room, error }.
 * Never mutates the input room.
 */
export function applyAction(room, from, action) {
  const next = cloneRoom(room);
  const isHost = from === next.hostId;
  const type = action && action.type;

  if (type === "hello") {
    upsertMember(next, from, action.name, true);
    return { room: next };
  }

  if (type === "bye") {
    upsertMember(next, from, null, false);
    return { room: next };
  }

  if (type === "add") {
    if (next.locked && !isHost) return { room, error: "Queue is locked" };
    const videoId = action.videoId;
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return { room, error: "Invalid video" };
    if (hasVideo(next, videoId)) return { room, error: "Already in the queue" };
    if (unplayedCount(next, from) >= MAX_UNPLAYED) {
      return { room, error: `Max ${MAX_UNPLAYED} unplayed songs each` };
    }
    const member = next.members.find((m) => m.id === from);
    const votes = { [from]: 1 };
    next.queue.push({
      id: action.trackId || generateId(),
      videoId,
      title: String(action.title || "YouTube video").slice(0, 200),
      thumbnail: action.thumbnail || thumbnailUrl(videoId),
      channelTitle: String(action.channelTitle || "").slice(0, 120),
      durationSec: Number.isFinite(action.durationSec) ? action.durationSec : null,
      addedBy: { memberId: from, name: (member && member.name) || action.addedByName || "Guest" },
      addedAt: Date.now(),
      votes,
      score: 1,
    });
    next.queue = rankQueue(next.queue);
    return { room: next };
  }

  if (type === "vote") {
    const track = findTrack(next, action.trackId);
    if (!track) return { room, error: "Track not in queue" };
    const cur = track.votes[from] || 0;
    const want = action.value === 1 || action.value === -1 ? action.value : 0;
    if (want === cur) delete track.votes[from];
    else if (want === 0) delete track.votes[from];
    else track.votes[from] = want;
    track.score = scoreOf(track.votes);
    next.queue = rankQueue(next.queue);
    return { room: next };
  }

  if (type === "remove") {
    const track = findTrack(next, action.trackId);
    if (!track) return { room, error: "Track not in queue" };
    if (!isHost && track.addedBy.memberId !== from) {
      return { room, error: "You can only remove your own songs" };
    }
    next.queue = next.queue.filter((t) => t.id !== action.trackId);
    return { room: next };
  }

  if (type === "lock") {
    if (!isHost) return { room, error: "Host only" };
    next.locked = !!action.locked;
    return { room: next };
  }

  if (type === "pause") {
    if (!isHost) return { room, error: "Host only" };
    next.paused = !!action.paused;
    return { room: next };
  }

  if (type === "skip" || type === "ended" || type === "error") {
    if (!isHost) return { room, error: "Host only" };
    takeNext(next);
    return { room: next };
  }

  if (type === "start") {
    if (!isHost) return { room, error: "Host only" };
    if (!next.nowPlaying) takeNext(next);
    next.paused = false;
    return { room: next };
  }

  if (type === "retitle") {
    if (!isHost) return { room, error: "Host only" };
    const target =
      (next.nowPlaying && next.nowPlaying.videoId === action.videoId && next.nowPlaying) ||
      next.queue.find((t) => t.videoId === action.videoId);
    if (target && action.title) target.title = String(action.title).slice(0, 200);
    if (target && action.channelTitle) target.channelTitle = String(action.channelTitle).slice(0, 120);
    return { room: next };
  }

  return { room, error: "Unknown action" };
}

export function memberName(room, memberId) {
  const m = room.members.find((x) => x.id === memberId);
  return (m && m.name) || "Guest";
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}
