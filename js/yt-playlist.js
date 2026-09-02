/** YouTube playlist = the queue. Reactivity is etag polling. */

const BASE = "https://www.googleapis.com/youtube/v3";

export function parsePlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^PL[\w-]{10,}$/i.test(s)) return s;
  try {
    const u = new URL(s);
    const list = u.searchParams.get("list");
    if (list && /^PL[\w-]{10,}$/i.test(list)) return list;
  } catch {}
  const m = /list=(PL[\w-]{10,})/i.exec(s);
  return m ? m[1] : null;
}

export function playlistWatchUrl(id) {
  return "https://www.youtube.com/playlist?list=" + encodeURIComponent(id);
}

export function shortCode(id) {
  return String(id || "").replace(/^PL/i, "").slice(-6).toUpperCase();
}

async function yt(path, { token, method, body, etag } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body) headers["Content-Type"] = "application/json";
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(BASE + path, {
    method: method || "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 304) return { unchanged: true, etag };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((json.error && json.error.message) || "YouTube API " + res.status);
    err.status = res.status;
    err.reason = json.error && json.error.errors && json.error.errors[0] && json.error.errors[0].reason;
    throw err;
  }
  json.etag = res.headers.get("ETag") || json.etag;
  return json;
}

export async function myChannelId(token) {
  const j = await yt("/channels?part=id&mine=true", { token });
  return j.items && j.items[0] && j.items[0].id;
}

export async function createPlaylist(token, title) {
  return yt("/playlists?part=snippet,status", {
    token,
    method: "POST",
    body: {
      snippet: {
        title: title || "NextUp party",
        description: "NextUp live queue — add songs from the NextUp room or as a YouTube collaborator.",
      },
      status: { privacyStatus: "unlisted" },
    },
  });
}

export async function getPlaylist(token, playlistId) {
  const j = await yt("/playlists?part=snippet,status&id=" + encodeURIComponent(playlistId), { token });
  return j.items && j.items[0];
}

export function mapItem(it) {
  const sn = it.snippet || {};
  const thumb =
    (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default || sn.thumbnails.high)) || {};
  return {
    playlistItemId: it.id,
    videoId: sn.resourceId && sn.resourceId.videoId,
    title: sn.title || "YouTube video",
    thumbnail: thumb.url || "",
    channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle || "",
    addedBy: sn.channelTitle || "",
    position: sn.position || 0,
    addedAt: sn.publishedAt ? Date.parse(sn.publishedAt) : 0,
  };
}

export async function listItems(token, playlistId, etag) {
  const j = await yt(
    "/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=" + encodeURIComponent(playlistId),
    { token, etag }
  );
  if (j.unchanged) return j;
  const items = (j.items || []).map(mapItem).filter((x) => x.videoId && x.title !== "Deleted video" && x.title !== "Private video");
  items.sort((a, b) => a.position - b.position);
  return { items, etag: j.etag };
}

export async function insertVideo(token, playlistId, videoId) {
  return yt("/playlistItems?part=snippet", {
    token,
    method: "POST",
    body: {
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
      },
    },
  });
}

export async function deleteItem(token, playlistItemId) {
  await fetch(BASE + "/playlistItems?id=" + encodeURIComponent(playlistItemId), {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token },
  }).then(async (res) => {
    if (!res.ok && res.status !== 204) {
      const json = await res.json().catch(() => ({}));
      const err = new Error((json.error && json.error.message) || "delete failed");
      err.status = res.status;
      throw err;
    }
  });
}

export async function setPosition(token, item, position) {
  return yt("/playlistItems?part=snippet", {
    token,
    method: "PUT",
    body: {
      id: item.playlistItemId,
      snippet: {
        playlistId: item.playlistId || undefined,
        resourceId: { kind: "youtube#video", videoId: item.videoId },
        position,
      },
    },
  });
}

export async function bumpUp(token, playlistId, item, minPosition) {
  const pos = item.position;
  if (pos <= minPosition) return false;
  await yt("/playlistItems?part=snippet", {
    token,
    method: "PUT",
    body: {
      id: item.playlistItemId,
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId: item.videoId },
        position: pos - 1,
      },
    },
  });
  return true;
}

export async function bumpDown(token, playlistId, item) {
  await yt("/playlistItems?part=snippet", {
    token,
    method: "PUT",
    body: {
      id: item.playlistItemId,
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId: item.videoId },
        position: item.position + 1,
      },
    },
  });
}

export async function videoMeta(token, videoId) {
  const j = await yt("/videos?part=snippet,contentDetails,status&id=" + encodeURIComponent(videoId), { token });
  const v = j.items && j.items[0];
  if (!v) return null;
  const sn = v.snippet || {};
  const thumb = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default)) || {};
  return {
    videoId: v.id,
    title: sn.title,
    thumbnail: thumb.url,
    channelTitle: sn.channelTitle,
    embeddable: !v.status || v.status.embeddable !== false,
  };
}

export async function searchVideos(token, query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const s = await yt(
    "/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&q=" + encodeURIComponent(q),
    { token }
  );
  const ids = (s.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const v = await yt("/videos?part=snippet,contentDetails,status&id=" + ids.join(","), { token });
  return (v.items || [])
    .filter((it) => !it.status || it.status.embeddable !== false)
    .map((it) => {
      const sn = it.snippet || {};
      const thumb = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default)) || {};
      return {
        videoId: it.id,
        title: sn.title,
        thumbnail: thumb.url,
        channelTitle: sn.channelTitle,
      };
    });
}
