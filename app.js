import { initDecoder, decodeTube } from "./decoder.js";

const SCAN_INTERVAL_MS = 120;
// Decode a little more than the on-screen box so a slightly off-centre tube
// still reads; decodeTube picks the code nearest the centre.
const CROP_MARGIN = 1.25;
const HISTORY_KEY = "tube-scan-history";
const CAMERA_KEY = "tube-scan-camera";
const HISTORY_MAX = 200;

const $ = (id) => document.getElementById(id);
const viewer = $("viewer");
const video = $("video");
const reticle = $("reticle");
const statusEl = $("status");
const startBtn = $("start");
const zoomWrap = $("zoom-wrap");
const zoomInput = $("zoom");
const zoomVal = $("zoom-val");
const focusWrap = $("focus-wrap");
const focusInput = $("focus");
const focusAutoBtn = $("focus-auto");
const cameraSelect = $("camera");
const infoEl = $("info");
const torchBtn = $("torch");
const snapInput = $("snap");
const resultSheet = $("result");
const resultText = $("result-text");
const resultLabel = $("result-label");
const resultNote = $("result-note");
const historySheet = $("history");
const historyList = $("history-list");

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let track = null;
let scanning = false;
let busy = false;
let timer = null;
let audio = null;
let focusCaps = {};
let history = loadHistory();
// After "Scan next", the camera is usually still on the tube just read.
// Ignore that value until it has been out of view for SUPPRESS_CLEAR_MS
// (single failed frames are common, so one miss isn't enough).
const SUPPRESS_CLEAR_MS = 1500;
let suppressText = null;
let suppressSeenAt = 0;
// The live result on screen, and when its tube was last seen in the box.
// After STALE_MS without it, the result is dimmed as "not in view".
const STALE_MS = 700;
let liveText = null;
let liveSeenAt = 0;

const setStatus = (msg) => (statusEl.textContent = msg);

// ---------- camera ----------

function savedCameraId() {
  try {
    return localStorage.getItem(CAMERA_KEY);
  } catch {
    return null;
  }
}

function openStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
      // Ask high; the browser picks the nearest mode the camera supports.
      // More pixels per tube lets you hold the phone back (in focus) and still decode.
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
  });
}

async function startCamera(deviceId = savedCameraId()) {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera not available. The page must be opened over HTTPS.");
    return;
  }
  try {
    stream = await openStream(deviceId).catch((err) => {
      // A remembered camera may no longer exist; fall back to the default back camera.
      if (deviceId && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) return openStream(null);
      throw err;
    });
  } catch (err) {
    setStatus(`Camera blocked: ${err.message}. Allow camera access and reload, or use Snap photo.`);
    startBtn.hidden = false;
    return;
  }
  track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  await video.play().catch(() => {});
  startBtn.hidden = true;
  setupTrackControls();
  listCameras();
  resumeScanning();
}

// Phones often have several back cameras (wide, ultra-wide, tele, depth). Some
// can't focus close, so let the user choose; labels are only available after
// camera permission has been granted.
async function listCameras() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const current = track?.getSettings?.().deviceId;
  cameraSelect.replaceChildren(
    ...cams.map((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      opt.selected = cam.deviceId === current;
      return opt;
    }),
  );
  cameraSelect.hidden = cams.length < 2;
}

cameraSelect.addEventListener("change", () => {
  try {
    localStorage.setItem(CAMERA_KEY, cameraSelect.value);
  } catch {
    // not remembered; still switch for this session
  }
  startCamera(cameraSelect.value);
});

function showInfo() {
  if (!track) return (infoEl.textContent = "");
  const s = track.getSettings?.() ?? {};
  const parts = [track.label || "camera", `${video.videoWidth}×${video.videoHeight}`];
  if (s.focusMode) parts.push(`focus: ${s.focusMode}`);
  if (s.focusDistance != null) parts.push(`${Number(s.focusDistance).toFixed(2)} m`);
  infoEl.textContent = parts.join(" · ");
}

function stopCamera() {
  pauseScanning();
  stream?.getTracks().forEach((t) => t.stop());
  stream = track = null;
}

