/**
 * Compositor — server-side Playwright + ffmpeg engine.
 *
 * Adapted from the proven CLI record.mjs prototype.
 * Key difference: instead of rendering a live Celtra iframe, we composite
 * the pre-recorded WebM clip (from the browser's getDisplayMedia capture)
 * into the publisher screenshot using a <video> element in the scene.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { chromium as pw } from 'playwright';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// Bundled, self-contained binaries — no system ffmpeg/ffprobe needed on Render.
// (Playwright's own bundled ffmpeg, used by recordVideo, is installed separately
// via `npx playwright install ffmpeg` in the Render build command.)
const FFMPEG = ffmpegStatic || 'ffmpeg';
const FFPROBE = (ffprobeStatic && ffprobeStatic.path) || 'ffprobe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Output spec — matches the proven CLI defaults
const OUTPUT = { width: 1080, height: 1920, fps: 30 };

// Motion config — scroll-in → hold → scroll-out camera
const MOTION = {
  settleMs: 600,
  scrollInMs: 3500,
  holdMs: 5000,
  scrollOutMs: 3000,
  tailMs: 600,
  easing: 'easeInOutCubic'
};

// Ad slot dimensions (Celtra All-in-One 500×950, centred in 1080 wide page)
const AD = { width: 500, height: 950 };

const EASE = {
  easeInOutCubic: p => p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2,3)/2,
  easeOutCubic: p => 1 - Math.pow(1-p, 3),
  linear: p => p
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 27 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

const probeDur = async f => parseFloat(
  (await run(FFPROBE, ['-v','error','-show_entries','format=duration',
    '-of','default=nw=1:nk=1', f])).trim());

async function launchBrowser() {
  try {
    return await pw.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
             '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
             '--no-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    // Fallback for constrained environments
    try {
      const mod = await import('@sparticuz/chromium');
      const c = mod.default || mod;
      return await pw.launch({
        executablePath: await c.executablePath(), headless: true,
        args: [...(c.args || []), '--no-sandbox', '--disable-dev-shm-usage',
               '--autoplay-policy=no-user-gesture-required']
      });
    } catch { throw err; }
  }
}

function buildSceneHtml({ publisherUrl, clipUrl, adX, adY, adW, adH, pageW }) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#fff;}
  *{box-sizing:border-box;}
  #page{position:relative;width:${pageW}px;margin:0 auto;}
  #page>img.bg{display:block;width:${pageW}px;height:auto;}
  #adslot{
    position:absolute;
    left:${adX}px;top:${adY}px;
    width:${adW}px;height:${adH}px;
    overflow:hidden;background:#000;
  }
  #adslot video{
    display:block;width:${adW}px;height:${adH}px;
    object-fit:cover;
  }
</style></head>
<body>
  <div id="page">
    <img class="bg" src="${publisherUrl}">
    <div id="adslot">
      <video src="${clipUrl}" autoplay muted playsinline loop></video>
    </div>
  </div>
</body></html>`;
}

export async function runCompositor({ clipPath, publisherPath, outPath, onProgress }) {
  const { width: W, height: H, fps: FPS } = OUTPUT;
  const ease = EASE[MOTION.easing];

  onProgress(5, 'Starting compositor…');

  // Serve the scene over a local HTTP server so Playwright can load it
  // (avoids file:// protocol cross-origin issues with the video element)
  const { createServer } = await import('node:http');
  const serveFile = (filePath, contentType) => {
    const server = createServer((req, res) => {
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
  };

  const clipServer = await serveFile(clipPath, 'video/webm');
  const pubServer = await serveFile(publisherPath, 'image/jpeg');
  const clipPort = clipServer.address().port;
  const pubPort = pubServer.address().port;

  // Calculate ad X position: centred in 1080px page
  const adX = Math.round((W - AD.width) / 2);

  // Ad Y: place ad ~60% down the publisher page (roughly where ad slots appear)
  // The compositor will scroll to bring it into view automatically
  const adY = Math.round(H * 1.8);

  const sceneHtml = buildSceneHtml({
    publisherUrl: `http://127.0.0.1:${pubPort}/image`,
    clipUrl: `http://127.0.0.1:${clipPort}/clip`,
    adX, adY,
    adW: AD.width,
    adH: AD.height,
    pageW: W
  });

  // Serve the scene HTML
  const { createServer: cs2 } = await import('node:http');
  const sceneServer = await new Promise(resolve => {
    const s = cs2((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(sceneHtml);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const scenePort = sceneServer.address().port;

  onProgress(15, 'Launching browser…');
  const browser = await launchBrowser();
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));

  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: W, height: H } }
  });
  const page = await context.newPage();

  onProgress(25, 'Loading scene…');
  await page.goto(`http://127.0.0.1:${scenePort}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const adCenterY = adY + AD.height / 2;
  const maxY = Math.max(0, docHeight - H);
  const targetY = Math.max(0, Math.min(maxY, Math.round(adCenterY - H / 2)));

  const scrollTo = y => page.evaluate(v => window.scrollTo(0, v), Math.round(y));
  const animate = async (from, to, durMs) => {
    const n = Math.max(1, Math.round(durMs / 1000 * FPS));
    const t0 = Date.now();
    for (let i = 1; i <= n; i++) {
      await scrollTo(from + (to - from) * ease(i / n));
      const wait = t0 + i * (1000 / FPS) - Date.now();
      if (wait > 0) await sleep(wait);
    }
  };

  onProgress(35, 'Rolling camera…');
  await scrollTo(0);
  const tCam = Date.now();
  await sleep(MOTION.settleMs);

  onProgress(45, 'Scrolling in…');
  await animate(0, targetY, MOTION.scrollInMs);
  await scrollTo(targetY);

  onProgress(60, 'Holding on ad…');
  await sleep(MOTION.holdMs);

  onProgress(75, 'Scrolling out…');
  await animate(targetY, maxY, MOTION.scrollOutMs);
  await sleep(MOTION.tailMs);

  const camDur = (Date.now() - tCam) / 1000;

  onProgress(82, 'Closing browser…');
  await context.close();
  await browser.close();
  clipServer.close();
  pubServer.close();
  sceneServer.close();

  const webmFile = fs.readdirSync(videoDir).find(f => f.endsWith('.webm'));
  const webmPath = path.join(videoDir, webmFile);
  const webmDur = await probeDur(webmPath);
  const head = Math.max(0, webmDur - camDur - 0.08);

  onProgress(88, 'Encoding MP4…');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  await run(FFMPEG, [
    '-y',
    '-ss', head.toFixed(3),
    '-i', webmPath,
    '-t', camDur.toFixed(3),
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    outPath
  ]);

  fs.rmSync(videoDir, { recursive: true, force: true });
  onProgress(100, 'Done');
}
