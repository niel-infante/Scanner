// Thin wrapper around zxing-wasm (zxing-cpp) tuned for laser-etched,
// white-on-black Data Matrix codes on tube bottoms.
// Pure JS + wasm: runs in the browser and in Node (see test/decode-sample.mjs).

import { prepareZXingModule, readBarcodes } from "./vendor/zxing-wasm/es/reader/index.js";

const WASM_URL = new URL("./vendor/zxing-wasm/reader/zxing_reader.wasm", import.meta.url);

const READER_OPTIONS = {
  formats: ["DataMatrix"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true, // tube codes are light-on-dark
  tryDownscale: true,
  maxNumberOfSymbols: 255,
};

// zxing misses most codes in small images (< ~600px) even when they are sharp.
// Centring the crop on a larger flat-grey canvas fixes it (≈95% vs ≈40% on the
// sample rack), so every crop is padded up to this size before decoding.
const MIN_DECODE_SIZE = 800;
const PAD_GREY = 128;

let ready = null;

// Load the wasm module. Pass `wasmBinary` (ArrayBuffer) where the .wasm file
// can't be fetched by URL, e.g. Node.
export function initDecoder({ wasmBinary } = {}) {
  if (!ready) {
    const overrides = wasmBinary
      ? { wasmBinary }
      : { locateFile: (path, prefix) => (path.endsWith(".wasm") ? WASM_URL.href : prefix + path) };
    ready = prepareZXingModule({ overrides, fireImmediately: true });
  }
  return ready;
}

function centerOf(position) {
  const { topLeft, topRight, bottomLeft, bottomRight } = position;
  return {
    x: (topLeft.x + topRight.x + bottomLeft.x + bottomRight.x) / 4,
    y: (topLeft.y + topRight.y + bottomLeft.y + bottomRight.y) / 4,
  };
}

// Decode every Data Matrix in `input` (RGBA {data, width, height}, image Blob or bytes).
// Returns [{ text, center: {x, y}, position }], deduplicated by text.
export async function decodeAll(input) {
  await initDecoder();
  const results = await readBarcodes(input, READER_OPTIONS);
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r.isValid || seen.has(r.text)) continue;
    seen.add(r.text);
    out.push({ text: r.text, center: centerOf(r.position), position: r.position });
  }
  return out;
}

// Pick the code whose centre is closest to `target` ({x, y} in image pixels).
export function nearestTo(codes, target) {
  let best = null;
  let bestDist = Infinity;
  for (const c of codes) {
    const d = Math.hypot(c.center.x - target.x, c.center.y - target.y);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

// Centre `img` on a grey canvas at least MIN_DECODE_SIZE square.
function padToMinSize(img) {
  const width = Math.max(img.width, MIN_DECODE_SIZE);
  const height = Math.max(img.height, MIN_DECODE_SIZE);
  if (width === img.width && height === img.height) return img;
  const data = new Uint8ClampedArray(width * height * 4).fill(PAD_GREY);
  const x0 = (width - img.width) >> 1;
  const y0 = (height - img.height) >> 1;
  const rowBytes = img.width * 4;
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * rowBytes, (y + 1) * rowBytes), ((y0 + y) * width + x0) * 4);
  }
  return { data, width, height };
}

// Stretch grey levels to the full 0–255 range. Helps faint or low-contrast etching.
function stretchContrast(img) {
  const { data, width, height } = img;
  const grey = new Uint8ClampedArray(width * height);
  let min = 255;
  let max = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    grey[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const scale = max > min ? 255 / (max - min) : 1;
  const out = new Uint8ClampedArray(data.length);
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) {
    out[i] = out[i + 1] = out[i + 2] = (grey[p] - min) * scale;
    out[i + 3] = 255;
  }
  return { data: out, width, height };
}

// Decode the single tube nearest the centre of `img` (RGBA {data, width, height},
// e.g. canvas ImageData). Returns { text, center, position } or null.
export async function decodeTube(img) {
  for (const attempt of [img, stretchContrast(img)]) {
    const padded = padToMinSize(attempt);
    const codes = await decodeAll(padded);
    if (codes.length) return nearestTo(codes, { x: padded.width / 2, y: padded.height / 2 });
  }
  return null;
}
