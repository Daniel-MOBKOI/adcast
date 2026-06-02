/**
 * Compositor v7 — pixel-perfect positioning, memory-efficient, fast.
 *
 * Output: 1179×2556px H.264 MP4
 *
 * Layer stack (bottom to top):
 *   1. Creative/ad clip — 1179×2384px anchored to BOTTOM (top at Y=172)
 *      Top ad bar:    Y=172, H=55px (black, part of creative)
 *      Bottom ad bar: Y=2501, H=55px (black, part of creative)
 *   2. Publisher overlay — scrolls over the top, transparent gap=2384px
 *      reveals the creative below
 *
 * Speed optimisation: unique frames only (~198 vs 381).
 * Memory optimisation: per-frame slice compositing, no giant canvas.
 * Zoom fix: clip fits within creative area (decrease AR), padded not cropped.
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

// ── Output frame ─────────────────────────────────────────────────────────────
const W   = 1179;
const H   = 2556;
const FPS = 30;

// ── Creative layer ────────────────────────────────────────────────────────────
// Anchored to BOTTOM of output frame
const CREATIVE_H   = 2384; // from Creative_Unit_Layer_0.jpg
const CREATIVE_TOP = H - CREATIVE_H; // 172px

// Ad bars — 55px each, part of creative layer
const AD_BAR_TOP_Y = CREATIVE_TOP;          // 172px — flush under iPhone UI
const AD_BAR_TOP_H = 55;
const AD_BAR_BOT_Y = H - 55;               // 2501px — flush at bottom
const AD_BAR_BOT_H = 55;

// Visible ad content area (between the two bars)
const AD_CONTENT_Y = AD_BAR_TOP_Y + AD_BAR_TOP_H; // 227px
const AD_CONTENT_H = AD_BAR_BOT_Y - AD_CONTENT_Y;  // 2274px

// ── Publisher gap ─────────────────────────────────────────────────────────────
// Gap in publisher overlay = full creative height = 2384px
// (so both ad bars are visible when the gap is centred in the viewport)
const PUB_GAP_H = CREATIVE_H; // 2384px

// ── Motion ────────────────────────────────────────────────────────────────────
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
 * Build one W×H publisher overlay frame at scrollY.
 * Only the visible slices of top/bottom images are composited.
 * Gap region is transparent — reveals creative below.
 */
async function buildFrame({ scrollY, topImg, topH, botImg, botH, pubCanvasH }) {
  const gapTop = topH;
  const gapBot = topH + PUB_GAP_H;
  const vpTop  = scrollY;
  const vpBot  = scrollY + H;

  const composites = [];

  // Top publisher image slice
  const topStart = Math.max(vpTop, 0);
  const topEnd   = Math.min(vpBot, gapTop);
  if (topEnd > topStart) {
    const slice = await sharp(topImg)
      .extract({ left: 0, top: topStart, width: W, height: topEnd - topStart })
      .toBuffer();
    composites.push({ input: slice, top: topStart - vpTop, left: 0 });
  }

  // Bottom publisher image slice
  const botStart = Math.max(vpTop, gapBot);
  const botEnd   = Math.min(vpBot, pubCanvasH);
  if (botEnd > botStart) {
    const slice = await sharp(botImg)
      .extract({ left: 0, top: botStart - gapBot, width: W, height: botEnd - botStart })
      .toBuffer();
    composites.push({ input: slice, top: botStart - vpTop, left: 0 });
  }

  return sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
  .composite(composites)
  .png()
  .toBuffer();
}

export async function runCompositor({
  clipPath,
  publisherTopPath,
  publisherBottomPath,
  outPath,
  onProgress,
}) {
  onProgress(5, 'Building your scene…');

  // ── 1. Scale publisher images to output width ─────────────────────────────
  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();

  const topH = Math.round(topMeta.height * (W / topMeta.width));
  const botH = Math.round(botMeta.height * (W / botMeta.width));

  const topScaled = await sharp(publisherTopPath)
    .resize(W, topH, { fit: 'fill' })
    .toBuffer();
  const botScaled = await sharp(publisherBottomPath)
    .resize(W, botH, { fit: 'fill' })
    .toBuffer();

  const pubCanvasH = topH + PUB_GAP_H + botH;

  onProgress(10, 'Building your scene…');

  // ── 2. Scroll geometry ────────────────────────────────────────────────────
  const gapTop    = topH;
  const maxScroll = Math.max(0, pubCanvasH - H);

  // Centre the gap in the viewport during hold
  const targetY = Math.max(0, Math.min(maxScroll,
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

  // ── 3. Build unique overlay frames ───────────────────────────────────────
  onProgress(15, 'Building your scene…');

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  const frameCache = new Map();
  const uniqueYs   = [...new Set(frameScrollY)];
  let   doneUniq   = 0;

  for (const scrollY of uniqueYs) {
    const fp  = path.join(tmpDir, `u_${scrollY}.png`);
    const buf = await buildFrame({
      scrollY: Math.min(scrollY, pubCanvasH - H),
      topImg: topScaled, topH,
      botImg: botScaled, botH,
      pubCanvasH,
    });
    fs.writeFileSync(fp, buf);
    frameCache.set(scrollY, fp);
    doneUniq++;
    onProgress(15 + Math.round((doneUniq / uniqueYs.length) * 55), 'Building your scene…');
  }

  const frameFiles = frameScrollY.map(y => frameCache.get(y));

  // ── 4. ffmpeg concat list ─────────────────────────────────────────────────
  onProgress(72, 'Encoding…');

  const concatFile = path.join(tmpDir, 'frames.txt');
  const frameDur   = (1 / FPS).toFixed(6);
  const lines      = frameFiles.map(f => `file '${f}'\nduration ${frameDur}`);
  lines.push(`file '${frameFiles[frameFiles.length - 1]}'`);
  fs.writeFileSync(concatFile, lines.join('\n'));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // ── 5. ffmpeg composite ───────────────────────────────────────────────────
  // Clip: scaled to fit WITHIN creative area (decrease AR = no zoom/crop)
  //   Scale to AD_CONTENT dimensions, pad with black to fill creative area,
  //   then pad to full output frame at CREATIVE_TOP
  //
  // Ad bars (55px top + 55px bottom) are added as black padding within creative.
  // Publisher overlay sits on top, transparent gap reveals creative below.

  const ffArgs = [
    '-y',
    '-stream_loop', '-1',
    '-t', totalDurSec.toFixed(3),
    '-i', clipPath,
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-filter_complex', [
      // Scale clip to fit AD_CONTENT area (no crop — decrease AR)
      `[0:v]scale=${W}:${AD_CONTENT_H}:force_original_aspect_ratio=decrease,` +
        // Centre-pad to AD_CONTENT dimensions
        `pad=${W}:${AD_CONTENT_H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        // Add 55px black bar top and bottom (the ad bars)
        `pad=${W}:${CREATIVE_H}:0:${AD_BAR_TOP_H}:color=black,` +
        // Pad to full output frame, creative anchored to bottom
        `pad=${W}:${H}:0:${CREATIVE_TOP}:color=white[clip]`,
      // Publisher overlay — RGBA, transparent gap reveals clip
      `[1:v]format=rgba[pub]`,
      // Composite
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
