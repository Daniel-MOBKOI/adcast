/**
 * Mobile recording sessions — v4
 *
 * Three exported routers:
 *   apiRouter    → mounted at /api/mobile-sessions  (auth protected)
 *   recordRouter → mounted at /mobile-record        (public, serves the recording page)
 *   uploadRouter → mounted at /mobile-upload        (public, receives video upload)
 *
 * Crop approach: ffmpeg cropdetect finds the largest non-black region automatically.
 * Works on any phone/screen size — no coordinates or scale factor maths needed.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import ffmpegStatic  from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const execFileAsync = promisify(execFile);
const FFMPEG  = ffmpegStatic  || 'ffmpeg';
const FFPROBE = (ffprobeStatic && ffprobeStatic.path) || 'ffprobe';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = path.join(__dirname, '..', '..', 'mobile-sessions');
fs.mkdirSync(MOBILE_DIR, { recursive: true });

const TARGET_W = 1080;
const TARGET_H = 2184;
const SESSION_TTL_MS = 30 * 60 * 1000;

// ── Session store ──────────────────────────────────────────────────────────
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      if (session.clipPath) fs.rmSync(session.clipPath, { force: true });
      sessions.delete(token);
    }
  }
}, 10 * 60 * 1000);

// ── Multer ─────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: MOBILE_DIR,
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname || '.mp4')),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── cropdetect + crop + scale ──────────────────────────────────────────────
async function detectCrop(inputPath) {
  console.log('[mobile] Running cropdetect…');
  const { stderr } = await execFileAsync(FFMPEG, [
    '-i', inputPath,
    '-t', '5',
    '-vf', 'cropdetect=limit=24:round=2:skip=2',
    '-f', 'null', '-',
  ], { maxBuffer: 1 << 24 }).catch(e => ({ stderr: e.stderr || '' }));

  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) throw new Error('cropdetect found no crop region — ensure the mobile page has a black background');

  // Pick the most frequently detected crop value (most stable)
  const counts = {};
  for (const m of matches) {
    const key = m[0];
    counts[key] = (counts[key] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const [, w, h, x, y] = best.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
  const result = { w: parseInt(w, 10), h: parseInt(h, 10), x: parseInt(x, 10), y: parseInt(y, 10) };
  console.log(`[mobile] cropdetect: ${result.w}×${result.h} from (${result.x},${result.y})`);
  return result;
}

async function cropAndScale(inputPath, outputPath) {
  const crop = await detectCrop(inputPath);
  const cropW = crop.w % 2 === 0 ? crop.w : crop.w - 1;
  const cropH = crop.h % 2 === 0 ? crop.h : crop.h - 1;
  console.log(`[mobile] Cropping ${cropW}×${cropH} from (${crop.x},${crop.y}) → ${TARGET_W}×${TARGET_H}`);

  await execFileAsync(FFMPEG, [
    '-y', '-i', inputPath,
    '-vf', `crop=${cropW}:${cropH}:${crop.x}:${crop.y},scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=disable,setsar=1`,
    '-vsync', 'cfr', '-r', '30',
    '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-threads', '1',
    outputPath,
  ]);
  console.log(`[mobile] Crop done → ${path.basename(outputPath)}`);
}

// ── API router (auth protected) ────────────────────────────────────────────
export const apiRouter = express.Router();

// POST /api/mobile-sessions — desktop creates a session
apiRouter.post('/', (req, res) => {
  const { creativeId } = req.body;
  if (!creativeId) return res.status(400).json({ error: 'creativeId required' });
  const token = uuid();
  sessions.set(token, { creativeId, status: 'waiting', clipPath: null, createdAt: Date.now() });
  console.log(`[mobile] Session created: ${token} for creative: ${creativeId}`);
  res.json({ token });
});

// GET /api/mobile-sessions/:token/status — desktop polls
apiRouter.get('/:token/status', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ status: session.status, error: session.error || null });
});

// GET /api/mobile-sessions/:token/clip — desktop fetches processed clip
apiRouter.get('/:token/clip', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session)                   return res.status(404).json({ error: 'Session not found or expired' });
  if (session.status !== 'ready') return res.status(400).json({ error: 'Clip not ready yet' });
  if (!fs.existsSync(session.clipPath)) return res.status(404).json({ error: 'Clip file missing' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="mobile-recording.mp4"');
  fs.createReadStream(session.clipPath).pipe(res);
});

// ── Record router (public) — GET /mobile-record/:token ────────────────────
export const recordRouter = express.Router();

recordRouter.get('/:token', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) {
    return res.status(404).send(`<!DOCTYPE html><html><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>AdCast</title></head>
      <body style="display:flex;align-items:center;justify-content:center;height:100vh;
        margin:0;font-family:sans-serif;background:#000;color:#fff;">
        <p style="text-align:center;padding:24px">
          This link has expired.<br>Please generate a new QR code on desktop.
        </p></body></html>`);
  }

  const { creativeId } = session;
  const token = req.params.token;

  const celtraUrl = new URL(`https://preview-sandbox.celtra.com/preview/${creativeId}/frame`);
  celtraUrl.searchParams.set('rp.useFullWidth', '1');
  celtraUrl.searchParams.set('overrides.deviceInfo.deviceType', 'Phone');
  celtraUrl.searchParams.set('rp._useSnapping', '1');
  celtraUrl.searchParams.set('rp._snappingFraction', '0.5');
  celtraUrl.searchParams.set('rp.removeAdvertisementBars', '1');
  celtraUrl.searchParams.set('rp.standalonePreview', '1');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>AdCast — Record</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%;
      background: #000000;
      overflow: hidden;
    }

    /* Done button — top right, well above the ad box, never overlaps iframe */
    #done-btn {
      position: fixed;
      top: 10px; right: 16px;
      z-index: 100;
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 16px;
      padding: 5px 14px;
      font-family: -apple-system, sans-serif;
      font-size: 13px; font-weight: 500;
      color: rgba(255,255,255,0.8);
      cursor: pointer;
    }

    #corner-label {
      position: fixed;
      top: 14px; left: 16px;
      z-index: 100;
      font-family: -apple-system, sans-serif;
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: rgba(255,255,255,0.3);
      pointer-events: none;
    }

    /* Ad box: centred, 1080:2184 ratio, black padding all around.
       60px top/bottom clears browser chrome on most phones.
       cropdetect uses the pure black surround to find edges automatically. */
    #ad-box {
      position: fixed;
      top: 60px; bottom: 60px;
      left: 40px; right: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #ad-frame-wrap {
      aspect-ratio: 1080 / 2184;
      height: 100%;
      max-height: 100%;
      max-width: 100%;
      position: relative;
      overflow: hidden;
      background: #000000;
    }

    #ad-frame {
      position: absolute;
      inset: 0;
      width: 100%; height: 100%;
      border: none; display: block;
      pointer-events: auto;
      touch-action: auto;
    }

    /* Upload panel — slides up only after Done is tapped */
    #upload-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: rgba(10,10,10,0.97);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 28px 24px calc(28px + env(safe-area-inset-bottom));
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
      z-index: 200;
      border-radius: 20px 20px 0 0;
    }
    #upload-panel.visible { transform: translateY(0); }
    #upload-panel h2 {
      color: #fff; font-family: -apple-system, sans-serif;
      font-size: 18px; font-weight: 700; margin-bottom: 6px;
    }
    #upload-panel p {
      color: rgba(255,255,255,0.5); font-family: -apple-system, sans-serif;
      font-size: 13px; line-height: 1.5; margin-bottom: 20px;
    }
    .btn {
      display: block; width: 100%; padding: 15px;
      border-radius: 12px; border: none;
      font-family: -apple-system, sans-serif;
      font-size: 16px; font-weight: 600;
      cursor: pointer; margin-bottom: 10px;
    }
    .btn-primary  { background: #fff; color: #000; }
    .btn-primary:disabled { opacity: 0.5; }
    .btn-secondary { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
    #status {
      font-family: -apple-system, sans-serif; font-size: 13px;
      color: rgba(255,255,255,0.5); text-align: center;
      margin-top: 6px; min-height: 18px;
    }
  </style>
</head>
<body>
  <div id="corner-label">AdCast</div>
  <button id="done-btn" onclick="openPanel()">Done ↑</button>

  <div id="ad-box">
    <div id="ad-frame-wrap">
      <iframe
        id="ad-frame"
        src="${celtraUrl.toString()}"
        allow="camera; microphone; autoplay; fullscreen; accelerometer; gyroscope"
        allowfullscreen
        scrolling="no"
      ></iframe>
    </div>
  </div>

  <div id="upload-panel">
    <h2>Upload your recording</h2>
    <p>Stop your screen recording, save it to your gallery, then tap below to upload it to AdCast.</p>
    <input type="file" id="file-input" accept="video/*" style="display:none" onchange="handleFile(this)">
    <button class="btn btn-primary" id="upload-btn"
      onclick="document.getElementById('file-input').click()">
      Choose video from gallery
    </button>
    <button class="btn btn-secondary" onclick="closePanel()">Back to ad</button>
    <div id="status"></div>
  </div>

  <script>
    const UPLOAD_URL = '/mobile-upload/${token}';

    function openPanel()  { document.getElementById('upload-panel').classList.add('visible'); }
    function closePanel() { document.getElementById('upload-panel').classList.remove('visible'); }
    function setStatus(msg) { document.getElementById('status').textContent = msg; }

    async function handleFile(input) {
      const file = input.files[0];
      if (!file) return;

      setStatus('Uploading…');
      const btn = document.getElementById('upload-btn');
      btn.disabled = true;
      btn.textContent = 'Uploading…';

      const fd = new FormData();
      fd.append('clip', file, file.name);

      try {
        const res  = await fetch(UPLOAD_URL, { method: 'POST', body: fd });
        const data = await res.json();
        if (res.ok) {
          btn.textContent = '✓ Uploaded';
          setStatus('Switch back to your desktop to continue.');
        } else {
          setStatus('Upload failed: ' + (data.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = 'Choose video from gallery';
        }
      } catch (err) {
        setStatus('Upload failed — check your connection and try again.');
        btn.disabled = false;
        btn.textContent = 'Choose video from gallery';
      }
    }
  </script>
</body>
</html>`);
});

// ── Upload router (public) — POST /mobile-upload/:token ───────────────────
export const uploadRouter = express.Router();

uploadRouter.post('/:token', upload.single('clip'), async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  session.status = 'uploading';
  console.log(`[mobile] Upload received for token: ${req.params.token}`);

  const croppedPath = path.join(MOBILE_DIR, uuid() + '-cropped.mp4');

  try {
    await cropAndScale(req.file.path, croppedPath);
    fs.rmSync(req.file.path, { force: true });
    session.clipPath = croppedPath;
    session.status   = 'ready';
    console.log(`[mobile] Session ready: ${req.params.token}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[mobile] Crop failed:', err);
    fs.rmSync(req.file.path, { force: true });
    session.status = 'error';
    session.error  = err.message;
    res.status(500).json({ error: err.message });
  }
});
