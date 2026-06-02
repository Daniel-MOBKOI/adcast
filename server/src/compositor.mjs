/**
 * Compositor v6 — memory-efficient per-frame compositing.
 *
 * Never loads the full publisher canvas into memory.
 * Each frame is built on-demand by compositing only the visible slices
 * of the top/bottom publisher images directly into a W×H output frame.
 *
 * Peak RAM: ~30MB per frame vs ~400MB for the full canvas approach.
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

// Output frame — exact export canvas from mockup masters
const W   = 1179;
const H   = 2556;
const FPS = 30;

// Creative layer — anchored to bottom of output frame
const CREATIVE_H   = 2384;
const CREATIVE_TOP = H - CREATIVE_H; // 172px from top

// Publisher gap = scaled from Publisher_Full_Size_Overlay.png measurement
// Gap: 2019px at 1024px wide → scaled to W=1179px wide
const PUB_SCALE   = W / 1024;
const PUB_GAP_H   = Math.round(2019 * PUB_SCALE); // 2325px

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

/**
 * Build one W×H publisher overlay frame at a given scroll position.
 *
 * The virtual publisher canvas layout (top to bottom):
 *   [topH px]      — publisher top image scaled to W
 *   [PUB_GAP_H px] — transparent gap (ad slot)
 *   [botH px]      — publisher bottom image scaled to W
 *
 * For each scrollY, we crop a W×H window from this virtual canvas,
 * compositing only the slices we actually need.
 */
async function buildFrame({
  scrollY,
  topImg, topH,
  botImg, botH,
  pubCanvasH,
}) {
  const gapTop = topH;
  const gapBot = topH + PUB_GAP_H;

  // Viewport: [scrollY, scrollY + H) in virtual canvas coords
  const vpTop = scrollY;
  const vpBot = scrollY + H;

  // Composites to place onto the W×H output frame
  const composites = [];

  // ── Top image slice ──────────────────────────────────────────────────────
  // Visible if viewport overlaps [0, topH)
  const topVisible_start = Math.max(vpTop, 0);
  const topVisible_end   = Math.min(vpBot, gapTop);
  if (topVisible_end > topVisible_start) {
    const srcY  = topVisible_start;           // row in top image
    const srcH  = topVisible_end - topVisible_start;
    const dstY  = topVisible_start - vpTop;   // row in output frame
    const slice = await sharp(topImg)
      .extract({ left: 0, top: srcY, width: W, height: srcH })
      .toBuffer();
    composites.push({ input: slice, top: dstY, left: 0 });
  }

  // ── Gap is transparent — nothing to composite ────────────────────────────

  // ── Bottom image slice ───────────────────────────────────────────────────
  // Visible if viewport overlaps [gapBot, pubCanvasH)
  const botVisible_start = Math.max(vpTop, gapBot);
  const botVisible_end   = Math.min(vpBot, pubCanvasH);
  if (botVisible_end > botVisible_start) {
    const srcY  = botVisible_start - gapBot;  // row in bottom image
    const srcH  = botVisible_end - botVisible_start;
    const dstY  = botVisible_start - vpTop;   // row in output frame
    const slice = await sharp(botImg)
      .extract({ left: 0, top: srcY, width: W, height: srcH })
      .toBuffer();
    composites.push({ input: slice, top: dstY, left: 0 });
  }

  // Build output frame: transparent base + composited slices
  const frame = await sharp({
    create: {
      width:     W,
      height:    H,
      channels:  4,
      background:{ r: 0, g: 0, b: 0, alpha: 0 },
    }
  })
  .composite(composites)
  .png()
  .toBuffer();

  return frame;
}

export async function runCompositor({
  clipPath,
  publisherTopPath,
  publisherBottomPath,
  outPath,
  onProgress,
}) {
  onProgress(5, 'Building your scene…');

  // ── 1. Get publisher image dimensions ─────────────────────────────────────
  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();

  const topH = Math.round(topMeta.height * (W / topMeta.width));
  const botH = Math.round(botMeta.height * (W / botMeta.width));

  // Pre-scale both images to W once — reused for every frame slice
  const topScaled = await sharp(publisherTopPath)
    .resize(W, topH, { fit: 'fill' })
    .toBuffer();
  const botScaled = await sharp(publisherBottomPath)
    .resize(W, botH, { fit: 'fill' })
    .toBuffer();

  const pubCanvasH = topH + PUB_GAP_H + botH;

  onProgress(10, 'Building your scene…');

  // ── 2. Scroll geometry ─────────────────────────────────────────────────────
  const gapTop    = topH;
  const maxScroll = Math.max(0, pubCanvasH - H);
  const targetY   = Math.max(0, Math.min(maxScroll,
    Math.round(gapTop + PUB_GAP_H / 2 - H / 2)));

  const settleFrames = Math.round(MOTION.settleMs    / 1000 * FPS);
  const holdFrames   = Math.round(MOTION.holdMs      / 1000 * FPS);
  const tailFrames   = Math.round(MOTION.tailMs      / 1000 * FPS);
  const nIn          = Math.round(MOTION.scrollInMs  / 1000 * FPS);
  const nOut         = Math.round(MOTION.scrollOutMs / 1000 * FPS);
  const totalFrames  = settleFrames + nIn + holdFrames + nOut + tailFrames;
  const totalDurSec  = totalFrames / FPS;

  const frameScrollY = [];
  for (let i = 0; i < settleFrames; i++) frameScrollY.push(0);
  for (let i = 1; i <= nIn;  i++) frameScrollY.push(Math.round(easeInOutCubic(i / nIn)  * targetY));
  for (let i = 0; i < holdFrames;  i++) frameScrollY.push(targetY);
  for (let i = 1; i <= nOut; i++) frameScrollY.push(Math.round(targetY + easeInOutCubic(i / nOut) * (maxScroll - targetY)));
  for (let i = 0; i < tailFrames;  i++) frameScrollY.push(maxScroll);

  // ── 3. Build frames per unique scroll position ────────────────────────────
  onProgress(15, 'Building your scene…');

  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  const frameCache = new Map(); // scrollY → file path (for repeated frames)
  const uniqueYs  = [...new Set(frameScrollY)];
  let   doneUniq  = 0;

  // Build one PNG per unique scroll Y
  for (const scrollY of uniqueYs) {
    const fp = path.join(tmpDir, `u_${scrollY}.png`);
    const buf = await buildFrame({
      scrollY,
      topImg: topScaled, topH,
      botImg: botScaled, botH,
      pubCanvasH,
    });
    fs.writeFileSync(fp, buf);
    frameCache.set(scrollY, fp);
    doneUniq++;
    const pct = 15 + Math.round((doneUniq / uniqueYs.length) * 55);
    onProgress(pct, 'Building your scene…');
  }

  // Write all frame files (pointing to cached unique frames)
  const frameFiles = [];
  for (let i = 0; i < frameScrollY.length; i++) {
    frameFiles.push(frameCache.get(frameScrollY[i]));
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
  // Creative clip: scaled to CREATIVE dimensions, padded to full output at CREATIVE_TOP
  // Publisher overlay: RGBA frames with transparent gap revealing the clip below

  const ffArgs = [
    '-y',
    '-stream_loop', '-1',
    '-t', totalDurSec.toFixed(3),
    '-i', clipPath,
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-filter_complex', [
      `[0:v]scale=${W}:${CREATIVE_H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${CREATIVE_H},` +
        `pad=${W}:${H}:0:${CREATIVE_TOP}:color=black[clip]`,
      `[1:v]format=rgba[pub]`,
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
