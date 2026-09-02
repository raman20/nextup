/** Byte-mode QR, ECC M, versions 1–10. Renders to a canvas. */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
function gfMul(a, b) {
  if (!a || !b) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// ECC M: [dataCodewords, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const SPEC = [
  null,
  [16, 10, 1, 16, 0, 0],
  [28, 16, 1, 28, 0, 0],
  [44, 26, 1, 44, 0, 0],
  [64, 18, 2, 32, 0, 0],
  [86, 24, 2, 43, 0, 0],
  [108, 16, 4, 27, 0, 0],
  [124, 18, 4, 31, 0, 0],
  [154, 22, 2, 38, 2, 39],
  [182, 22, 3, 36, 2, 37],
  [216, 26, 4, 43, 1, 44],
];
const REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
const ALIGN = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
const VERSION_BITS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

function rsGen(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j];
      ng[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = ng;
  }
  return g;
}

function rsEncode(data, nsym) {
  const gen = rsGen(nsym);
  const res = data.concat(new Array(nsym).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (!coef) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
  }
  return res.slice(data.length);
}

function bitsToBytes(bits) {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] || 0);
    bytes.push(v);
  }
  return bytes;
}

function encodeData(text, version) {
  const data = new TextEncoder().encode(text);
  const spec = SPEC[version];
  const cap = spec[0];
  const bits = [];
  const push = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, version >= 10 ? 16 : 8);
  for (const b of data) push(b, 8);
  const maxBits = cap * 8;
  const term = Math.min(4, maxBits - bits.length);
  push(0, term);
  while (bits.length % 8) bits.push(0);
  const bytes = bitsToBytes(bits);
  const pads = [0xec, 0x11];
  let p = 0;
  while (bytes.length < cap) bytes.push(pads[p++ % 2]);
  return bytes.slice(0, cap);
}

function interleave(data, version) {
  const [, ecPer, g1b, g1d, g2b, g2d] = SPEC[version];
  const blocks = [];
  let o = 0;
  for (let i = 0; i < g1b; i++) {
    const d = data.slice(o, o + g1d);
    o += g1d;
    blocks.push({ d, e: rsEncode(d, ecPer) });
  }
  for (let i = 0; i < g2b; i++) {
    const d = data.slice(o, o + g2d);
    o += g2d;
    blocks.push({ d, e: rsEncode(d, ecPer) });
  }
  const out = [];
  const maxD = Math.max(g1d, g2d);
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecPer; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

function sizeOf(v) {
  return 21 + 4 * (v - 1);
}

function isFunction(fun, x, y, n) {
  return fun[y * n + x] === 1;
}

function placeFinders(mod, fun, n) {
  const draw = (ox, oy) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const xx = ox + x;
        const yy = oy + y;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const inFinder = x >= 0 && x <= 6 && y >= 0 && y <= 6;
        const sep = x === -1 || y === -1 || x === 7 || y === 7;
        if (!inFinder && !sep) continue;
        fun[yy * n + xx] = 1;
        if (inFinder) {
          const on = x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
          mod[yy * n + xx] = on ? 1 : 0;
        } else {
          mod[yy * n + xx] = 0;
        }
      }
    }
  };
  draw(0, 0);
  draw(n - 7, 0);
  draw(0, n - 7);
}

function placeTiming(mod, fun, n) {
  for (let i = 8; i < n - 8; i++) {
    fun[6 * n + i] = 1;
    fun[i * n + 6] = 1;
    mod[6 * n + i] = i % 2 === 0 ? 1 : 0;
    mod[i * n + 6] = i % 2 === 0 ? 1 : 0;
  }
}

function placeAlign(mod, fun, n, version) {
  const pos = ALIGN[version];
  for (const a of pos) {
    for (const b of pos) {
      if ((a === 6 && b === 6) || (a === 6 && b === n - 7) || (a === n - 7 && b === 6)) continue;
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          const xx = a + x;
          const yy = b + y;
          fun[yy * n + xx] = 1;
          const on = Math.max(Math.abs(x), Math.abs(y)) !== 1;
          mod[yy * n + xx] = on ? 1 : 0;
        }
      }
    }
  }
}

function placeDark(mod, fun, n) {
  fun[(n - 8) * n + 8] = 1;
  mod[(n - 8) * n + 8] = 1;
}

