/**
 * Compositor v2 — screenshot-per-frame pipeline.
 *
 * Instead of Playwright recordVideo (which drops frames in headless software
 * rendering), we:
 *   1. Build a scene page: top publisher image / ad slot / bottom publisher image
 *   2. Scroll to each frame position and take a PNG screenshot
 *   3. Pipe all frames into ffmpeg as an image2pipe sequence
 *   4. ffmpeg overlays the WebM ad clip and encodes the final H.264 MP4
 *
 * This gives mathematically perfect 30fps scroll animation with no jank,
 * regardless of render speed. ffmpeg controls all timing.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { chromium as pw } from 'playwright';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const FFMPEG  = ffmpegStatic || 'ffmpeg';
const FFPROBE = (ffprobeStatic && ffprobeStatic.path) || 'ffprobe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Output spec
const OUTPUT = { width: 1080, height: 1920, fps: 30 };

// Motion config
const MOTION = {
  settleMs:   600,
  scrollInMs: 3500,
  holdMs:     5000,
  scrollOutMs:3000,
  tailMs:     600,
};

// Ad slot — full output width, standard Celtra AiO height
const AD = { width: 1080, height: 950 };

// Easing
const easeInOutCubic = p => p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2, 3)/2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

const probeDur = async f => parseFloat(
  (await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', f
  ])).trim());

async function launchBrowser() {
  try {
    return await pw.launch({
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--hide-scrollbars',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',            // headless — no GPU available on Render
        '--run-all-compositor-stages-before-draw',
      ]
    });
  } catch (err) {
    try {
      const mod = await import('@sparticuz/chromium');
      const c = mod.default || mod;
      return await pw.launch({
        executablePath: await c.executablePath(),
        headless: true,
        args: [...(c.args || []), '--no-sandbox', '--disable-dev-shm-usage',
               '--autoplay-policy=no-user-gesture-required', '--disable-gpu']
      });
    } catch { throw err; }
  }
}

/**
 * Build the two-part publisher sandwich scene.
 * Layout (top to bottom):
 *   - Top publisher image  (scaled to OUTPUT.width)
 *   - Ad slot              (OUTPUT.width × AD.height) — video plays here
 *   - Bottom publisher image (scaled to OUTPUT.width)
 *
 * The ad slot has a dark overlay div that fades out as the slot scrolls
 * into view — controlled by JS scroll listener inside the page.
 */
function buildSceneHtml({ topUrl, bottomUrl, clipUrl, pageW, adH }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{background:#fff;width:${pageW}px;overflow-x:hidden;}
  #top-img{display:block;width:${pageW}px;height:auto;}
  #adslot{
    position:relative;
    width:${pageW}px;height:${adH}px;
    background:#000;overflow:hidden;
  }
  #adslot video{
    display:block;width:${pageW}px;height:${adH}px;
    object-fit:cover;
  }
  #adoverlay{
    position:absolute;inset:0;
    background:#000;
    opacity:0.6;
    pointer-events:none;
    transition:none;
  }
  #bottom-img{display:block;width:${pageW}px;height:auto;}
</style>
</head>
<body>
  <img id="top-img" src="${topUrl}">
  <div id="adslot">
    <video src="${clipUrl}" autoplay muted playsinline loop></video>
    <div id="adoverlay"></div>
  </div>
  <img id="bottom-img" src="${bottomUrl}">

  <script>
    // Fade overlay from 0.6 → 0 as ad scrolls from bottom edge to 60% visible
    const slot   = document.getElementById('adslot');
    const overlay = document.getElementById('adoverlay');
    const slotH  = ${adH};
    const vpH    = ${OUTPUT.height};

    function updateOverlay() {
      const rect = slot.getBoundingClientRect();
      // visiblePx: how many px of the slot are above the bottom of the viewport
      const visiblePx = Math.max(0, Math.min(slotH, vpH - rect.top));
      // threshold: 60% of slot height
      const threshold = slotH * 0.6;
      // progress: 0 when just entering, 1 when 60% visible
      const progress = Math.min(1, visiblePx / threshold);
      overlay.style.opacity = (0.6 * (1 - progress)).toFixed(4);
    }

    window.addEventListener('scroll', updateOverlay, { passive: true });
    updateOverlay();
  </script>
