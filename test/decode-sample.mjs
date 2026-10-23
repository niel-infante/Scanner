// Regression check for the decoder against the sample rack photo.
// Run: node test/decode-sample.mjs
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { initDecoder, decodeAll, decodeTube } from "../decoder.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

await initDecoder({ wasmBinary: (await readFile(here("../vendor/zxing-wasm/reader/zxing_reader.wasm"))).buffer });

// Whole rack: most of the 96 tubes should decode from a single phone photo.
const rack = new Blob([await readFile(here("../IMG_7767.jpg"))]);
let t = performance.now();
const all = await decodeAll(rack);
check(all.length >= 85, `full rack photo: ${all.length}/96 decoded in ${Math.round(performance.now() - t)} ms`);
check(all.every((c) => /^\d{10}$/.test(c.text)), "all values are 10-digit tube IDs");

// Single-tube crops, as the live viewfinder produces them. Some include the
// edges of neighbouring tubes; the centre tube must win.
const dir = here("./fixtures/");
for (const name of (await readdir(dir)).filter((f) => f.endsWith(".pgm"))) {
  const expected = name.match(/tube-(\d+)\.pgm/)[1];
  const img = readPgm(await readFile(dir + name));
  t = performance.now();
  const hit = await decodeTube(img);
  const ms = Math.round(performance.now() - t);
  check(hit?.text === expected, `${name} (${img.width}px): got ${hit?.text ?? "nothing"} in ${ms} ms`);
}

// Binary greyscale PGM (P5, as written by OpenCV) -> RGBA {data, width, height}.
function readPgm(buf) {
  const header = buf.subarray(0, 64).toString("latin1").match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  const [, w, h] = header.map(Number);
  const pixels = buf.subarray(header[0].length);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = pixels[p];
    data[p * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

process.exit(failed ? 1 : 0);
