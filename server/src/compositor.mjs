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

// Output — standard mobile portrait
const W   = 1080;
const H   = 1920;
const FPS = 30;

// Scale factor from mockup (1179×2556) to output (1080×1920)
const SX = W / 1179;  // 0.9161
const SY = H / 2556;  // 0.7511

// Creative layer — anchored to bottom, scaled from mockup
const CREATIVE_H   = Math.round(2384 * SY); // 1790px
const CREATIVE_TOP = H - CREATIVE_H;        // 130px

// Ad bars — 55px in mockup scaled to output
const AD_BAR_H     = Math.round(55 * SY);   // 41px
const AD_CONTENT_H = CREATIVE_H - AD_BAR_H * 2; // content between bars

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

  // Cache unique frames as raw RGBA buffers
  onProgress(15, 'Building your scene…');

  const frameCache = new Map();
  const uniqueYs   = [...new Set(frameScrollY)];
  let   doneUniq   = 0;

  for (const scrollY of uniqueYs) {
    const buf = await buildFrame({
      scrollY: Math.min(scrollY, pubCanvasH - H),
      topImg: topScaled, topH,
      botImg: botScaled, botH,
      pubCanvasH,
    });
    frameCache.set(scrollY, buf);
    doneUniq++;
    onProgress(15 + Math.round((doneUniq / uniqueYs.length) * 50), 'Building your scene…');
  }

  // Free scaled images — no longer needed
  topScaled.fill(0);
  botScaled.fill(0);

  onProgress(67, 'Encoding…');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Launch ffmpeg: two inputs
  //   input 0: raw RGBA publisher overlay frames piped to stdin
  //   input 1: ad clip WebM (looped)
  // Filter: clip scaled+padded to creative area → publisher overlay on top
  const ffArgs = [
    '-y',
    // Input 0: raw RGBA frames from stdin
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${W}x${H}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    // Input 1: ad clip looped
    '-stream_loop', '-1',
    '-t', totalDurSec.toFixed(3),
    '-i', clipPath,
    '-filter_complex', [
      // Scale clip to fit content area (no zoom), add black ad bars, pad to full frame
      `[1:v]scale=${W}:${AD_CONTENT_H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${AD_CONTENT_H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `pad=${W}:${CREATIVE_H}:0:${AD_BAR_H}:color=black,` +
        `pad=${W}:${H}:0:${CREATIVE_TOP}:color=white[clip]`,
      // Publisher overlay from stdin (RGBA)
      `[0:v]format=rgba[pub]`,
      // Composite: clip under publisher
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

  const ffDone = new Promise((res, rej) =>
    ff.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg:\n' + ffErr))));

  // Pipe frames to ffmpeg stdin in order
  for (let i = 0; i < frameScrollY.length; i++) {
    const buf = frameCache.get(frameScrollY[i]);
    await new Promise((res, rej) => {
      const ok = ff.stdin.write(buf, err => err ? rej(err) : res());
      if (!ok) ff.stdin.once('drain', res);
    });
    if (i % 20 === 0) {
      onProgress(67 + Math.round((i / totalFrames) * 25), 'Encoding…');
    }
  }

  ff.stdin.end();
  await ffDone;

  onProgress(100, 'Done');
}
