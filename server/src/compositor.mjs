/**
 * Compositor v4 — Sharp + ffmpeg only. No Playwright, no browser.
 *
 * Pipeline:
 *   1. Sharp stitches top publisher image + transparent gap + bottom publisher
 *      image into one tall RGBA PNG (the "scene canvas").
 *   2. Per-frame, Sharp crops a 1080×1920 slice of the scene canvas at the
 *      correct scroll Y — instant, no browser round-trips.
 *   3. ffmpeg receives:
 *        Input 0: WebM ad clip (looped, full duration) — background layer
 *        Input 1: PNG frame sequence (publisher overlay with transparent gap)
 *      Filter: overlay publisher on top of clip — transparency reveals clip
 *      Encode: H.264 MP4
 *
 * No Playwright needed → runs on Render Starter (512MB RAM, $7/mo).
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Output spec
const W = 1080, H = 1920, FPS = 30;

// Ad slot — full output width
const AD_W = W;
const AD_H = 950;

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

  // ── 1. Stitch publisher scene canvas ──────────────────────────────────────
  // Scale both images to output width, compose vertically as:
  //   [top image scaled to W]
  //   [AD_H px transparent gap]  ← ad clip shows through here
  //   [bottom image scaled to W]

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

  // Total canvas height and ad slot position
  const canvasH   = topH + AD_H + botH;
  const adSlotTop = topH;

  // Compose RGBA canvas: top + transparent gap + bottom
  const sceneCanvas = await sharp({
    create: {
      width:     W,
      height:    canvasH,
      channels:  4,
      background:{ r: 0, g: 0, b: 0, alpha: 0 },
    }
  })
  .composite([
    { input: topResized, top: 0,                left: 0 },
    { input: botResized, top: adSlotTop + AD_H, left: 0 },
  ])
  .png()
  .toBuffer();

  onProgress(12, 'Building your scene…');

  // ── 2. Build scroll positions ──────────────────────────────────────────────
  const maxScroll = Math.max(0, canvasH - H);

  // Scroll target: ad slot centred in viewport
  const targetY = Math.max(0,
    Math.min(maxScroll, Math.round(adSlotTop + AD_H / 2 - H / 2)));

  const settleFrames = Math.round(MOTION.settleMs    / 1000 * FPS);
  const holdFrames   = Math.round(MOTION.holdMs      / 1000 * FPS);
  const tailFrames   = Math.round(MOTION.tailMs      / 1000 * FPS);
  const nIn          = Math.round(MOTION.scrollInMs  / 1000 * FPS);
  const nOut         = Math.round(MOTION.scrollOutMs / 1000 * FPS);
  const totalFrames  = settleFrames + nIn + holdFrames + nOut + tailFrames;
  const totalDurSec  = totalFrames / FPS;

  // Per-frame scroll Y values
  const frameScrollY = [];
  for (let i = 0; i < settleFrames; i++) frameScrollY.push(0);
  for (let i = 1; i <= nIn;  i++) frameScrollY.push(Math.round(easeInOutCubic(i / nIn)  * targetY));
  for (let i = 0; i < holdFrames;  i++) frameScrollY.push(targetY);
  for (let i = 1; i <= nOut; i++) frameScrollY.push(Math.round(targetY + easeInOutCubic(i / nOut) * (maxScroll - targetY)));
  for (let i = 0; i < tailFrames;  i++) frameScrollY.push(maxScroll);

  // ── 3. Crop publisher frames ───────────────────────────────────────────────
  onProgress(15, 'Building your scene…');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));

  // Cache by scrollY — static segments reuse the same crop
  const cropCache = new Map();
  const uniqueYs  = [...new Set(frameScrollY)];
  let   doneUniq  = 0;

  // Pre-compute all unique crops
  for (const scrollY of uniqueYs) {
    const buf = await sharp(sceneCanvas)
      .extract({ left: 0, top: Math.min(scrollY, canvasH - H), width: W, height: H })
      .png()
      .toBuffer();
    cropCache.set(scrollY, buf);
    doneUniq++;
    const pct = 15 + Math.round((doneUniq / uniqueYs.length) * 55);
    onProgress(pct, 'Building your scene…');
  }

  // Write all frames (reusing cached buffers for static segments)
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

  // ── 5. ffmpeg two-layer composite ──────────────────────────────────────────
  // Layer 1 (bottom): ad clip scaled to fill the FULL output frame (1080×1920).
  //   The publisher overlay masks everything except the transparent gap,
  //   so only the gap region shows the clip — at whatever scroll position
  //   the gap is at in that frame. Scaling to full frame means the clip
  //   is always visible through the gap regardless of scroll position.
  // Layer 2 (top): publisher PNG frames (RGBA) with transparent gap.

  const ffArgs = [
    '-y',
    // Input 0: ad clip, looped to full duration
    '-stream_loop', '-1',
    '-t', totalDurSec.toFixed(3),
    '-i', clipPath,
    // Input 1: publisher PNG frame sequence
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-filter_complex', [
      // Scale clip to fill full output frame — publisher masks all but the gap
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}[clip]`,
      // Publisher frames — already W×H PNGs with RGBA transparency
      `[1:v]format=rgba[pub]`,
      // Composite: clip (bottom) + publisher overlay (top, transparent gap reveals clip)
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

  // ── Cleanup ────────────────────────────────────────────────────────────────
  fs.rmSync(tmpDir, { recursive: true, force: true });
  onProgress(100, 'Done');
}
