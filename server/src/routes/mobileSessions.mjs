/**
 * Mobile recording sessions
 *
 * Flow:
 *   1. Desktop calls POST /api/mobile-sessions  → gets { token }
 *   2. Desktop shows QR code pointing to GET /mobile-record/:token
 *   3. User scans on iPhone → fullscreen Celtra page loads
 *   4. User records with iOS screen recorder, taps Upload
 *   5. iPhone POSTs video to POST /api/mobile-sessions/:token/upload  (public)
 *   6. Server crops to 1080×2184 centre region via ffmpeg
 *   7. Desktop polls GET /api/mobile-sessions/:token/status until ready
 *   8. Desktop fetches GET /api/mobile-sessions/:token/clip and advances to Step 2
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
// { token → { creativeId, status, clipPath, createdAt } }
const sessions = new Map();

// Prune expired sessions every 10 minutes
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

// ── Crop incoming video to TARGET_W × TARGET_H centre region ──────────────
async function cropToTarget(inputPath, outputPath) {
  // Probe actual dimensions
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath,
  ]);
  const info  = JSON.parse(stdout);
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video) throw new Error('No video stream in mobile upload');

  const srcW = parseInt(video.width,  10);
  const srcH = parseInt(video.height, 10);
  console.log(`[mobile] Incoming dimensions: ${srcW}×${srcH}`);

  // Centre-crop to target ratio, then scale to exact target size
  // Crop the largest rectangle matching TARGET_W:TARGET_H from the centre
  const targetRatio = TARGET_W / TARGET_H;
  const srcRatio    = srcW / srcH;

  let cropW, cropH;
  if (srcRatio > targetRatio) {
    // Source is wider — crop width
    cropH = srcH;
    cropW = Math.round(srcH * targetRatio);
  } else {
    // Source is taller — crop height
    cropW = srcW;
    cropH = Math.round(srcW / targetRatio);
  }

  const cropX = Math.round((srcW - cropW) / 2);
  const cropY = Math.round((srcH - cropH) / 2);

  console.log(`[mobile] Cropping: ${cropW}×${cropH} from (${cropX},${cropY}), then scaling to ${TARGET_W}×${TARGET_H}`);

  await execFileAsync(FFMPEG, [
    '-y',
    '-i', inputPath,
    '-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=disable,setsar=1`,
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

// Auth-protected router — mounted at /api/mobile-sessions
export const apiRouter = express.Router();

// POST /api/mobile-sessions — desktop creates a session
apiRouter.post('/', (req, res) => {
  const { creativeId } = req.body;
  if (!creativeId) return res.status(400).json({ error: 'creativeId required' });

  const token = uuid();
  sessions.set(token, {
    creativeId,
    status: 'waiting',   // waiting | uploading | ready | error
    clipPath: null,
    createdAt: Date.now(),
  });

  console.log(`[mobile] Session created: ${token} for creative: ${creativeId}`);
  res.json({ token });
});

// GET /api/mobile-sessions/:token/status — desktop polls this
apiRouter.get('/:token/status', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ status: session.status, error: session.error || null });
});

// GET /api/mobile-sessions/:token/clip — desktop fetches the processed clip
apiRouter.get('/:token/clip', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session)                  return res.status(404).json({ error: 'Session not found or expired' });
  if (session.status !== 'ready') return res.status(400).json({ error: 'Clip not ready yet' });
  if (!fs.existsSync(session.clipPath)) return res.status(404).json({ error: 'Clip file missing' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="mobile-recording.mp4"');
  fs.createReadStream(session.clipPath).pipe(res);
});

// Public router — mounted at /mobile (no auth)
export const publicRouter = express.Router();

// GET /mobile-record/:token — iPhone opens this page
publicRouter.get('/record/:token', (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) {
    return res.status(404).send(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>AdCast</title></head>
      <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background:#000;color:#fff;">
        <p>This link has expired. Please generate a new QR code.</p>
      </body></html>
    `);
  }

  const { creativeId } = session;
  const token = req.params.token;

  // Build the Celtra iframe URL — bars removed, standalone
  const celtraUrl = new URL(`https://preview-sandbox.celtra.com/preview/${creativeId}/frame`);
  celtraUrl.searchParams.set('rp.useFullWidth', '1');
  celtraUrl.searchParams.set('overrides.deviceInfo.deviceType', 'Phone');
  celtraUrl.searchParams.set('rp._useSnapping', '1');
  celtraUrl.searchParams.set('rp._snappingFraction', '0.5');
  celtraUrl.searchParams.set('rp.removeAdvertisementBars', '1');
  celtraUrl.searchParams.set('rp.standalonePreview', '1');

  // Full-screen recording page — minimal UI, ad fills screen
  // Upload button hidden until user explicitly reveals it after recording
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>AdCast — Record</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }

    #ad-frame {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }

    /* Upload panel — slides up from bottom after recording */
    #upload-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: rgba(0,0,0,0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      padding: 24px 24px calc(24px + env(safe-area-inset-bottom));
      transform: translateY(100%);
      transition: transform 0.35s cubic-bezier(0.4,0,0.2,1);
      z-index: 100;
      border-radius: 16px 16px 0 0;
    }
    #upload-panel.visible { transform: translateY(0); }

    #upload-panel h2 {
      color: #fff;
      font-family: -apple-system, sans-serif;
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    #upload-panel p {
      color: rgba(255,255,255,0.6);
      font-family: -apple-system, sans-serif;
      font-size: 14px;
      margin-bottom: 20px;
      line-height: 1.4;
    }

    .btn {
      display: block;
      width: 100%;
      padding: 16px;
      border-radius: 12px;
      border: none;
      font-family: -apple-system, sans-serif;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 10px;
    }
    .btn-primary { background: #fff; color: #000; }
    .btn-secondary { background: rgba(255,255,255,0.12); color: #fff; }

    /* Small floating trigger — tap to open upload panel */
    #done-btn {
      position: fixed;
      bottom: calc(20px + env(safe-area-inset-bottom));
      right: 20px;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 20px;
      padding: 10px 16px;
      font-family: -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      z-index: 99;
    }

    #status {
      color: rgba(255,255,255,0.7);
      font-family: -apple-system, sans-serif;
      font-size: 14px;
      text-align: center;
      margin-top: 8px;
      min-height: 20px;
    }
  </style>
