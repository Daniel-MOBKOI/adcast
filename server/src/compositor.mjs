/**
 * Compositor v5 — pixel-perfect native dimensions from mockup masters.
 *
 * Output: 1179×2556px H.264 MP4 (exact export canvas size from mockup)
 *
 * Layer stack (bottom to top):
 *   1. Creative/ad clip — 1179×2384px, anchored to BOTTOM at Y=172
 *   2. Publisher overlay — 1024×8000px scaled to 1179px wide, scrolls over top
 *      Gap in publisher: rows 3478-5496 (2019px @ 1024w → 2325px @ 1179w)
 *      Gap reveals creative below as publisher scrolls
 *
 * No Playwright — Sharp handles all image compositing, ffmpeg encodes.
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import ffmpegStatic  from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const FFMPEG  = ffmpegStatic  || 'ffmpeg';
const FFPROBE = (ffprobeStatic && ffprobeStatic.path) || 'ffprobe';

// Output frame — exact export canvas from mockup
const W   = 1179;
const H   = 2556;
const FPS = 30;

// Creative layer — anchored to bottom of output frame
const CREATIVE_W   = 1179;
const CREATIVE_H   = 2384;
const CREATIVE_TOP = H - CREATIVE_H; // 172px

// Publisher overlay native dimensions
const PUB_NATIVE_W = 1024;
const PUB_NATIVE_H = 8000;
const PUB_GAP_START_NATIVE = 3478; // row where gap starts in native publisher
const PUB_GAP_END_NATIVE   = 5496; // row where gap ends in native publisher

// Publisher scaled to output width
const PUB_SCALE   = W / PUB_NATIVE_W; // 1179/1024 = 1.1514
const PUB_H_SCALED = Math.round(PUB_NATIVE_H * PUB_SCALE);
const PUB_GAP_START = Math.round(PUB_GAP_START_NATIVE * PUB_SCALE);
const PUB_GAP_END   = Math.round(PUB_GAP_END_NATIVE   * PUB_SCALE);
const PUB_GAP_H     = PUB_GAP_END - PUB_GAP_START;

// Motion config (ms)
const MOTION = {
  settleMs:    600,
  scrollInMs:  3500,
  holdMs:      5000,
  scrollOutMs: 3000,
  tailMs:      600,
};

const easeInOutCubic = p =>
  p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

export async function runCompositor({
  clipPath,
  publisherTopPath,
  publisherBottomPath,
  outPath,
  onProgress,
}) {
  onProgress(5, 'Building your scene…');

  // ── 1. Build publisher scene canvas ───────────────────────────────────────
  // Scale both publisher images to W=1179px wide.
  // Compose with a transparent gap of PUB_GAP_H px between them.
  // This canvas scrolls over the fixed creative layer.

  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();

  const topH = Math.round(topMeta.height * (W / topMeta.width));
  const botH = Math.round(botMeta.height * (W / botMeta.width));

  const topResized = await sharp(publisherTopPath)
    .resize(W, topH, { fit: 'fill' })
    .toBuffer();

  const botResized = await sharp(publisherBottomPath)
    .resize(W, botH, { fit: 'fill' })
    .toBuffer();

  // Publisher canvas: top + transparent gap + bottom
  const pubCanvasH = topH + PUB_GAP_H + botH;
  const pubGapTop  = topH;

  const pubCanvas = await sharp({
    create: {
      width:     W,
      height:    pubCanvasH,
      channels:  4,
      background:{ r: 0, g: 0, b: 0, alpha: 0 },
    }
  })
  .composite([
    { input: topResized, top: 0,                left: 0 },
    { input: botResized, top: pubGapTop + PUB_GAP_H, left: 0 },
  ])
  .png()
  .toBuffer();

  onProgress(12, 'Building your scene…');

  // ── 2. Scroll geometry ─────────────────────────────────────────────────────
  // We scroll the publisher canvas so the gap centres over the output viewport.
  // During hold: gap centre = viewport centre (H/2)
  // targetScrollY = pubGapTop + PUB_GAP_H/2 - H/2
  const maxScroll = Math.max(0, pubCanvasH - H);
  const targetY   = Math.max(0, Math.min(maxScroll,
    Math.round(pubGapTop + PUB_GAP_H / 2 - H / 2)));

  const settleFrames = Math.round(MOTION.settleMs    / 1000 * FPS);
  const holdFrames   = Math.round(MOTION.holdMs      / 1000 * FPS);
  const tailFrames   = Math.round(MOTION.tailMs      / 1000 * FPS);
  const nIn          = Math.round(MOTION.scrollInMs  / 1000 * FPS);
  const nOut         = Math.round(MOTION.scrollOutMs / 1000 * FPS);
  const totalFrames  = settleFrames + nIn + holdFrames + nOut + tailFrames;
  const totalDurSec  = totalFrames / FPS;

  // Per-frame scroll Y
  const frameScrollY = [];
  for (let i = 0; i < settleFrames; i++) frameScrollY.push(0);
  for (let i = 1; i <= nIn;  i++) frameScrollY.push(Math.round(easeInOutCubic(i / nIn)  * targetY));
  for (let i = 0; i < holdFrames;  i++) frameScrollY.push(targetY);
  for (let i = 1; i <= nOut; i++) frameScrollY.push(Math.round(targetY + easeInOutCubic(i / nOut) * (maxScroll - targetY)));
  for (let i = 0; i < tailFrames;  i++) frameScrollY.push(maxScroll);

  // ── 3. Crop publisher overlay frames ──────────────────────────────────────
  onProgress(15, 'Building your scene…');

  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  const cropCache = new Map();
  const uniqueYs  = [...new Set(frameScrollY)];
  let   doneUniq  = 0;

  for (const scrollY of uniqueYs) {
    const clampedY = Math.min(scrollY, pubCanvasH - H);
    const buf = await sharp(pubCanvas)
      .extract({ left: 0, top: Math.max(0, clampedY), width: W, height: H })
      .png()
      .toBuffer();
    cropCache.set(scrollY, buf);
    doneUniq++;
    const pct = 15 + Math.round((doneUniq / uniqueYs.length) * 55);
    onProgress(pct, 'Building your scene…');
  }

  const frameFiles = [];
  for (let i = 0; i < frameScrollY.length; i++) {
    const fp = path.join(tmpDir, `f_${i.toString().padStart(5, '0')}.png`);
    fs.writeFileSync(fp, cropCache.get(frameScrollY[i]));
    frameFiles.push(fp);
  }

  // ── 4. Write ffmpeg concat list ────────────────────────────────────────────
  onProgress(72, 'Encoding…');

  const concatFile = path.join(tmpDir, 'frames.txt');
  const frameDur   = (1 / FPS).toFixed(6);
  const lines      = frameFiles.map(f => `file '${f}'\nduration ${frameDur}`);
  lines.push(`file '${frameFiles[frameFiles.length - 1]}'`);
  fs.writeFileSync(concatFile, lines.join('\n'));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // ── 5. ffmpeg composite ────────────────────────────────────────────────────
  // Layer 1 (bottom): ad clip scaled to CREATIVE dimensions, padded to output frame
  //   Creative: 1179×2384, top at Y=172 (anchored to bottom of 1179×2556 frame)
  // Layer 2 (top): publisher overlay frames (RGBA, transparent gap reveals clip)

  const ffArgs = [
    '-y',
    // Input 0: ad clip looped to full duration
    '-stream_loop', '-1',
    '-t', totalDurSec.toFixed(3),
    '-i', clipPath,
    // Input 1: publisher overlay frame sequence
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-filter_complex', [
      // Scale clip to creative dimensions (fill, centre-crop if needed)
      `[0:v]scale=${CREATIVE_W}:${CREATIVE_H}:force_original_aspect_ratio=increase,` +
        `crop=${CREATIVE_W}:${CREATIVE_H},` +
        // Pad to full output frame, creative anchored to bottom at CREATIVE_TOP
        `pad=${W}:${H}:0:${CREATIVE_TOP}:color=black[clip]`,
      // Publisher overlay frames — ensure RGBA
      `[1:v]format=rgba[pub]`,
      // Composite: clip under publisher (gap in publisher reveals clip)
      `[clip][pub]overlay=x=0:y=0:shortest=1[out]`,
    ].join(';'),
    '-map', '[out]',
    '-t', totalDurSec.toFixed(3),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '18',
    '-preset', 'fast',
    '-movflags', '+faststart',
    outPath,
  ];

  await run(FFMPEG, ffArgs);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  onProgress(100, 'Done');
}
