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
  let wantPlay = false;

  function armIframe() {
    try {
      const iframe = player && player.getIframe && player.getIframe();
      if (!iframe) return;
      iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
      iframe.setAttribute("allowfullscreen", "true");
      iframe.setAttribute("playsinline", "true");
    } catch {}
  }

  function applyWanted() {
    if (!ready || !player || !wantId) return;
    const id = wantId;
    const play = wantPlay;
    wantId = null;
    wantPlay = false;
    if (play) {
      player.loadVideoById(id);
      try {
        player.unMute();
        player.playVideo();
      } catch {}
    } else {
      player.cueVideoById(id);
    }
  }

  const ytPlayer = new window.YT.Player(elementId, {
    width: "640",
    height: "360",
    host: "https://www.youtube.com",
    playerVars: {
      rel: 0,
      playsinline: 1,
      origin: location.origin,
      enablejsapi: 1,
      autoplay: 0,
      mute: 0,
      controls: 1,
      fs: 1,
    },
    events: {
      onReady() {
        ready = true;
        player = ytPlayer;
        armIframe();
        if (handlers.onReady) handlers.onReady();
        applyWanted();
      },
      onStateChange(e) {
        const YT = window.YT;
        if (e.data === YT.PlayerState.ENDED) {
          if (handlers.onEnded) handlers.onEnded();
        }
        if (e.data === YT.PlayerState.PLAYING && handlers.onPlaying) {
          let data = {};
          try {
            data = player.getVideoData() || {};
          } catch {}
          handlers.onPlaying(data);
        }
        if (e.data === YT.PlayerState.PAUSED && handlers.onPaused) handlers.onPaused();
      },
      onError(e) {
        if (handlers.onError) handlers.onError(e.data);
      },
    },
  });

  return {
    ready() {
      return ready;
    },
    load(videoId, autoplay) {
      wantId = videoId;
      wantPlay = !!autoplay;
      applyWanted();
    },
    play() {
      if (!player) return;
      try {
        player.unMute();
        player.playVideo();
      } catch {}
    },
    pause() {
      if (player) player.pauseVideo();
    },
    state() {
      try {
        return player ? player.getPlayerState() : null;
      } catch {
        return null;
      }
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