</body>
</html>`;
}

export async function runCompositor({ clipPath, publisherTopPath, publisherBottomPath, outPath, onProgress }) {
  const { width: W, height: H, fps: FPS } = OUTPUT;

  onProgress(5, 'Starting compositor…');

  // ── Local HTTP servers ────────────────────────────────────────────────────
  const { createServer } = await import('node:http');

  const serveFile = (filePath, contentType) => new Promise(resolve => {
    const s = createServer((req, res) => {
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

  const topServer  = await serveFile(publisherTopPath,    'image/jpeg');
  const botServer  = await serveFile(publisherBottomPath, 'image/jpeg');
  const clipServer = await serveFile(clipPath,            'video/webm');

  const topPort  = topServer.address().port;
  const botPort  = botServer.address().port;
  const clipPort = clipServer.address().port;

  const sceneHtml = buildSceneHtml({
    topUrl:  `http://127.0.0.1:${topPort}/top`,
    bottomUrl:`http://127.0.0.1:${botPort}/bottom`,
    clipUrl: `http://127.0.0.1:${clipPort}/clip`,
    pageW: W,
    adH:  AD.height,
  });

  const sceneServer = await new Promise(resolve => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(sceneHtml);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const scenePort = sceneServer.address().port;

  // ── Launch browser ────────────────────────────────────────────────────────
  onProgress(10, 'Launching browser…');
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  onProgress(15, 'Loading scene…');
  await page.goto(`http://127.0.0.1:${scenePort}/`, { waitUntil: 'networkidle' });
  // Let video autoplay start and images fully render
  await page.waitForTimeout(1200);

  // ── Scroll geometry ───────────────────────────────────────────────────────
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const adSlotTop = await page.evaluate(() => document.getElementById('adslot').offsetTop);
  const adCenterY = adSlotTop + AD.height / 2;
  const maxScroll = Math.max(0, docHeight - H);

  // Scroll target: ad centred in viewport
  const targetY = Math.max(0, Math.min(maxScroll, Math.round(adCenterY - H / 2)));

  // ── Build frame scroll positions ──────────────────────────────────────────
  // Each entry is the scrollY for that frame
  const frames = [];

  const addSegment = (fromY, toY, durMs, easeFn = easeInOutCubic) => {
    const n = Math.max(1, Math.round(durMs / 1000 * FPS));
    for (let i = 1; i <= n; i++) {
      const p = easeFn(i / n);
      frames.push(Math.round(fromY + (toY - fromY) * p));
    }
  };

  // settle — static at top
  const settleFrames = Math.round(MOTION.settleMs / 1000 * FPS);
  for (let i = 0; i < settleFrames; i++) frames.push(0);

  // scroll in
  addSegment(0, targetY, MOTION.scrollInMs);

  // hold
  const holdFrames = Math.round(MOTION.holdMs / 1000 * FPS);
  for (let i = 0; i < holdFrames; i++) frames.push(targetY);

  // scroll out
  addSegment(targetY, maxScroll, MOTION.scrollOutMs);

  // tail
  const tailFrames = Math.round(MOTION.tailMs / 1000 * FPS);
  for (let i = 0; i < tailFrames; i++) frames.push(maxScroll);

  const totalFrames = frames.length;
  const totalDur = totalFrames / FPS;

  onProgress(20, `Capturing ${totalFrames} frames…`);

  // ── Screenshot loop → pipe into ffmpeg ───────────────────────────────────
  // ffmpeg reads raw PNG frames from stdin, overlays the ad clip, encodes MP4
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Probe clip duration for loop/trim
  const clipDur = await probeDur(clipPath);

  // ffmpeg command:
  //   input 0: PNG frames from stdin (image2pipe)
  //   input 1: WebM ad clip (looped to match total duration)
  //   filter: overlay clip onto frames at ad slot position
  //   encode: H.264 yuv420p crf18 faststart
  const adX = 0; // full width — starts at left edge
  const adY_px = adSlotTop; // pixel position in the scene page

  // We don't use overlay filter for the clip — the clip is already baked into
  // the screenshots via the <video> element in the scene page.
  // So we just encode the screenshot sequence directly.
  // The video element autoplays and is captured in each screenshot.

  const ffArgs = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-r', String(FPS),
    '-i', 'pipe:0',           // stdin: PNG frames
    '-vf', `scale=${W}:${H}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    outPath
  ];

  const ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });

  let ffError = '';
  ff.stderr.on('data', d => { ffError += d.toString(); });

  const ffDone = new Promise((res, rej) => {
    ff.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg failed:\n' + ffError)));
  });

  // Capture each frame and pipe PNG to ffmpeg stdin
  for (let i = 0; i < totalFrames; i++) {
    const scrollY = frames[i];

    await page.evaluate(y => window.scrollTo(0, y), scrollY);

    // Give the page one rAF to repaint at this scroll position
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    ff.stdin.write(png);

    // Progress: 20–85% during capture
    if (i % 10 === 0) {
      const pct = 20 + Math.round((i / totalFrames) * 65);
      onProgress(pct, `Capturing frame ${i + 1}/${totalFrames}…`);
    }
  }

  ff.stdin.end();

  onProgress(87, 'Encoding MP4…');
  await ffDone;

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await browser.close();
  topServer.close();
  botServer.close();
  clipServer.close();
  sceneServer.close();

  onProgress(100, 'Done');
}