</head>
<body>
  <iframe
    id="ad-frame"
    src="${celtraUrl.toString()}"
    allow="camera; microphone; autoplay; fullscreen; accelerometer; gyroscope"
    allowfullscreen
  ></iframe>

  <button id="done-btn" onclick="openPanel()">Done recording ↑</button>

  <div id="upload-panel">
    <h2>Upload your recording</h2>
    <p>Finished recording? Save the screen recording to Photos, then tap below to upload it to AdCast.</p>
    <input type="file" id="file-input" accept="video/*" style="display:none" onchange="handleFile(this)">
    <button class="btn btn-primary" onclick="document.getElementById('file-input').click()">
      Choose video from Photos
    </button>
    <button class="btn btn-secondary" onclick="closePanel()">Back to ad</button>
    <div id="status"></div>
  </div>

  <script>
    const TOKEN = '${token}';
    const UPLOAD_URL = '/mobile-sessions/upload/' + TOKEN;

    function openPanel()  { document.getElementById('upload-panel').classList.add('visible'); }
    function closePanel() { document.getElementById('upload-panel').classList.remove('visible'); }

    function setStatus(msg) { document.getElementById('status').textContent = msg; }

    async function handleFile(input) {
      const file = input.files[0];
      if (!file) return;

      setStatus('Uploading…');
      document.querySelector('.btn-primary').disabled = true;

      const fd = new FormData();
      fd.append('clip', file, file.name);

      try {
        const res  = await fetch(UPLOAD_URL, { method: 'POST', body: fd });
        const data = await res.json();
        if (res.ok) {
          setStatus('✓ Uploaded! Switch back to your desktop to continue.');
          document.querySelector('.btn-primary').textContent = 'Uploaded ✓';
        } else {
          setStatus('Upload failed: ' + (data.error || 'Unknown error'));
          document.querySelector('.btn-primary').disabled = false;
        }
      } catch (err) {
        setStatus('Upload failed — check your connection and try again.');
        document.querySelector('.btn-primary').disabled = false;
      }
    }
  </script>
</body>
</html>`);
});

// POST /mobile-sessions/upload/:token — iPhone uploads the video here (public, no auth)
publicRouter.post('/upload/:token', upload.single('clip'), async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  session.status = 'uploading';
  console.log(`[mobile] Upload received for token: ${req.params.token}`);

  const croppedPath = path.join(MOBILE_DIR, uuid() + '-cropped.mp4');

  try {
    await cropToTarget(req.file.path, croppedPath);
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
