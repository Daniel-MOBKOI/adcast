/**
 * Mobile recording sessions — v2
 *
 * Changes from v1:
 *  - Mobile page now shows ad in a centred padded box (black surround)
 *  - Page measures the box rect and sends it with the upload as cropRect JSON
 *  - Server uses cropRect to crop precisely (not blind centre-crop)
 *  - iframe pointer-events fixed — done button no longer overlaps ad
 *  - Done button hidden behind a small tap-target that only appears at top of screen
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

// ── Crop using explicit cropRect sent from the mobile page ─────────────────
// cropRect is in CSS pixels. We scale to video pixels using the ratio
// of actual video width to device screen width (window.screen.width).
async function cropWithRect(inputPath, outputPath, cropRect, screenW, screenH) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath,
  ]);
  const info  = JSON.parse(stdout);
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video) throw new Error('No video stream in mobile upload');

  const srcW = parseInt(video.width,  10);
  const srcH = parseInt(video.height, 10);
  console.log(`[mobile] Incoming dimensions: ${srcW}×${srcH}, screen: ${screenW}×${screenH}`);

  // Scale factor from CSS pixels → video pixels
  // Android screen recorder captures at native resolution = screen.width * devicePixelRatio
  // We don't have DPR directly, but we can derive it from srcW / screenW
  const scaleX = srcW / screenW;
  const scaleY = srcH / screenH;
  console.log(`[mobile] Scale factors: x=${scaleX.toFixed(3)} y=${scaleY.toFixed(3)}`);

  const cropX = Math.round(cropRect.x      * scaleX);
  const cropY = Math.round(cropRect.y      * scaleY);
  const cropW = Math.round(cropRect.width  * scaleX);
  const cropH = Math.round(cropRect.height * scaleY);

  // Ensure even numbers for yuv420p
  const safeCropW = cropW % 2 === 0 ? cropW : cropW - 1;
  const safeCropH = cropH % 2 === 0 ? cropH : cropH - 1;

  console.log(`[mobile] Cropping: ${safeCropW}×${safeCropH} from (${cropX},${cropY}), scaling to ${TARGET_W}×${TARGET_H}`);

  await execFileAsync(FFMPEG, [
    '-y',
    '-i', inputPath,
    '-vf', `crop=${safeCropW}:${safeCropH}:${cropX}:${cropY},scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=disable,setsar=1`,
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
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>AdCast</title></head>
      <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
        font-family:sans-serif;background:#000;color:#fff;">
        <p style="text-align:center;padding:24px">This link has expired.<br>Please generate a new QR code on desktop.</p>
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

  // Ad aspect ratio: 1080 × 2184 = 0.4945…
  const AD_RATIO = TARGET_W / TARGET_H; // ~0.4945

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
      background: #000;
      overflow: hidden;
      /* Prevent any touch scroll interfering */
      touch-action: none;
    }

    /* Full-screen black stage */
    #stage {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }

    /* Ad box — constrained to correct ratio with black padding all around.
       Padding ensures browser chrome (address bar / nav bar) is outside the ad box.
       The box is measured by JS and sent to the server with the upload. */
    #ad-box {
      position: relative;
      /* 40px padding each side gives clear black border visible during recording */
      width: calc(100vw - 80px);
      /* Height derived from width × (H/W ratio) */
      aspect-ratio: ${TARGET_W} / ${TARGET_H};
      /* Cap height so it fits vertically too */
      max-height: calc(100vh - 120px);
      max-width: calc((100vh - 120px) * ${AD_RATIO});
      background: #111;
      border-radius: 4px;
      overflow: hidden;
      /* Pointer events must reach the iframe */
      pointer-events: auto;
    }

    #ad-frame {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      pointer-events: auto;
      touch-action: auto;
    }

    /* Subtle border marker — visible in recording so you can see the crop zone */
    #ad-box::before {
      content: '';
      position: absolute;
      inset: 0;
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 4px;
      pointer-events: none;
      z-index: 10;
    }

    /* Corner label — hidden during recording (tiny, top-left of black area) */
    #corner-label {
      position: fixed;
      top: 12px;
      left: 12px;
      font-family: -apple-system, sans-serif;
      font-size: 11px;
      font-weight: 600;
      color: rgba(255,255,255,0.4);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      pointer-events: none;
      z-index: 50;
    }

    /* Done button — top right corner, small, out of the way during recording */
    #done-btn {
      position: fixed;
      top: 8px;
      right: 12px;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 16px;
      padding: 6px 14px;
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 500;
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      z-index: 200;
      /* Does NOT overlap the ad box */
    }

    /* Upload panel — slides up from bottom */
    #upload-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: rgba(15,15,15,0.97);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      padding: 28px 24px calc(28px + env(safe-area-inset-bottom));
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
      z-index: 300;
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
  <div id="stage">
    <div id="ad-box">
      <iframe
        id="ad-frame"
        src="${celtraUrl.toString()}"
        allow="camera; microphone; autoplay; fullscreen; accelerometer; gyroscope"
        allowfullscreen
        scrolling="no"
      ></iframe>
    </div>
  </div>

  <div id="corner-label">AdCast</div>

  <button id="done-btn" onclick="openPanel()">Done ↑</button>

  <div id="upload-panel">
    <h2>Upload your recording</h2>
    <p>Stop your screen recording and save it to your gallery, then tap below to upload it to AdCast on your desktop.</p>
    <input type="file" id="file-input" accept="video/*" style="display:none" onchange="handleFile(this)">
    <button class="btn btn-primary" id="upload-btn" onclick="document.getElementById('file-input').click()">
      Choose video from gallery
    </button>
    <button class="btn btn-secondary" onclick="closePanel()">Back to ad</button>
    <div id="status"></div>
  </div>

  <script>
    const TOKEN     = '${token}';
    const UPLOAD_URL = '/mobile-sessions/upload/' + TOKEN;

    // Measure the ad box rect in CSS pixels and screen dimensions
    // These are sent with the upload so the server can crop precisely
    function getAdRect() {
      const box  = document.getElementById('ad-box');
      const rect = box.getBoundingClientRect();
      return {
        x:       Math.round(rect.left),
        y:       Math.round(rect.top),
        width:   Math.round(rect.width),
        height:  Math.round(rect.height),
        screenW: window.screen.width,
        screenH: window.screen.height,
      };
    }

    function openPanel()  { document.getElementById('upload-panel').classList.add('visible'); }
    function closePanel() { document.getElementById('upload-panel').classList.remove('visible'); }
    function setStatus(msg) { document.getElementById('status').textContent = msg; }

    async function handleFile(input) {
      const file = input.files[0];
      if (!file) return;

      const adRect = getAdRect();
      console.log('Ad rect:', JSON.stringify(adRect));

      setStatus('Uploading…');
      const btn = document.getElementById('upload-btn');
      btn.disabled = true;
      btn.textContent = 'Uploading…';

      const fd = new FormData();
      fd.append('clip', file, file.name);
      fd.append('cropRect', JSON.stringify({
        x: adRect.x, y: adRect.y,
        width: adRect.width, height: adRect.height,
      }));
      fd.append('screenW', String(adRect.screenW));
      fd.append('screenH', String(adRect.screenH));

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

// POST /mobile-sessions/upload/:token — mobile device uploads video here (public, no auth)
publicRouter.post('/upload/:token', upload.single('clip'), async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  session.status = 'uploading';
  console.log(`[mobile] Upload received for token: ${req.params.token}`);

  let cropRect = null;
  let screenW  = 0;
  let screenH  = 0;

  try { cropRect = JSON.parse(req.body.cropRect || 'null'); } catch (_) {}
  try { screenW  = parseInt(req.body.screenW || '0', 10); }  catch (_) {}
  try { screenH  = parseInt(req.body.screenH || '0', 10); }  catch (_) {}

  const croppedPath = path.join(MOBILE_DIR, uuid() + '-cropped.mp4');

  try {
    if (cropRect && screenW > 0 && screenH > 0) {
      await cropWithRect(req.file.path, croppedPath, cropRect, screenW, screenH);
    } else {
      // Fallback: centre-crop if rect wasn't sent
      console.warn('[mobile] No cropRect received — falling back to centre crop');
      await centreCrop(req.file.path, croppedPath);
    }
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

// ── Centre-crop fallback ───────────────────────────────────────────────────
async function centreCrop(inputPath, outputPath) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath,
  ]);
  const info  = JSON.parse(stdout);
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video) throw new Error('No video stream in mobile upload');

  const srcW = parseInt(video.width,  10);
  const srcH = parseInt(video.height, 10);
  console.log(`[mobile] Fallback centre-crop. Incoming: ${srcW}×${srcH}`);

  const targetRatio = TARGET_W / TARGET_H;
  const srcRatio    = srcW / srcH;
  let cropW, cropH;
  if (srcRatio > targetRatio) { cropH = srcH; cropW = Math.round(srcH * targetRatio); }
  else                        { cropW = srcW; cropH = Math.round(srcW / targetRatio); }

  const cropX = Math.round((srcW - cropW) / 2);
  const cropY = Math.round((srcH - cropH) / 2);

  await execFileAsync(FFMPEG, [
    '-y', '-i', inputPath,
    '-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=disable,setsar=1`,
    '-vsync', 'cfr', '-r', '30',
    '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-threads', '1',
    outputPath,
  ]);
  console.log(`[mobile] Fallback crop done → ${path.basename(outputPath)}`);
}
