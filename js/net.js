/**
 * Minimal MQTT 3.1.1 over WebSocket. No libraries.
 * Swap BROKERS if a public endpoint is down.
 */
export const BROKERS = [
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://test.mosquitto.org:8081",
];

const KEEP_ALIVE = 30;
const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function mqttStr(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function readStr(view, offset) {
  const len = (view[offset] << 8) | view[offset + 1];
  const s = dec.decode(view.subarray(offset + 2, offset + 2 + len));
  return { s, next: offset + 2 + len };
}

function encodeLen(n) {
  const bytes = [];
  do {
    let e = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) e |= 0x80;
    bytes.push(e);
  } while (n > 0);
  return bytes;
}

function packet(typeFlags, variable) {
  const len = encodeLen(variable.length);
  const out = new Uint8Array(1 + len.length + variable.length);
  out[0] = typeFlags;
  out.set(len, 1);
  out.set(variable, 1 + len.length);
  return out;
}

function connectPacket(clientId, will) {
  const proto = mqttStr("MQTT");
  const header = new Uint8Array(proto.length + 6);
  header.set(proto, 0);
  let i = proto.length;
  header[i++] = 4; // 3.1.1
  let flags = 0x02; // clean session
  if (will) flags |= 0x04 | (will.retain ? 0x20 : 0); // will + optional retain, QoS 0
  header[i++] = flags;
  header[i++] = (KEEP_ALIVE >> 8) & 0xff;
  header[i++] = KEEP_ALIVE & 0xff;
  const parts = [header, mqttStr(clientId)];
  if (will) {
    parts.push(mqttStr(will.topic));
    parts.push(mqttStr(will.payload));
  }
  return packet(0x10, concat(parts));
}

function subscribePacket(id, topic) {
  return packet(0x82, concat([new Uint8Array([id >> 8, id & 0xff]), mqttStr(topic), new Uint8Array([0])]));
}

function publishPacket(topic, payload, retain) {
  const body = concat([mqttStr(topic), enc.encode(payload)]);
  return packet(0x30 | (retain ? 1 : 0), body);
}

function pingPacket() {
  return new Uint8Array([0xc0, 0]);
}

function disconnectPacket() {
  return new Uint8Array([0xe0, 0]);
}

function parsePackets(buf) {
  const packets = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 1 >= buf.length) break;
    const typeFlags = buf[i];
    let mul = 1;
    let len = 0;
    let j = i + 1;
    for (;;) {
      if (j >= buf.length) return { packets, rest: buf.subarray(i) };
      const b = buf[j++];
      len += (b & 127) * mul;
      mul *= 128;
      if ((b & 128) === 0) break;
      if (mul > 128 * 128 * 128) break;
    }
    if (j + len > buf.length) return { packets, rest: buf.subarray(i) };
    packets.push({ typeFlags, payload: buf.subarray(j, j + len) });
    i = j + len;
  }
  return { packets, rest: new Uint8Array(0) };
}

function parsePublish(typeFlags, payload) {
  const qos = (typeFlags >> 1) & 0x03;
  const { s: topic, next } = readStr(payload, 0);
  let o = next;
  if (qos > 0) o += 2;
  return { topic, data: dec.decode(payload.subarray(o)) };
}

function openOnce(url, protocols) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error("timeout"));
    }, 5000);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        ws.close();
      } catch {}
      reject(new Error("socket error"));
    };
  });
}

async function openSocket(url) {
  const tries = [["mqtt"], undefined];
  let last = new Error("socket error");
  for (const proto of tries) {
    try {
      return await openOnce(url, proto);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * Connect to a room bus.
 * onMessage(topicTail, obj)
 * onStatus(text)
 * Returns { publish(tail, obj, retain), close() }
 */
export async function connectRoom({ code, memberId, isHost, onMessage, onStatus }) {
  const prefix = `nextup/${code}/`;
  const clientId = ("nu-" + memberId.replace(/-/g, "")).slice(0, 22);
  const will = isHost
    ? { topic: prefix + "host", payload: JSON.stringify({ memberId, online: false }), retain: true }
    : { topic: prefix + "bye", payload: JSON.stringify({ memberId }), retain: false };

  let ws = null;
  let pingTimer = null;
  let closed = false;
  let packetId = 1;
  let rest = new Uint8Array(0);
  let connected = false;

  function send(bytes) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
  }

  function handle(typeFlags, payload) {
    const type = typeFlags >> 4;
    if (type === 2) {
      // CONNACK
      const rc = payload.length >= 2 ? payload[1] : 1;
      if (rc !== 0) throw new Error("MQTT connack " + rc);
      connected = true;
      send(subscribePacket(packetId++ & 0xffff, prefix + "#"));
      return;
    }
    if (type === 3) {
      let pub;
      try {
        pub = parsePublish(typeFlags, payload);
      } catch {
        return;
      }
      if (!pub.topic.startsWith(prefix)) return;
      const tail = pub.topic.slice(prefix.length);
      let obj = null;
      try {
        obj = JSON.parse(pub.data);
      } catch {
        return;
      }
      onMessage(tail, obj);
      return;
    }
    if (type === 13) {
      // PINGRESP
    }
  }

  function onFrame(ev) {
    const chunk = new Uint8Array(ev.data);
    const buf = concat([rest, chunk]);
    const parsed = parsePackets(buf);
    rest = parsed.rest;
    for (const p of parsed.packets) {
      try {
        handle(p.typeFlags, p.payload);
      } catch (e) {
        onStatus("bus error: " + (e.message || e));
      }
    }
  }

  let lastError = null;
  for (const url of BROKERS) {
    if (closed) break;
    onStatus("connecting…");
    try {
      ws = await openSocket(url);
      rest = new Uint8Array(0);
      connected = false;
      let live = false;
      ws.onmessage = onFrame;
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        if (!closed && live) onStatus("disconnected");
      };
      send(connectPacket(clientId, will));
      const ok = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 6000);
        const prev = ws.onmessage;
        ws.onmessage = (ev) => {
          prev(ev);
          if (connected) {
            clearTimeout(t);
            resolve(true);
          }
        };
      });
      if (!ok) {
        try {
          ws.close();
        } catch {}
        lastError = new Error("no connack from " + url);
        continue;
      }
      live = true;
      pingTimer = setInterval(() => send(pingPacket()), (KEEP_ALIVE * 1000) / 2);
      onStatus("connected");
      return {
        broker: url,
        publish(tail, obj, retain) {
          send(publishPacket(prefix + tail, JSON.stringify(obj), !!retain));
        },
        close() {
          closed = true;
          if (pingTimer) clearInterval(pingTimer);
          try {
            send(disconnectPacket());
            ws.close();
          } catch {}
        },
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Could not reach a message bus");
}
