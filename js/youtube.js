import { parseVideoId } from "./room.js";

const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

export function loadIframeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") prev();
      resolve();
    };
    if (!document.querySelector("script[src='https://www.youtube.com/iframe_api']")) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => reject(new Error("YouTube iframe API failed to load"));
      document.head.appendChild(s);
    }
    setTimeout(() => {
      if (window.YT && window.YT.Player) resolve();
    }, 4000);
  });
}

function parseIsoDuration(iso) {
  if (!iso) return null;
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

export async function lookupOEmbed(videoId) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + videoId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("oembed " + res.status);
  const j = await res.json();
  return {
    videoId,
    title: j.title || "YouTube video",
    thumbnail: j.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    channelTitle: j.author_name || "",
    durationSec: null,
  };
}

export async function searchYoutube(query, apiKey) {
  const q = String(query || "").trim();
  if (!q) return [];
  if (!apiKey) throw new Error("NO_KEY");
  const hit = searchCache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.items;

  const searchUrl =
    "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&q=" +
    encodeURIComponent(q) +
    "&key=" +
    encodeURIComponent(apiKey);
  const sRes = await fetch(searchUrl);
  const sJson = await sRes.json();
  if (!sRes.ok) {
    const reason = sJson.error && sJson.error.errors && sJson.error.errors[0] && sJson.error.errors[0].reason;
    throw new Error(reason === "quotaExceeded" ? "QUOTA" : sJson.error && sJson.error.message ? sJson.error.message : "search failed");
  }
  const ids = (sJson.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);
  if (!ids.length) {
    searchCache.set(q.toLowerCase(), { at: Date.now(), items: [] });
    return [];
  }

  const vUrl =
    "https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status,snippet&id=" +
    ids.join(",") +
    "&key=" +
    encodeURIComponent(apiKey);
  const vRes = await fetch(vUrl);
  const vJson = await vRes.json();
  const items = [];
  for (const v of vJson.items || []) {
    if (v.status && v.status.embeddable === false) continue;
    const durationSec = parseIsoDuration(v.contentDetails && v.contentDetails.duration);
    if (durationSec != null && durationSec < 60) continue;
    items.push({
      videoId: v.id,
      title: v.snippet.title,
      thumbnail: (v.snippet.thumbnails && (v.snippet.thumbnails.medium || v.snippet.thumbnails.default) || {}).url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      channelTitle: v.snippet.channelTitle,
      durationSec,
    });
  }
  searchCache.set(q.toLowerCase(), { at: Date.now(), items });
  return items;
}

export function createHostPlayer(elementId, handlers) {
  let player = null;
  let ready = false;
  let wantId = null;

  function fireEnded() {
    if (handlers.onEnded) handlers.onEnded();
  }

  const ytPlayer = new window.YT.Player(elementId, {
    width: "640",
    height: "360",
    playerVars: {
      rel: 0,
      playsinline: 1,
      origin: location.origin,
      modestbranding: 0,
    },
    events: {
      onReady() {
        ready = true;
        player = ytPlayer;
        if (handlers.onReady) handlers.onReady();
        if (wantId) {
          player.loadVideoById(wantId);
          wantId = null;
        }
      },
      onStateChange(e) {
        if (e.data === window.YT.PlayerState.ENDED) fireEnded();
        if (e.data === window.YT.PlayerState.PLAYING && handlers.onPlaying) {
          let data = {};
          try {
            data = player.getVideoData() || {};
          } catch {}
          handlers.onPlaying(data);
        }
      },
      onError(e) {
        const code = e.data;
        if (handlers.onError) handlers.onError(code);
      },
    },
  });

  return {
    load(videoId, autoplay) {
      if (!ready) {
        wantId = videoId;
        return;
      }
      if (autoplay) player.loadVideoById(videoId);
      else player.cueVideoById(videoId);
    },
    play() {
      if (player) player.playVideo();
    },
    pause() {
      if (player) player.pauseVideo();
    },
    getData() {
      try {
        return player ? player.getVideoData() : null;
      } catch {
        return null;
      }
    },
    destroy() {
      try {
        if (player) player.destroy();
      } catch {}
    },
  };
}

export { parseVideoId };
