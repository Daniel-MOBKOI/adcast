/**
 * Compositor v8 — pipe frames directly to ffmpeg stdin.
 *
 * Key changes from v7:
 * - Output scaled to 1080×1920 (standard mobile, ~44% fewer pixels than 1179×2556)
 * - Frames piped to ffmpeg stdin instead of concat demuxer — no file I/O bottleneck
 *   and ffmpeg never buffers more than a few frames at once
 * - No tmp frame files written to disk
 * - Sharp processes one frame at a time, GC can reclaim after each pipe write
 *
 * Layer stack:
 *   1. Creative/ad clip — fits within content area, black bars top+bottom
 *   2. Publisher overlay — scrolls over, transparent gap reveals clip
 */

import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import sharp  from 'sharp';
import ffmpegStatic  from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const FFMPEG  = ffmpegStatic  || 'ffmpeg';
const FFPROBE = (ffprobeStatic && ffprobeStatic.path) || 'ffprobe';

// Output — exact ratio match to master (1179x2556 -> 810x1756)
const W   = 810;
const H   = 1756;
const FPS = 30;

// Scale factor from mockup (1179x2556) to output (810x1756)
const SY = H / 2556;  // 0.6871

// Creative layer — anchored to bottom, scaled from mockup
const CREATIVE_H   = Math.round(2384 * SY); // 1638px
const CREATIVE_TOP = H - CREATIVE_H;        // 118px

// Ad bars — 55px in mockup scaled to output
const AD_BAR_H     = Math.round(55 * SY);   // 38px
const AD_CONTENT_H = CREATIVE_H - AD_BAR_H * 2; // 1562px

// Publisher gap = full creative height
const PUB_GAP_H = CREATIVE_H;

// Motion (ms)
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

async function buildFrame({ scrollY, topImg, topH, botImg, botH, pubCanvasH }) {
  const gapTop = topH;
  const gapBot = topH + PUB_GAP_H;
  const vpTop  = scrollY;
  const vpBot  = scrollY + H;
  const composites = [];

  const topStart = Math.max(vpTop, 0);
  const topEnd   = Math.min(vpBot, gapTop);
  if (topEnd > topStart) {
    const slice = await sharp(topImg)
      .extract({ left: 0, top: topStart, width: W, height: topEnd - topStart })
      .toBuffer();
    composites.push({ input: slice, top: topStart - vpTop, left: 0 });
  }

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
  .raw()  // raw RGBA — faster to pipe than PNG encode/decode
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

  // Scale publisher images to output width
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

  // Scroll geometry
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

  onProgress(15, 'Building your scene…');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Launch ffmpeg:
  //   input 0: ad clip WebM (file — easier for ffmpeg as first input)
  //   input 1: publisher overlay raw RGBA frames (piped to stdin)
  // Filter: scale clip → composite publisher on top (transparent gap reveals clip)
  const ffArgs = [
    '-y',
    // Input 0: ad clip looped to full duration (file input)
    '-stream_loop', '-1',
    '-t', totalDurSec.toFixed(3),
    '-i', clipPath,
    // Input 1: publisher overlay raw RGBA from stdin
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${W}x${H}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    '-filter_complex', [
      // Scale clip to fit within AD_CONTENT area:
      // Step 1: scale to AD_CONTENT_H height, keeping AR (width may be < or > W)
      // Step 2: crop width to W if wider, pad width to W if narrower
      // Step 3: pad height to CREATIVE_H adding AD_BAR_H black bars top+bottom
      // Step 4: pad to full output frame, CREATIVE_TOP white at top
      `[0:v]scale=-2:${AD_CONTENT_H},` +
        `crop='min(iw,${W})':${AD_CONTENT_H},` +
        `pad=${W}:${AD_CONTENT_H}:(ow-iw)/2:0:color=black,` +
        `pad=${W}:${CREATIVE_H}:0:${AD_BAR_H}:color=black,` +
        `pad=${W}:${H}:0:${CREATIVE_TOP}:color=white[clip]`,
      // Publisher overlay from stdin (RGBA — transparent gap reveals clip)
      `[1:v]format=rgba[pub]`,
      // Composite: clip (bottom) + publisher overlay (top)
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

  const ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', d => { ffErr += d.toString(); });

  // Handle EPIPE gracefully — ffmpeg closed stdin early (filter error)
  ff.stdin.on('error', err => {
    if (err.code !== 'EPIPE') throw err;
    // EPIPE means ffmpeg exited — ffDone promise will reject with the error
  });

  const ffDone = new Promise((res, rej) =>
    ff.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg failed:\n' + ffErr))));

  // Build and pipe each frame on demand — no cache, ~50MB peak RAM
  for (let i = 0; i < frameScrollY.length; i++) {
    if (ff.exitCode !== null) break;
    const buf = await buildFrame({
      scrollY: Math.min(frameScrollY[i], pubCanvasH - H),
      topImg: topScaled, topH,
      botImg: botScaled, botH,
      pubCanvasH,
    });
    await new Promise((res, rej) => {
      const ok = ff.stdin.write(buf, err => {
        if (err && err.code !== 'EPIPE') rej(err);
        else res();
      });
      if (!ok) ff.stdin.once('drain', res);
    });
    if (i % 10 === 0) {
      onProgress(15 + Math.round((i / totalFrames) * 80), 'Building your scene…');
    }
  }

  ff.stdin.end();
  await ffDone;

  onProgress(100, 'Done');
}
