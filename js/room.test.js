import {
  applyAction,
  createRoom,
  generateCode,
  isValidCode,
  parseVideoId,
  rankQueue,
  MAX_UNPLAYED,
} from "./room.js";

const results = [];

function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? "" : detail || "failed" });
  if (!cond) console.error("FAIL", name, detail);
  else console.log("ok", name);
}

function add(room, from, videoId, extra) {
  return applyAction(room, from, {
    type: "add",
    videoId,
    title: extra && extra.title ? extra.title : videoId,
    trackId: extra && extra.trackId,
  });
}

export function runRoomTests() {
  results.length = 0;

  const code = generateCode();
  assert("code length 6", code.length === 6);
  assert("code valid", isValidCode(code));
  assert("reject ambiguous O", !isValidCode("OOOOOO"));
  assert("reject 1/I", !isValidCode("111111") && !isValidCode("IIIIII"));

  assert("parse watch url", parseVideoId("https://www.youtube.com/watch?v=dQw4w9wgXcQ") === "dQw4w9wgXcQ");
  assert("parse youtu.be", parseVideoId("https://youtu.be/dQw4w9wgXcQ") === "dQw4w9wgXcQ");
  assert("parse shorts", parseVideoId("https://www.youtube.com/shorts/dQw4w9wgXcQ") === "dQw4w9wgXcQ");
  assert("parse embed", parseVideoId("https://www.youtube.com/embed/dQw4w9wgXcQ") === "dQw4w9wgXcQ");
  assert("parse raw id", parseVideoId("dQw4w9wgXcQ") === "dQw4w9wgXcQ");
  assert("reject junk", parseVideoId("https://example.com") === null);

  const host = "host1";
  const a = "alice";
  const b = "bob";
  let r = createRoom("ABCDE2", host, "Host");
  r = applyAction(r, a, { type: "hello", name: "Alice" }).room;
  r = applyAction(r, b, { type: "hello", name: "Bob" }).room;

  let res = add(r, a, "aaaaaaaaaaa", { trackId: "t1", title: "A1" });
  r = res.room;
  res = add(r, b, "bbbbbbbbbbb", { trackId: "t2", title: "B1" });
  r = res.room;
  assert("two tracks queued", r.queue.length === 2);
  assert("auto-upvote score 1", r.queue[0].score === 1);

  // Bob upvotes Alice's song → it should rank first (higher score)
  r = applyAction(r, b, { type: "vote", trackId: "t1", value: 1 }).room;
  assert("upvote reorders", r.queue[0].id === "t1" && r.queue[0].score === 2);

  // Tie-break: earlier added wins
  r = applyAction(r, b, { type: "vote", trackId: "t1", value: 1 }).room; // toggle off Bob's extra vote
  assert("toggle clears vote", r.queue.find((t) => t.id === "t1").score === 1);
  const ranked = rankQueue(r.queue);
  assert("tie keeps earlier first", ranked[0].id === "t1");

  // Duplicate
  res = add(r, a, "aaaaaaaaaaa");
  assert("duplicate rejected", !!res.error);

  // Cap
  r = add(r, a, "aaaaaaaaaa2", { trackId: "t3" }).room;
  r = add(r, a, "aaaaaaaaaa3", { trackId: "t4" }).room;
  res = add(r, a, "aaaaaaaaaa4");
  assert("cap at " + MAX_UNPLAYED, !!res.error && r.queue.filter((t) => t.addedBy.memberId === a).length === MAX_UNPLAYED);

  // Guest cannot remove someone else's
  res = applyAction(r, b, { type: "remove", trackId: "t3" });
  assert("guest cannot remove others", !!res.error);

  res = applyAction(r, a, { type: "remove", trackId: "t3" });
  assert("owner can remove own", !res.error && !res.room.queue.some((t) => t.id === "t3"));
  r = res.room;

  res = applyAction(r, host, { type: "remove", trackId: "t4" });
  assert("host can remove any", !res.error);
  r = res.room;

  res = applyAction(r, a, { type: "lock", locked: true });
  assert("guest cannot lock", !!res.error);
  r = applyAction(r, host, { type: "lock", locked: true }).room;
  res = add(r, b, "ccccccccccc");
  assert("locked rejects guest add", !!res.error);
  res = add(r, host, "ccccccccccc", { trackId: "tH" });
  assert("host can add while locked", !res.error);
  r = res.room;

  r = applyAction(r, host, { type: "start" }).room;
  assert("start takes highest voted", r.nowPlaying && r.nowPlaying.videoId);
  const playingId = r.nowPlaying.id;
  assert("playing leaves the queue", !r.queue.some((t) => t.id === playingId));

  r = applyAction(r, host, { type: "ended" }).room;
  assert("ended advances", r.nowPlaying && r.nowPlaying.id !== playingId);

  res = applyAction(r, a, { type: "skip" });
  assert("guest cannot skip", !!res.error);

  const n = results.filter((x) => !x.ok).length;
  return { passed: results.length - n, failed: n, results };
}

if (typeof window !== "undefined" && window.location.pathname.endsWith("test.html")) {
  const { passed, failed, results: rows } = runRoomTests();
  const el = document.getElementById("out");
  if (el) {
    el.textContent = rows.map((r) => `${r.ok ? "ok" : "FAIL"}  ${r.name}${r.detail ? " — " + r.detail : ""}`).join("\n") + `\n\n${passed} passed, ${failed} failed`;
  }
}
