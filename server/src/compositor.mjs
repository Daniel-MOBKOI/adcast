/**
 * Compositor v19 — Sharp image sequence, single path.
 *
 * Reverts to Sharp frame-building for all publishers (built-in and uploaded).
 * Simpler, more predictable, works universally. No VP9/H.264 fast path.
 *
 * Improvements over legacy path:
 *  - Parallel Sharp image scaling on startup
 *  - Parallel freeze-start + clip-scale ffmpeg steps
 *  - CRF 28 (smaller output, ~12-15MB, visually equivalent)
 *  - iPhone UI uses eof_action=repeat (no glitching)
 *  - Scrim uses explicit duration (no early cutoff)
 *  - publisher overlay uses eof_action=repeat (frame 0 correct)
 *
 * TIMING (30s @ 30fps = 900 frames):
 *   0.0 –  1.0s : Hold
 *   1.0 –  2.5s : First scroll  (ease out, 50% drift)
 *   2.5 –  4.0s : Second scroll (ease in/out, full reveal)
 *   4.0 – 27.0s : Ad plays
 *   27.0– 30.0s : Scroll out    (ease in/out)
 *
 * CLIP:
 *   Frozen first frame 0 → 4.0s
 *   Plays from 4.0s onward
 *   If clip < 26s, last frame frozen to fill remaining hold
 *
 * SCRIM:
 *   Black overlay, 70% opacity at 3.0s → 0% at 4.0s
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

// ── Canvas ───────────────────────────────────────────────────────────────────
const W           = 1080;
const H           = 2342;
const IPHONE_UI_H = 158;
const CLIP_TOP    = 158;
const CLIP_H      = H - CLIP_TOP; // 2184

// ── Timing ───────────────────────────────────────────────────────────────────
const FPS             = 30;
const TOTAL_SEC       = 30;
const TOTAL_FRAMES    = TOTAL_SEC * FPS; // 900
const CLIP_PLAY_START = 4.0;
const T_HOLD1_END     = 1.0;
const T_SCROLL1_END   = 2.5;
const T_REVEAL        = 4.0;
const T_HOLD_END      = 27.0;
const T_SCRIM_PEAK    = 3.0;
const T_SCRIM_END     = 4.0;
const CRF             = '28';

// ── Easing ───────────────────────────────────────────────────────────────────
const easeOut   = p => 1 - Math.pow(1 - p, 3);
const easeInOut = p => p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2,3)/2;

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

const probeDur = async f => parseFloat(
  (await run(FFPROBE, ['-v','error','-show_entries','format=duration',
    '-of','default=nw=1:nk=1', f])).trim());

// ── Main export ───────────────────────────────────────────────────────────────
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
  cropRect  = null,
  onProgress,
  // Legacy params accepted but ignored (WebM/H264 paths no longer used)
  publisherWebmPath,
  publisherH264Path,
}) {
  const AD_BAR_TOP_H = 41;
  const AD_BAR_BOT_H = 37;

  onProgress(5, 'Building your scene…');

  // ── Scale publisher images and bars in parallel ───────────────────────────
  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();
  const topH    = Math.round(topMeta.height * (W / topMeta.width));
  const botH    = Math.round(botMeta.height * (W / botMeta.width));

  const [topScaled, botScaled, adBarTopSc, adBarBotSc] = await Promise.all([
    sharp(publisherTopPath).resize(W, topH, { fit: 'fill' }).toBuffer(),
    sharp(publisherBottomPath).resize(W, botH, { fit: 'fill' }).toBuffer(),
    sharp(adBarTopPath).resize(W, AD_BAR_TOP_H, { fit: 'fill' }).toBuffer(),
    sharp(adBarBottomPath).resize(W, AD_BAR_BOT_H, { fit: 'fill' }).toBuffer(),
  ]);

  // ── Scroll geometry ───────────────────────────────────────────────────────
  const pubCanvasH   = topH + AD_BAR_TOP_H + (CLIP_H - AD_BAR_TOP_H - AD_BAR_BOT_H) + AD_BAR_BOT_H + botH;
  const maxScroll    = pubCanvasH - H;
  const scrollStart  = -CLIP_TOP;
  const scrollStep2  = topH - H;
  const scrollMid    = Math.round(scrollStart + 0.50 * (scrollStep2 - scrollStart));
  const scrollTarget = topH - CLIP_TOP;
  const scrollEnd    = Math.min(topH + CLIP_H - CLIP_TOP, maxScroll);

  onProgress(10, 'Building your scene…');

  // ── Compute scroll position per frame ─────────────────────────────────────
  const frameScrollY = [];
  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const t = f / FPS;
    let sy;
    if      (t <= T_HOLD1_END)   sy = scrollStart;
    else if (t <= T_SCROLL1_END) { const p = easeOut((t-T_HOLD1_END)/(T_SCROLL1_END-T_HOLD1_END));     sy = scrollStart + p*(scrollMid-scrollStart); }
    else if (t <= T_REVEAL)      { const p = easeInOut((t-T_SCROLL1_END)/(T_REVEAL-T_SCROLL1_END));     sy = scrollMid   + p*(scrollTarget-scrollMid); }
    else if (t <= T_HOLD_END)    sy = scrollTarget;
    else                         { const p = easeInOut((t-T_HOLD_END)/(TOTAL_SEC-T_HOLD_END));          sy = scrollTarget + p*(scrollEnd-scrollTarget); }
    frameScrollY.push(Math.min(Math.max(Math.round(sy), scrollStart), maxScroll));
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // ── Build unique publisher overlay frames with Sharp ──────────────────────
  const uniqueCache = new Map();
  const uniqueYs    = [...new Set(frameScrollY)];
  let built = 0;

  for (const sy of uniqueYs) {
    const barTopStart = topH;
    const gapStart    = topH + AD_BAR_TOP_H;
    const gapEnd      = gapStart + (CLIP_H - AD_BAR_TOP_H - AD_BAR_BOT_H);
    const barBotStart = gapEnd;
    const botImgStart = barBotStart + AD_BAR_BOT_H;
    const vpTop = sy, vpBot = sy + H;
    const composites = [];

    const slice = async (img, srcTop, srcBot, dstTop) => {
      const h = srcBot - srcTop;
      if (h <= 0) return;
      const buf = await sharp(img).extract({ left: 0, top: srcTop, width: W, height: h }).toBuffer();
      composites.push({ input: buf, top: dstTop, left: 0 });
    };

    await slice(topScaled,  Math.max(vpTop,0),                       Math.min(vpBot,barTopStart),   Math.max(vpTop,0)-vpTop);
    await slice(adBarTopSc, Math.max(vpTop,barTopStart)-barTopStart, Math.min(vpBot,gapStart)-barTopStart, Math.max(vpTop,barTopStart)-vpTop);
    await slice(adBarBotSc, Math.max(vpTop,barBotStart)-barBotStart, Math.min(vpBot,botImgStart)-barBotStart, Math.max(vpTop,barBotStart)-vpTop);
    await slice(botScaled,  Math.max(vpTop,botImgStart)-botImgStart, Math.min(vpBot,pubCanvasH)-botImgStart, Math.max(vpTop,botImgStart)-vpTop);

    const buf = await sharp({ create: { width: W, height: H, channels: 4, background: { r:0, g:0, b:0, alpha:0 } } })
      .composite(composites.filter(c => c.input))
      .png({ compressionLevel: 1 })
      .toBuffer();

    const fp = path.join(tmpDir, `u_${sy + pubCanvasH}.png`); // unique filename even for negative sy
    fs.writeFileSync(fp, buf);
    uniqueCache.set(sy, fp);
    built++;
    onProgress(12 + Math.round((built / uniqueYs.length) * 45), 'Building your scene…');
  }

  // ── Write frame sequence symlinks ─────────────────────────────────────────
  const seqDir = path.join(tmpDir, 'seq');
  fs.mkdirSync(seqDir);
  for (let i = 0; i < frameScrollY.length; i++) {
    fs.copyFileSync(uniqueCache.get(frameScrollY[i]), path.join(seqDir, `f${String(i).padStart(5,'0')}.png`));
  }

  // ── Scale iPhone UI ───────────────────────────────────────────────────────
  const iphoneScaled = path.join(tmpDir, 'iphone-ui.png');
  await sharp(iphoneUiPath).resize(W, IPHONE_UI_H, { fit: 'fill' }).toFile(iphoneScaled);

  onProgress(60, 'Preparing clip…');

  // ── Clip track ────────────────────────────────────────────────────────────
  const clipTrimStart = trimStart ?? 0;
  const clipTrimEnd   = trimEnd ?? await probeDur(clipPath);
  const clipDur       = clipTrimEnd - clipTrimStart;

  const firstFrame  = path.join(tmpDir, 'first-frame.png');
  const freezeStart = path.join(tmpDir, 'freeze-start.mp4');
  const clipScaled  = path.join(tmpDir, 'clip-scaled.mp4');

  await run(FFMPEG, [
    '-y', '-ss', clipTrimStart.toFixed(3), '-i', clipPath,
    '-vframes', '1', firstFrame,
  ]);

  // Freeze-start and clip-scale run in parallel
  await Promise.all([
    run(FFMPEG, [
      '-y', '-loop', '1', '-framerate', String(FPS), '-i', firstFrame,
      '-vf', `scale=${W}:${CLIP_H}:force_original_aspect_ratio=disable,setsar=1,pad=${W}:${H}:0:${CLIP_TOP}:color=black@1`,
      '-t', CLIP_PLAY_START.toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-threads', '1',
      freezeStart,
    ]),
    run(FFMPEG, [
      '-y', '-ss', clipTrimStart.toFixed(3), '-t', clipDur.toFixed(3),
      '-i', clipPath,
      '-vf', `scale=${W}:${CLIP_H}:force_original_aspect_ratio=disable,setsar=1,pad=${W}:${H}:0:${CLIP_TOP}:color=black@1`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-threads', '1',
      clipScaled,
    ]),
  ]);

  // Freeze last frame if clip shorter than the 26s hold window
  const concatParts   = [freezeStart, clipScaled];
  const clipNeededSec = TOTAL_SEC - CLIP_PLAY_START; // 26.0s

  if (clipDur < clipNeededSec) {
    const lastFrame = path.join(tmpDir, 'last-frame.png');
    await run(FFMPEG, ['-y', '-sseof', '-0.1', '-i', clipScaled, '-vframes', '1', lastFrame]);
    const freezeEnd = path.join(tmpDir, 'freeze-end.mp4');
    await run(FFMPEG, [
      '-y', '-loop', '1', '-framerate', String(FPS), '-i', lastFrame,
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=disable,setsar=1`,
      '-t', (clipNeededSec - clipDur).toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-threads', '1',
      freezeEnd,
    ]);
    concatParts.push(freezeEnd);
  }

  // Concat clip parts → full 30s track
  const concatList = path.join(tmpDir, 'clip-concat.txt');
  fs.writeFileSync(concatList, concatParts.map(f => `file '${f}'`).join('\n'));

  const fullTrack = path.join(tmpDir, 'full-track.mp4');
  await run(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-t', TOTAL_SEC.toFixed(3),
    fullTrack,
  ]);

  onProgress(75, 'Encoding…');

  // ── Final compose ─────────────────────────────────────────────────────────
  // Inputs:
  //   [0] full clip track    — H.264, yuv420p, exactly 30s
  //   [1] publisher frames   — PNG image sequence, 30fps
  //   [2] iPhone UI PNG      — static, looped
  //
  // Layer order bottom → top: clip → scrim → publisher → iPhone UI
  await run(FFMPEG, [
    '-y',
    '-i', fullTrack,
    '-framerate', String(FPS), '-r', String(FPS), '-f', 'image2', '-i', path.join(seqDir, 'f%05d.png'),
    '-loop', '1', '-framerate', String(FPS), '-i', iphoneScaled,
    '-filter_complex', [
      // Scrim: 70% black, fades out 3.0s → 4.0s
      `color=black:size=${W}x${H}:rate=${FPS}:duration=${TOTAL_SEC}[blacksrc]`,
      `[blacksrc]format=rgba,fade=t=out:st=${T_SCRIM_PEAK}:d=${T_SCRIM_END - T_SCRIM_PEAK}:alpha=1,colorchannelmixer=aa=0.70[scrim]`,
      // Publisher frames as RGBA overlay
      `[1:v]format=rgba[pub]`,
      // Composite layers
      `[0:v][scrim]overlay=x=0:y=0[clipped]`,
      `[clipped][pub]overlay=x=0:y=0:eof_action=repeat[base]`,
      // iPhone UI — static PNG held for full duration
      `[2:v]scale=${W}:${IPHONE_UI_H},pad=${W}:${H}:0:0:color=black@0[ui]`,
      `[base][ui]overlay=x=0:y=0:eof_action=repeat[out]`,
    ].join(';'),
    '-map', '[out]',
    '-t', TOTAL_SEC.toFixed(3),
    '-r', String(FPS),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', CRF, '-preset', 'ultrafast', '-threads', '1', '-movflags', '+faststart',
    outPath,
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  onProgress(100, 'Done');
}