function setupTrackControls() {
  const caps = track.getCapabilities?.() ?? {};
  const settings = track.getSettings?.() ?? {};

  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoomInput.min = caps.zoom.min;
    zoomInput.max = Math.min(caps.zoom.max, 10);
    zoomInput.step = caps.zoom.step || 0.1;
    zoomInput.value = settings.zoom ?? caps.zoom.min;
    zoomVal.textContent = `${Number(zoomInput.value).toFixed(1)}×`;
    zoomWrap.hidden = false;
  } else {
    zoomWrap.hidden = true;
  }

  torchBtn.hidden = !caps.torch;
  torchBtn.setAttribute("aria-pressed", "false");

  // Focus controls are exposed by Chrome on Android; Safari doesn't expose them.
  focusCaps = caps;
  if (caps.focusDistance && caps.focusMode?.includes("manual")) {
    focusInput.min = caps.focusDistance.min;
    focusInput.max = caps.focusDistance.max;
    focusInput.step = caps.focusDistance.step || 0.01;
    focusInput.value = settings.focusDistance ?? caps.focusDistance.min;
    focusWrap.hidden = false;
  } else {
    focusWrap.hidden = true;
  }
  setAutoFocus();
  video.addEventListener("loadedmetadata", showInfo, { once: true });
  showInfo();
}

function setAutoFocus() {
  focusAutoBtn.setAttribute("aria-pressed", "true");
  if (focusCaps.focusMode?.includes("continuous")) {
    track?.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).then(showInfo, () => {});
  }
}

focusAutoBtn.addEventListener("click", setAutoFocus);

// Manual focus: drag until the dots on the tube are sharp.
focusInput.addEventListener("input", () => {
  focusAutoBtn.setAttribute("aria-pressed", "false");
  track
    ?.applyConstraints({ advanced: [{ focusMode: "manual", focusDistance: Number(focusInput.value) }] })
    .then(showInfo, () => {});
});

// Tap the picture to focus there.
video.addEventListener("click", (e) => {
  if (!track || !focusCaps.focusMode) return;
  const view = video.getBoundingClientRect();
  const scale = Math.max(view.width / video.videoWidth, view.height / video.videoHeight);
  const x = (video.videoWidth / 2 + (e.clientX - (view.left + view.width / 2)) / scale) / video.videoWidth;
  const y = (video.videoHeight / 2 + (e.clientY - (view.top + view.height / 2)) / scale) / video.videoHeight;
  const mode = focusCaps.focusMode.includes("single-shot") ? "single-shot" : "continuous";
  focusAutoBtn.setAttribute("aria-pressed", "true");
  track
    .applyConstraints({ advanced: [{ focusMode: mode, pointsOfInterest: [{ x, y }] }] })
    .then(showInfo, () => {});
});

zoomInput.addEventListener("input", () => {
  const zoom = Number(zoomInput.value);
  zoomVal.textContent = `${zoom.toFixed(1)}×`;
  track?.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
});

torchBtn.addEventListener("click", () => {
  const on = torchBtn.getAttribute("aria-pressed") !== "true";
  track
    ?.applyConstraints({ advanced: [{ torch: on }] })
    .then(() => torchBtn.setAttribute("aria-pressed", String(on)))
    .catch(() => {});
});

// ---------- live scanning ----------

function resumeScanning() {
  if (!track) return;
  scanning = true;
  viewer.classList.remove("found");
  setStatus("Aim the box at one tube");
  clearTimeout(timer);
  scanTick();
}

function pauseScanning() {
  scanning = false;
  clearTimeout(timer);
}

async function scanTick() {
  if (!scanning) return;
  if (!busy && video.readyState >= 2) {
    busy = true;
    try {
      const hit = await decodeTube(grabReticleRegion());
      const now = performance.now();
      if (!scanning) {
        // paused (photo, history) while this frame was decoding; drop it
      } else if (suppressText && hit?.text === suppressText) {
        suppressSeenAt = now;
        setStatus("Same tube as last read. Move to the next tube.");
      } else if (hit) {
        suppressText = null;
        if (hit.text === liveText) {
          liveSeenAt = now;
          setInView(true);
        } else {
          showResult(hit.text, "", { live: true });
        }
      } else if (liveText && now - liveSeenAt > STALE_MS) {
        setInView(false);
      } else if (suppressText && now - suppressSeenAt > SUPPRESS_CLEAR_MS) {
        suppressText = null;
        setStatus("Aim the box at one tube");
      }
    } catch (err) {
      console.error(err);
    } finally {
      busy = false;
    }
  }
  if (scanning) timer = setTimeout(scanTick, SCAN_INTERVAL_MS);
}

// Crop the part of the video frame under the on-screen reticle.
function grabReticleRegion() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const view = video.getBoundingClientRect();
  // object-fit: cover scales the frame by the larger ratio and centres it.
  const scale = Math.max(view.width / vw, view.height / vh);
  const box = reticle.getBoundingClientRect();
  const side = Math.min((box.width * CROP_MARGIN) / scale, vw, vh);
  const cx = vw / 2 + (box.left + box.width / 2 - (view.left + view.width / 2)) / scale;
  const cy = vh / 2 + (box.top + box.height / 2 - (view.top + view.height / 2)) / scale;
  const sx = Math.max(0, Math.min(vw - side, cx - side / 2));
  const sy = Math.max(0, Math.min(vh - side, cy - side / 2));
  const size = Math.round(side);
  canvas.width = canvas.height = size;
  ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

