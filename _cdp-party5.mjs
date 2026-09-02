/**
 * 5 headed Chrome windows: 1 host + 4 guests. Gitignored.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP = process.env.NEXTUP_URL || "https://raman20.github.io/nextup/";
const SHOTS = path.join(root, "_shots");
fs.mkdirSync(SHOTS, { recursive: true });

const PEOPLE = [
  { name: "Host", role: "host" },
  { name: "Alex", role: "guest", video: "https://www.youtube.com/watch?v=jNQXAC9IVRw" }, // Me at the zoo
  { name: "Blair", role: "guest", video: "https://www.youtube.com/watch?v=dQw4w9wgXcQ" }, // Rickroll
  { name: "Chen", role: "guest", video: "https://www.youtube.com/watch?v=9bZkp7q19f0" }, // Gangnam
  { name: "Dee", role: "guest", video: "https://www.youtube.com/watch?v=kJQP7kiw5Fk" }, // Despacito
];

const LAYOUT = [
  { x: 20, y: 20 },
  { x: 370, y: 20 },
  { x: 720, y: 20 },
  { x: 20, y: 430 },
  { x: 370, y: 430 },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitJson(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("CDP not ready: " + url);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const t = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
        this.console.push((msg.params.type || "log") + ": " + t);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout " + method));
      }, 25000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }
}

async function connectBrowser(port) {
  const ver = await waitJson(`http://127.0.0.1:${port}/json/version`);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("ws " + port));
  });
  return new Cdp(ws);
}

async function attachPage(browser, url) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => browser.send(method, params, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Network.enable");
  await s("Network.setCacheDisabled", { cacheDisabled: true });
  await s("Page.navigate", { url });
  await sleep(1600);
  return { s, sessionId };
}

async function evalExpr(s, expression) {
  const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
  return r.result && r.result.value;
}

async function realClick(s, selector) {
  const box = await evalExpr(
    s,
    `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height };
    })()`
  );
  if (!box || !box.w) throw new Error("no click target " + selector);
  const { x, y } = box;
  await s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function shot(s, name) {
  const { data } = await s("Page.captureScreenshot", { format: "png" });
  const file = path.join(SHOTS, name + ".png");
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log("shot", name);
  return file;
}

function launchChrome(port, dir, x, y) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${dir}`,
      `--window-size=340,700`,
      `--window-position=${x},${y}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-features=Translate",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  return child;
}

const stateExpr = `({
  href: location.href,
  homeOn: document.getElementById('view-home')?.classList.contains('on'),
  roomOn: document.getElementById('view-room')?.classList.contains('on'),
  roomCode: document.getElementById('room-code')?.textContent?.trim(),
  banner: document.getElementById('banner')?.textContent,
  nowTitle: document.getElementById('now-title')?.textContent,
  nowKicker: document.getElementById('now-kicker')?.textContent,
  nowSub: document.getElementById('now-sub')?.textContent,
  queue: [...document.querySelectorAll('.q-item')].map(el => ({
    title: el.querySelector('.title')?.textContent,
    sub: el.querySelector('.sub')?.textContent,
    score: el.querySelector('.score')?.textContent,
  })),
  queueCount: document.querySelectorAll('.q-item').length,
  overlayGone: document.getElementById('start-overlay')?.classList.contains('gone'),
  playerOn: document.getElementById('player-wrap')?.classList.contains('on'),
  iframe: !!document.querySelector('.stage iframe'),
  lockVisible: !!(document.getElementById('btn-lock') && document.getElementById('btn-lock').offsetParent),
})`;

function launchAll() {
  const clients = [];
  for (let i = 0; i < 5; i++) {
    const port = 9701 + i;
    const dir = path.join(root, `.chrome-p5-${i}`);
    launchChrome(port, dir, LAYOUT[i].x, LAYOUT[i].y);
    clients.push({ ...PEOPLE[i], port, dir, i });
  }
  return clients;
}

async function pasteVideo(s, url) {
  await evalExpr(
    s,
    `(function(){
      const el = document.getElementById('search');
      el.value = ${JSON.stringify(url)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return el.value;
    })()`
  );
}

async function upvoteTitle(s, needle) {
  return evalExpr(
    s,
    `(function(){
      const items = [...document.querySelectorAll('.q-item')];
      const hit = items.find(el => (el.querySelector('.title')?.textContent || '').toLowerCase().includes(${JSON.stringify(needle.toLowerCase())}));
      if (!hit) return 'missing';
      hit.querySelector('.votes button')?.click();
      return hit.querySelector('.title')?.textContent;
    })()`
  );
}

async function main() {
  console.log("5-client party on", APP);
  const meta = launchAll();
  const browsers = [];
  for (const c of meta) browsers.push(await connectBrowser(c.port));
  const pages = [];
  for (const b of browsers) pages.push(await attachPage(b, APP));
  await sleep(800);

  const host = pages[0];
  await evalExpr(
    host.s,
    `(function(){
      const n = document.getElementById('nick');
      n.value = 'Host';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-create').click();
      return 'create';
    })()`
  );
  await sleep(7000);
  let hostState = await evalExpr(host.s, stateExpr);
  console.log("HOST room", hostState.roomCode, hostState.banner, hostState.roomOn);
  await shot(host.s, "p5-01-host");
  const code = (hostState.roomCode || "").trim();
  if (!code || code === "------") throw new Error("host did not create a room");

  for (let i = 1; i < 5; i++) {
    const name = PEOPLE[i].name;
    await evalExpr(
      pages[i].s,
      `(function(){
        const n = document.getElementById('nick');
        n.value = ${JSON.stringify(name)};
        n.dispatchEvent(new Event('input', { bubbles: true }));
        const c = document.getElementById('join-code');
        c.value = ${JSON.stringify(code)};
        c.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-join').click();
        return 'join';
      })()`
    );
    await sleep(2500);
  }
  await sleep(3000);

  const afterJoin = [];
  for (let i = 0; i < 5; i++) {
    const st = await evalExpr(pages[i].s, stateExpr);
    afterJoin.push(st);
    console.log(`JOIN ${PEOPLE[i].name}`, { roomOn: st.roomOn, code: st.roomCode, lock: st.lockVisible, here: st.nowSub });
    await shot(pages[i].s, `p5-02-join-${PEOPLE[i].name}`);
  }

  for (let i = 1; i < 5; i++) {
    await pasteVideo(pages[i].s, PEOPLE[i].video);
    await sleep(2800);
  }
  await sleep(2500);

  const afterAdd = [];
  for (let i = 0; i < 5; i++) {
    const st = await evalExpr(pages[i].s, stateExpr);
    afterAdd.push(st);
    console.log(`QUEUE ${PEOPLE[i].name}`, st.queueCount, st.queue.map((q) => q.score + " " + q.title).join(" | "));
    await shot(pages[i].s, `p5-03-queue-${PEOPLE[i].name}`);
  }

  // Crowd votes: everyone except Alex upvotes Alex's zoo video so it jumps to #1
  for (const i of [2, 3, 4, 0]) {
    const r = await upvoteTitle(pages[i].s, "zoo");
    console.log(`VOTE ${PEOPLE[i].name} ->`, r);
    await sleep(1200);
  }
  await sleep(2000);

  const afterVote = await evalExpr(host.s, stateExpr);
  console.log("HOST queue after votes", afterVote.queue);
  await shot(host.s, "p5-04-host-voted");
  await shot(pages[1].s, "p5-04-alex-voted");

  await realClick(host.s, "#btn-start");
  await sleep(3000);
  let afterStart = await evalExpr(host.s, stateExpr);
  if (!afterStart.overlayGone) {
    await realClick(host.s, "#btn-start");
    await sleep(2500);
    afterStart = await evalExpr(host.s, stateExpr);
  }

  const playing = [];
  for (let i = 0; i < 5; i++) {
    const st = await evalExpr(pages[i].s, stateExpr);
    playing.push(st);
    console.log(`PLAY ${PEOPLE[i].name}`, { kicker: st.nowKicker, title: st.nowTitle, iframe: st.iframe, overlayGone: st.overlayGone });
    await shot(pages[i].s, `p5-05-play-${PEOPLE[i].name}`);
  }

  await realClick(host.s, "#btn-skip");
  await sleep(2500);
  const afterSkip = await evalExpr(host.s, stateExpr);
  console.log("SKIP now", afterSkip.nowTitle, "queue", afterSkip.queue.map((q) => q.title));
  await shot(host.s, "p5-06-host-skip");
  await shot(pages[2].s, "p5-06-blair-skip");

  const joinOk = afterJoin.every((s) => s.roomOn && s.roomCode === code);
  const guestsNoPlayer = afterJoin.slice(1).every((s) => s.lockVisible === false && s.playerOn === false);
  const hostHasPlayer = afterJoin[0].lockVisible === true;
  const queueCounts = afterAdd.map((s) => s.queueCount);
  const queueSynced = queueCounts.every((n) => n === queueCounts[0] && n >= 4);
  const titles = afterAdd[0].queue.map((q) => q.title);
  const allSeeSame = afterAdd.every((s) => s.queue.map((q) => q.title).join("|") === titles.join("|"));
  const nowTitles = playing.map((s) => s.nowTitle);
  const nowSynced = nowTitles.every((t) => t && t === nowTitles[0] && t !== "Queue a song to begin");
  const onlyHostIframe = playing[0].iframe === true && playing.slice(1).every((s) => s.iframe === false);
  const hostPlaying = playing[0].nowKicker === "NOW PLAYING" && playing[0].overlayGone === true;

  const report = {
    room: code,
    joinOk,
    guestsNoPlayer,
    hostHasPlayer,
    queueCounts,
    queueSynced,
    allSeeSame,
    titles,
    votedTop: afterVote.queue[0] && afterVote.queue[0].title,
    votedTopScore: afterVote.queue[0] && afterVote.queue[0].score,
    nowSynced,
    nowTitle: nowTitles[0],
    onlyHostIframe,
    hostPlaying,
    afterSkip: afterSkip.nowTitle,
  };
  console.log("REPORT", JSON.stringify(report, null, 2));
  const ok = joinOk && guestsNoPlayer && hostHasPlayer && queueSynced && allSeeSame && nowSynced && onlyHostIframe && hostPlaying;
  console.log("RESULT", ok ? "PASS 5-client party" : "INCOMPLETE");
  process.exit(ok ? 0 : 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
