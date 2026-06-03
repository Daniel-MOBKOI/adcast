/**
 * Compositor v11 — Sharp JPEG sequence + ffmpeg.
 *
 * Fixes lagginess by separating the two phases completely:
 *
 * Phase 1 — Frame generation (Sharp):
 *   Build all publisher overlay frames as compressed JPEGs on disk.
 *   Sharp runs sequentially, no timing pressure. ~19MB disk, ~50MB RAM.
 *
 * Phase 2 — Encode (ffmpeg):
 *   ffmpeg reads the complete JPEG sequence at its own pace.
 *   All frames already exist — no waiting, no drops, no stretching.
 *   Perfectly smooth 30fps output guaranteed.
 *
 * Layer stack (bottom to top):
 *   1. Ad clip — fills creative area (1080×2184), anchored to bottom
 *   2. Publisher overlay — JPEG frames scroll over the top
 *      [publisher top] + [ad bar top] + [gap 2184px] + [ad bar bottom] + [publisher bottom]
 *   3. iPhone UI — composited by ffmpeg as final top layer
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

// ── Canvas dimensions (from supplied assets) ──────────────────────────────────
const W            = 1080;
const H            = 2342;  // iPhone UI (158) + Creative (2184)
const IPHONE_UI_H  = 158;
const CREATIVE_H   = 2184;
const CREATIVE_TOP = H - CREATIVE_H; // 158px — creative anchored to bottom
const AD_BAR_TOP_H = 41;
const AD_BAR_BOT_H = 37;
const PUB_GAP_H    = CREATIVE_H; // 2184px gap = full creative height

// ── Motion config ─────────────────────────────────────────────────────────────
const FPS = 30;
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

// ── Build one publisher overlay frame at scrollY ───────────────────────────────
// Returns a JPEG buffer of the publisher overlay (W×H) with transparent gap
// shown as white (matching the ad clip background).
// The gap region is left transparent so the ad clip layer shows through.
async function buildFrame({ scrollY, topImg, topH, botImg, botH, adBarTop, adBarBot, pubCanvasH }) {
  const gapTop = topH + AD_BAR_TOP_H;
  const gapBot = gapTop + PUB_GAP_H;
  const vpTop  = scrollY;
  const vpBot  = scrollY + H;

  const composites = [];

  // Publisher top image slice
  const topStart = Math.max(vpTop, 0);
  const topEnd   = Math.min(vpBot, topH);
  if (topEnd > topStart) {
    const slice = await sharp(topImg)
      .extract({ left: 0, top: topStart, width: W, height: topEnd - topStart })
      .toBuffer();
    composites.push({ input: slice, top: topStart - vpTop, left: 0 });
  }

  // Ad bar top slice
  const abtStart = Math.max(vpTop, topH);
  const abtEnd   = Math.min(vpBot, topH + AD_BAR_TOP_H);
  if (abtEnd > abtStart) {
    const slice = await sharp(adBarTop)
      .extract({ left: 0, top: abtStart - topH, width: W, height: abtEnd - abtStart })
      .toBuffer();
    composites.push({ input: slice, top: abtStart - vpTop, left: 0 });
  }

  // Gap — transparent (ad clip shows through) — nothing to composite

  // Ad bar bottom slice
  const abbStart = Math.max(vpTop, gapBot);
  const abbEnd   = Math.min(vpBot, gapBot + AD_BAR_BOT_H);
  if (abbEnd > abbStart) {
    const slice = await sharp(adBarBot)
      .extract({ left: 0, top: abbStart - gapBot, width: W, height: abbEnd - abbStart })
      .toBuffer();
    composites.push({ input: slice, top: abbStart - vpTop, left: 0 });
  }

  // Publisher bottom image slice
  const botStart = Math.max(vpTop, gapBot + AD_BAR_BOT_H);
  const botEnd   = Math.min(vpBot, pubCanvasH);
  if (botEnd > botStart) {
    const slice = await sharp(botImg)
      .extract({ left: 0, top: botStart - (gapBot + AD_BAR_BOT_H), width: W, height: botEnd - botStart })
      .toBuffer();
    composites.push({ input: slice, top: botStart - vpTop, left: 0 });
  }

  // Compose onto white base (white shows through gap = clean background behind ad)
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
  .composite(composites)
  .jpeg({ quality: 92, mozjpeg: true })
  .toBuffer();
}

export async function runCompositor({
  clipPath,
  publisherTopPath,
  publisherBottomPath,
  adBarTopPath,
  adBarBottomPath,
  iphoneUiPath,
  outPath,
  trimStart = 0,
  trimEnd   = null,
  onProgress,
}) {
  onProgress(5, 'Building your scene…');

  // ── Scale publisher images to output width ─────────────────────────────────
  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();
  const topH    = Math.round(topMeta.height * (W / topMeta.width));
  const botH    = Math.round(botMeta.height * (W / botMeta.width));

  const topScaled = await sharp(publisherTopPath).resize(W, topH, { fit: 'fill' }).toBuffer();
  const botScaled = await sharp(publisherBottomPath).resize(W, botH, { fit: 'fill' }).toBuffer();

  // Scale ad bars to output width
  const adBarTopScaled = await sharp(adBarTopPath).resize(W, AD_BAR_TOP_H, { fit: 'fill' }).toBuffer();
  const adBarBotScaled = await sharp(adBarBottomPath).resize(W, AD_BAR_BOT_H, { fit: 'fill' }).toBuffer();

  // Total publisher canvas height
  const pubCanvasH = topH + AD_BAR_TOP_H + PUB_GAP_H + AD_BAR_BOT_H + botH;

  onProgress(10, 'Building your scene…');

  // ── Scroll geometry ────────────────────────────────────────────────────────
  // Target: gap aligned with creative area (gap top at CREATIVE_TOP = 158px)
  // scrollY where gap top appears at CREATIVE_TOP:
  //   pubCanvasY of gap top = topH + AD_BAR_TOP_H
  //   viewportY of gap top = pubCanvasY - scrollY = CREATIVE_TOP
  //   scrollY = pubCanvasY - CREATIVE_TOP
  const gapTopInCanvas = topH + AD_BAR_TOP_H;
  const targetY        = Math.max(0, gapTopInCanvas - CREATIVE_TOP);
  const maxScroll      = Math.max(0, pubCanvasH - H);
  const clampedTarget  = Math.min(targetY, maxScroll);

  const settleFrames  = Math.round(MOTION.settleMs    / 1000 * FPS);
  const holdFrames    = Math.round(MOTION.holdMs      / 1000 * FPS);
  const tailFrames    = Math.round(MOTION.tailMs      / 1000 * FPS);
  const nIn           = Math.round(MOTION.scrollInMs  / 1000 * FPS);
  const nOut          = Math.round(MOTION.scrollOutMs / 1000 * FPS);
  const totalFrames   = settleFrames + nIn + holdFrames + nOut + tailFrames;
  const totalDurSec   = totalFrames / FPS;

  // Build per-frame scroll Y values
  const frameScrollY = [];
  for (let i = 0; i < settleFrames; i++) frameScrollY.push(0);
  for (let i = 1; i <= nIn;  i++) frameScrollY.push(Math.round(easeInOutCubic(i / nIn)  * clampedTarget));
  for (let i = 0; i < holdFrames;  i++) frameScrollY.push(clampedTarget);
  for (let i = 1; i <= nOut; i++) frameScrollY.push(Math.round(clampedTarget + easeInOutCubic(i / nOut) * (maxScroll - clampedTarget)));
  for (let i = 0; i < tailFrames;  i++) frameScrollY.push(maxScroll);

  // ── Phase 1: Write all frames as JPEGs to disk ────────────────────────────
  onProgress(12, 'Building your scene…');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  const frameFiles = [];

  // Only build unique scroll positions — reuse files for repeated positions
  const uniqueCache = new Map(); // scrollY → file path
  const uniqueYs    = [...new Set(frameScrollY)];

  let done = 0;
  for (const scrollY of uniqueYs) {
    const fp  = path.join(tmpDir, `u_${scrollY}.jpg`);
    const buf = await buildFrame({
      scrollY: Math.min(scrollY, pubCanvasH - H),
      topImg: topScaled, topH,
      botImg: botScaled, botH,
      adBarTop: adBarTopScaled,
      adBarBot: adBarBotScaled,
      pubCanvasH,
    });
    fs.writeFileSync(fp, buf);
    uniqueCache.set(scrollY, fp);
    done++;
    onProgress(12 + Math.round((done / uniqueYs.length) * 55), 'Building your scene…');
  }

  // Map all frames (including repeats) to their file paths
  for (const scrollY of frameScrollY) {
    frameFiles.push(uniqueCache.get(scrollY));
  }

  // ── Phase 2: ffmpeg encode ─────────────────────────────────────────────────
  onProgress(69, 'Encoding…');

  // Write concat list
  const concatFile = path.join(tmpDir, 'frames.txt');
  const frameDur   = (1 / FPS).toFixed(6);
  const lines      = frameFiles.map(f => `file '${f}'\nduration ${frameDur}`);
  lines.push(`file '${frameFiles[frameFiles.length - 1]}'`);
  fs.writeFileSync(concatFile, lines.join('\n'));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // iPhone UI — scale to output width
  const iphoneScaled = path.join(tmpDir, 'iphone-ui.png');
  await sharp(iphoneUiPath).resize(W, IPHONE_UI_H, { fit: 'fill' }).toFile(iphoneScaled);

  // ffmpeg filter chain:
  //   Input 0: ad clip (trimmed, looped, scaled to fill creative area)
  //   Input 1: publisher overlay JPEG sequence (from concat)
  //   Input 2: iPhone UI PNG (fixed top layer)
  //
  //   Step 1: Scale clip to fill creative area (W × CREATIVE_H), pad to full canvas
  //   Step 2: Overlay publisher JPEGs on top — white areas hide clip,
  //            gap area (white bg we made) would show clip BUT we use
  //            the overlay with the publisher having white where gap is,
  //            so we need colorkey to make white transparent in publisher frames
  //   Step 3: Overlay iPhone UI on top

  const ffArgs = [
    '-y',
    // Input 0: ad clip
    '-ss', (trimStart ?? 0).toFixed(3),
    ...(trimEnd != null ? ['-t', (trimEnd - (trimStart ?? 0)).toFixed(3)] : []),
    '-stream_loop', '-1',
    '-i', clipPath,
    // Input 1: publisher overlay JPEG sequence
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    // Input 2: iPhone UI
    '-loop', '1', '-i', iphoneScaled,
    '-filter_complex', [
      // Scale clip to fill creative area, pad to full canvas at CREATIVE_TOP
      `[0:v]scale=${W}:${CREATIVE_H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${CREATIVE_H},` +
        `pad=${W}:${H}:0:${CREATIVE_TOP}:color=white[clip]`,
      // Publisher frames: make white (gap area) transparent using colorkey
      // similarity=0.08 catches near-white from JPEG compression
      `[1:v]colorkey=white:similarity=0.08:blend=0.0,format=rgba[pub]`,
      // Overlay publisher (with transparent gap) over clip
      `[clip][pub]overlay=x=0:y=0:shortest=1[base]`,
      // Scale iPhone UI to full canvas width, overlay on top
      `[2:v]scale=${W}:${IPHONE_UI_H}[ui]`,
      `[base][ui]overlay=x=0:y=0:shortest=1[out]`,
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