// ---------- snap photo (native camera, better close-up focus) ----------

snapInput.addEventListener("change", async () => {
  const file = snapInput.files?.[0];
  snapInput.value = "";
  if (!file) return;
  pauseScanning();
  setStatus("Reading photo…");
  try {
    const bitmap = await createImageBitmap(file);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const hit = await decodeTube(ctx.getImageData(0, 0, canvas.width, canvas.height));
    canvas.width = canvas.height = 1; // release the large buffer
    if (hit) {
      showResult(hit.text, "From photo · centre-most tube");
    } else {
      setStatus("No barcode found in photo. Fill the frame with one tube and try again.");
      setTimeout(resumeScanning, 2500);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Could not read photo: ${err.message}`);
    setTimeout(resumeScanning, 2500);
  }
});

// ---------- result ----------

// Live results keep scanning so the sheet always reflects the tube in the box:
// a different tube replaces the value, and losing the tube marks it stale.
// Photo results pause scanning, since they aren't about the live view.
function showResult(text, note, { live = false } = {}) {
  if (live) {
    liveText = text;
    liveSeenAt = performance.now();
  } else {
    pauseScanning();
    liveText = null;
  }
  resultText.textContent = text;
  resultNote.textContent = note;
  resultSheet.hidden = false;
  setInView(true);
  feedback();
  addToHistory(text);
}

function setInView(inView) {
  if (resultSheet.classList.contains("stale") === !inView && viewer.classList.contains("found") === inView) return;
  viewer.classList.toggle("found", inView);
  resultSheet.classList.toggle("stale", !inView);
  resultLabel.textContent = inView ? "Tube barcode" : "Last read · not in view";
  setStatus(inView ? "Read OK" : "Aim the box at one tube");
}

function feedback() {
  navigator.vibrate?.(80);
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = 1760;
  gain.gain.setValueAtTime(0.15, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.12);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = "Copied ✓";
      setTimeout(() => (button.textContent = label), 1200);
    }
    return true;
  } catch {
    setStatus("Copy failed. Long-press the number to copy it.");
    return false;
  }
}

$("copy").addEventListener("click", (e) => copyText(resultText.textContent, e.currentTarget));

$("next").addEventListener("click", () => {
  resultSheet.hidden = true;
  suppressText = resultText.textContent;
  suppressSeenAt = performance.now();
  liveText = null;
  if (track) resumeScanning();
  else setStatus("Tap Start camera, or use Snap photo");
});

// ---------- history (per-device, kept in localStorage) ----------

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // storage unavailable (private mode); history stays in memory
  }
}

function addToHistory(text) {
  history.unshift({ text, at: new Date().toISOString() });
  history = history.slice(0, HISTORY_MAX);
  saveHistory();
}

function renderHistory() {
  historyList.replaceChildren(
    ...history.map(({ text, at }) => {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = text;
      const time = document.createElement("time");
      time.dateTime = at;
      time.textContent = new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
      li.append(code, time);
      li.addEventListener("click", () => copyText(text, null).then((ok) => ok && setStatus(`Copied ${text}`)));
      return li;
    }),
  );
  if (!history.length) historyList.innerHTML = "<li>No reads yet.</li>";
}

$("history-btn").addEventListener("click", () => {
  pauseScanning();
  renderHistory();
  historySheet.hidden = false;
});

$("history-close").addEventListener("click", () => {
  historySheet.hidden = true;
  if (resultSheet.hidden) resumeScanning();
});

$("history-clear").addEventListener("click", () => {
  if (!confirm("Clear all scan history on this device?")) return;
  history = [];
  saveHistory();
  renderHistory();
});

// ---------- startup ----------

startBtn.addEventListener("click", () => {
  // Audio must be unlocked from a user gesture on iOS.
  try {
    audio ??= new AudioContext();
    audio.resume();
  } catch {
    audio = null;
  }
  startCamera();
});

// Release the camera when the app is backgrounded; resume when it returns.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (stream) {
      stopCamera();
      startBtn.dataset.resume = "1";
    }
  } else if (startBtn.dataset.resume) {
    delete startBtn.dataset.resume;
    startCamera();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
}

initDecoder()
  .then(() => setStatus("Tap Start camera, or use Snap photo"))
  .catch((err) => setStatus(`Decoder failed to load: ${err.message}`));