function reserveFormat(fun, n) {
  for (let i = 0; i < 9; i++) {
    fun[8 * n + i] = 1;
    fun[i * n + 8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    fun[8 * n + (n - 1 - i)] = 1;
    fun[(n - 1 - i) * n + 8] = 1;
  }
}

function placeVersion(mod, fun, n, version) {
  const bits = VERSION_BITS[version];
  if (!bits) return;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const a = Math.floor(i / 3);
    const b = i % 3;
    fun[(n - 11 + b) * n + a] = 1;
    fun[a * n + (n - 11 + b)] = 1;
    mod[(n - 11 + b) * n + a] = bit;
    mod[a * n + (n - 11 + b)] = bit;
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function placeData(mod, fun, n, bytes, remainder, mask) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  for (let i = 0; i < remainder; i++) bits.push(0);
  let k = 0;
  let dir = -1;
  let y = n - 1;
  for (let x = n - 1; x > 0; x -= 2) {
    if (x === 6) x--;
    for (;;) {
      for (let dx = 0; dx < 2; dx++) {
        const xx = x - dx;
        if (!isFunction(fun, xx, y, n)) {
          let bit = bits[k++] || 0;
          if (maskBit(mask, xx, y)) bit ^= 1;
          mod[y * n + xx] = bit;
        }
      }
      y += dir;
      if (y < 0 || y >= n) {
        y -= dir;
        dir = -dir;
        break;
      }
    }
  }
}

function placeFormat(mod, n, mask) {
  const bits = FORMAT_M[mask];
  const coordsA = [
    [0, 8],
    [1, 8],
    [2, 8],
    [3, 8],
    [4, 8],
    [5, 8],
    [7, 8],
    [8, 8],
  ];
  const coordsB = [
    [8, 7],
    [8, 5],
    [8, 4],
    [8, 3],
    [8, 2],
    [8, 1],
    [8, 0],
  ];
  for (let i = 0; i < 8; i++) {
    const bit = (bits >> (14 - i)) & 1;
    mod[coordsA[i][1] * n + coordsA[i][0]] = bit;
    // copy to other: right of TL timing on the right finder
    mod[8 * n + (n - 1 - i)] = bit;
  }
  for (let i = 0; i < 7; i++) {
    const bit = (bits >> (6 - i)) & 1;
    mod[coordsB[i][1] * n + coordsB[i][0]] = bit;
    mod[(n - 7 + i) * n + 8] = bit;
  }
}

function penalty(mod, n) {
  let p = 0;
  for (let y = 0; y < n; y++) {
    let run = 1;
    for (let x = 1; x < n; x++) {
      if (mod[y * n + x] === mod[y * n + x - 1]) run++;
      else {
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  for (let x = 0; x < n; x++) {
    let run = 1;
    for (let y = 1; y < n; y++) {
      if (mod[y * n + x] === mod[(y - 1) * n + x]) run++;
      else {
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = mod[y * n + x];
      if (v === mod[y * n + x + 1] && v === mod[(y + 1) * n + x] && v === mod[(y + 1) * n + x + 1]) p += 3;
    }
  }
  const finder = [1, 0, 1, 1, 1, 0, 1];
  const scan = (get, len) => {
    for (let i = 0; i <= len - 7; i++) {
      let ok = true;
      for (let j = 0; j < 7; j++) if (get(i + j) !== finder[j]) ok = false;
      if (!ok) continue;
      const left = i >= 4 && get(i - 1) === 0 && get(i - 2) === 0 && get(i - 3) === 0 && get(i - 4) === 0;
      const right = i + 10 < len && get(i + 7) === 0 && get(i + 8) === 0 && get(i + 9) === 0 && get(i + 10) === 0;
      if (left || right) p += 40;
    }
  };
  for (let y = 0; y < n; y++) scan((x) => mod[y * n + x], n);
  for (let x = 0; x < n; x++) scan((y) => mod[y * n + x], n);
  let dark = 0;
  for (let i = 0; i < n * n; i++) dark += mod[i];
  p += Math.abs(Math.floor((dark * 100) / (n * n) / 5) * 5 - 50) / 5 * 10;
  return p;
}

function build(text, version, mask) {
  const n = sizeOf(version);
  const mod = new Uint8Array(n * n);
  const fun = new Uint8Array(n * n);
  placeFinders(mod, fun, n);
  placeTiming(mod, fun, n);
  placeAlign(mod, fun, n, version);
  placeDark(mod, fun, n);
  reserveFormat(fun, n);
  if (version >= 7) {
    for (let a = 0; a < 6; a++) for (let b = 0; b < 3; b++) {
      fun[(n - 11 + b) * n + a] = 1;
      fun[a * n + (n - 11 + b)] = 1;
    }
  }
  const data = encodeData(text, version);
  const bytes = interleave(data, version);
  placeData(mod, fun, n, bytes, REMAINDER[version], mask);
  placeFormat(mod, n, mask);
  if (version >= 7) placeVersion(mod, fun, n, version);
  return { mod, n };
}

function chooseVersion(text) {
  const len = new TextEncoder().encode(text).length;
  for (let v = 1; v <= 10; v++) {
    const cap = SPEC[v][0];
    const countBits = v >= 10 ? 16 : 8;
    const need = Math.ceil((4 + countBits + len * 8 + 4) / 8);
    if (need <= cap) return v;
  }
  throw new Error("QR too long");
}

export function drawQr(canvas, text) {
  const version = chooseVersion(text);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const built = build(text, version, mask);
    const s = penalty(built.mod, built.n);
    if (s < bestScore) {
      bestScore = s;
      best = built;
    }
  }
  const { mod, n } = best;
  const quiet = 4;
  const scale = Math.max(4, Math.floor(280 / (n + quiet * 2)));
  const dim = (n + quiet * 2) * scale;
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = "#111";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (mod[y * n + x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
}
