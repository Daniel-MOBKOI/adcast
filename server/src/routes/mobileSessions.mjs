/**
 * Mobile recording sessions — v3
 *
 * Crop approach: ffmpeg cropdetect scans the video for the largest non-black
 * region (the ad box). Works automatically on any phone/screen size.
 * No cropRect, no screenW/screenH, no scale factor maths needed.
 *
 * iframe interaction fix: removed touch-action:none from stage/body,
 * iframe sits directly in the DOM with no overlapping elements during recording.
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

// Target dimensions — must match compositor constants
const TARGET_W = 1080;
const TARGET_H = 2184;

// Session TTL — 30 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;

// ── In-memory session store ────────────────────────────────────────────────
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

// ── Multer for mobile uploads ──────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: MOBILE_DIR,
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname || '.mp4')),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Auto-detect crop region using ffmpeg cropdetect ───────────────────────
// Scans the first 5 seconds of the video to find the largest non-black region.
// Returns { w, h, x, y } in video pixels.
async function detectCrop(inputPath) {
  console.log('[mobile] Running cropdetect…');

  // cropdetect params: limit=24 (black threshold), round=2 (even numbers), skip=2 (skip first 2 frames)
  // We analyse up to 5 seconds only — faster and sufficient for a static black border
  const { stdout, stderr } = await execFileAsync(FFMPEG, [
    '-i', inputPath,
    '-t', '5',
    '-vf', 'cropdetect=limit=24:round=2:skip=2',
    '-f', 'null',
    '-',
  ], { maxBuffer: 1 << 24 }).catch(e => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));

  // cropdetect outputs to stderr: "crop=W:H:X:Y"
  // Multiple lines — take the last stable value (largest crop area detected)
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) throw new Error('cropdetect found no crop region');

  // Pick the most common crop value (stable detection)
  const counts = {};
  for (const m of matches) {
    const key = m[0];
    counts[key] = (counts[key] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const [, w, h, x, y] = best.match(/crop=(\d+):(\d+):(\d+):(\d+)/);

  const result = {
    w: parseInt(w, 10),
    h: parseInt(h, 10),
    x: parseInt(x, 10),
    y: parseInt(y, 10),
  };

  console.log(`[mobile] cropdetect result: ${result.w}×${result.h} from (${result.x},${result.y})`);
  return result;
}

// ── Crop and scale to target dimensions ───────────────────────────────────
async function cropAndScale(inputPath, outputPath) {
  const crop = await detectCrop(inputPath);

  // Ensure even numbers for yuv420p
  const cropW = crop.w % 2 === 0 ? crop.w : crop.w - 1;
  const cropH = crop.h % 2 === 0 ? crop.h : crop.h - 1;

  console.log(`[mobile] Cropping ${cropW}×${cropH} from (${crop.x},${crop.y}), scaling to ${TARGET_W}×${TARGET_H}`);

  await execFileAsync(FFMPEG, [
    '-y',
    '-i', inputPath,
    '-vf', `crop=${cropW}:${cropH}:${crop.x}:${crop.y},scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=disable,setsar=1`,
    '-vsync', 'cfr',
    '-r', '30',
    '-c:v', 'libx264',
    '-qp', '0',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-threads', '1',
    outputPath,
  ]);

  console.log(`[mobile] Crop done → ${path.basename(outputPath)}`);
}

// ── Routers ────────────────────────────────────────────────────────────────
export const apiRouter = express.Router();

// POST /api/mobile-sessions
apiRouter.post('/', (req, res) => {
  const { creativeId } = req.body;
  if (!creativeId) return res.status(400).json({ error: 'creativeId required' });

  const token = uuid();
  sessions.set(token, {
    creativeId,
    status: 'waiting',
    clipPath: null,
    createdAt: Date.now(),
  });

  console.log(`[mobile] Session created: ${token} for creative: ${creativeId}`);
  res.json({ token });
});

// GET /api/mobile-sessions/:token/status
apiRouter.get('/:token/status', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ status: session.status, error: session.error || null });
});

// GET /api/mobile-sessions/:token/clip
apiRouter.get('/:token/clip', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session)                   return res.status(404).json({ error: 'Session not found or expired' });
  if (session.status !== 'ready') return res.status(400).json({ error: 'Clip not ready yet' });
  if (!fs.existsSync(session.clipPath)) return res.status(404).json({ error: 'Clip file missing' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="mobile-recording.mp4"');
  fs.createReadStream(session.clipPath).pipe(res);
});

// ── Public router ──────────────────────────────────────────────────────────
export const publicRouter = express.Router();

// GET /mobile-record/:token — mobile browser opens this page
publicRouter.get('/record/:token', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) {
    return res.status(404).send(`<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>AdCast</title></head>
      <body style="display:flex;align-items:center;justify-content:center;height:100vh;
        margin:0;font-family:sans-serif;background:#000;color:#fff;">
        <p style="text-align:center;padding:24px">
          This link has expired.<br>Please generate a new QR code on desktop.
        </p>
      </body></html>`);
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
      width: 100%;
      height: 100%;
      /* Pure black — cropdetect uses this as the border reference */
      background: #000000;
      overflow: hidden;
    }

    /*
      Ad box: centred, fixed aspect ratio (1080:2184), with black padding
      all around so cropdetect can cleanly find the edges on any phone.
      Padding is generous enough to always clear browser chrome.
    */
    #ad-box {
      position: fixed;
      /* 60px top padding clears address bar on most phones */
      top: 60px;
      bottom: 60px;
      left: 40px;
      right: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #ad-frame-wrap {
      /* Maintain exact 1080:2184 ratio */
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
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      /* Critical: allow touch events to reach the cross-origin iframe */
      pointer-events: auto;
      touch-action: auto;
    }

    /*
      Done button — positioned at very top of screen, above the ad box,
      completely outside the ad area. Does not overlap iframe at all.
    */
    #done-btn {
      position: fixed;
      top: 10px;
      right: 16px;
      z-index: 100;
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 16px;
      padding: 5px 14px;
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 500;
      color: rgba(255,255,255,0.8);
      cursor: pointer;
      /* No pointer-events interference with ad below */
    }

    /* AdCast label top-left — also above ad box */
    #corner-label {
      position: fixed;
      top: 14px;
      left: 16px;
      z-index: 100;
      font-family: -apple-system, sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.3);
      pointer-events: none;
    }

    /* Upload panel — slides up from bottom, only shown after Done tap */
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
      color: #fff;
      font-family: -apple-system, sans-serif;
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    #upload-panel p {
      color: rgba(255,255,255,0.5);
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 20px;
    }

    .btn {
      display: block;
      width: 100%;
      padding: 15px;
      border-radius: 12px;
      border: none;
      font-family: -apple-system, sans-serif;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 10px;
    }
    .btn-primary  { background: #fff; color: #000; }
    .btn-primary:disabled { opacity: 0.5; }
    .btn-secondary { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }

    #status {
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      color: rgba(255,255,255,0.5);
      text-align: center;
      margin-top: 6px;
      min-height: 18px;
    }
  </style>
</head>
<body>

  <div id="corner-label">AdCast</div>
  <button id="done-btn" onclick="openPanel()">Done ↑</button>

  <!-- Ad box sits below done button, no overlap -->
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
    const UPLOAD_URL = '/mobile-sessions/upload/${token}';

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

// POST /mobile-sessions/upload/:token — mobile uploads video here (public, no auth)
publicRouter.post('/upload/:token', upload.single('clip'), async (req, res) => {
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
