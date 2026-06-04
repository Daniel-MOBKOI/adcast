/**
 * Compositor v17 — Pre-built publisher WebM overlay.
 *
 * Changes from v16:
 *  - iPhone UI overlay: removed shortest=1, use eof_action=repeat so the
 *    static PNG holds for the full output duration without glitching.
 *  - Scrim overlay: removed shortest=1 to prevent early cutoff.
 *  - fullTrack concat: explicit -r and -t to lock duration before final compose.
 *  - cropRect path removed from fast path (cropTo() handles it client-side now).
 *
 * TIMING (30s @ 30fps = 900 frames) — baked into the publisher WebM:
 *   0.0 –  1.0s : Hold
 *   1.0 –  2.5s : First scroll (50% drift, ease out)
 *   2.5 –  4.0s : Second scroll (full reveal, ease in/out)
 *   4.0 – 27.0s : Ad plays
 *   27.0– 30.0s : Scroll out (ease in/out)
 *
 * CLIP:
 *   Frozen first frame 0 → 4.0s
 *   Plays from 4.0s onward
 *   If clip < 26s, last frame frozen to fill remaining hold
 *
 * SCRIM:
 *   Black overlay, 70% opacity at 3.0s → 0% at 4.0s
 *   Sits above clip, beneath publisher WebM
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

// ── Canvas ──────────────────────────────────────────────────────────────────
const W           = 1080;
const H           = 2342;
const IPHONE_UI_H = 158;
const CLIP_TOP    = 158;
const CLIP_H      = H - CLIP_TOP;  // 2184

// ── Timing ──────────────────────────────────────────────────────────────────
const FPS             = 30;
const TOTAL_SEC       = 30;
const CLIP_PLAY_START = 4.0;
const T_SCRIM_PEAK    = 3.0;
const T_SCRIM_END     = 4.0;

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

const probeDur = async f => parseFloat(
  (await run(FFPROBE, ['-v','error','-show_entries','format=duration',
    '-of','default=nw=1:nk=1', f])).trim());

export async function runCompositor({
  clipPath,
  publisherWebmPath,
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
}) {
  if (!publisherWebmPath) {
    return runCompositorLegacy({
      clipPath, publisherTopPath, publisherBottomPath,
      adBarTopPath, adBarBottomPath, iphoneUiPath,
      outPath, trimStart, trimEnd, cropRect, onProgress,
    });
  }

  onProgress(5, 'Preparing clip…');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // ── Scale iPhone UI to a PNG at exact dimensions ───────────────────────────
  const iphoneScaled = path.join(tmpDir, 'iphone-ui.png');
  await sharp(iphoneUiPath).resize(W, IPHONE_UI_H, { fit: 'fill' }).toFile(iphoneScaled);

  onProgress(10, 'Preparing clip…');

  // ── Clip track ─────────────────────────────────────────────────────────────
  const clipTrimStart = trimStart ?? 0;
  const clipTrimEnd   = trimEnd ?? await probeDur(clipPath);
  const clipDur       = clipTrimEnd - clipTrimStart;

  // Extract first frame for freeze (seek to trimStart)
  const firstFrame = path.join(tmpDir, 'first-frame.png');
  await run(FFMPEG, [
    '-y', '-ss', clipTrimStart.toFixed(3), '-i', clipPath,
    '-vframes', '1', firstFrame,
  ]);

  onProgress(15, 'Preparing clip…');

  // Freeze first frame 0 → CLIP_PLAY_START (4s)
  const freezeStart = path.join(tmpDir, 'freeze-start.mp4');
  await run(FFMPEG, [
    '-y', '-loop', '1', '-framerate', String(FPS), '-i', firstFrame,
    '-vf', `scale=${W}:${CLIP_H}:force_original_aspect_ratio=disable,setsar=1,pad=${W}:${H}:0:${CLIP_TOP}:color=black@1`,
    '-t', CLIP_PLAY_START.toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-threads', '1',
    freezeStart,
  ]);

  // Scale main clip
  const clipScaled = path.join(tmpDir, 'clip-scaled.mp4');
  await run(FFMPEG, [
    '-y', '-ss', clipTrimStart.toFixed(3), '-t', clipDur.toFixed(3),
    '-i', clipPath,
    '-vf', `scale=${W}:${CLIP_H}:force_original_aspect_ratio=disable,setsar=1,pad=${W}:${H}:0:${CLIP_TOP}:color=black@1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-threads', '1',
    clipScaled,
  ]);

  onProgress(30, 'Preparing clip…');

  // Freeze last frame if clip shorter than the 26s hold window
  const concatParts   = [freezeStart, clipScaled];
  const clipNeededSec = TOTAL_SEC - CLIP_PLAY_START; // 26.0s

  if (clipDur < clipNeededSec) {
    const lastFrame = path.join(tmpDir, 'last-frame.png');
    await run(FFMPEG, [
      '-y', '-sseof', '-0.1', '-i', clipScaled,
      '-vframes', '1', lastFrame,
    ]);
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

  // Concat all parts into full 30s clip track
  const concatList = path.join(tmpDir, 'clip-concat.txt');
  fs.writeFileSync(concatList, concatParts.map(f => `file '${f}'`).join('\n'));

  const fullTrack = path.join(tmpDir, 'full-track.mp4');
  await run(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-t', TOTAL_SEC.toFixed(3),
    fullTrack,
  ]);

  onProgress(60, 'Compositing…');

  // ── Final compose ──────────────────────────────────────────────────────────
  // Inputs:
  //   [0] full clip track     — H.264, yuv420p, exactly 30s
  //   [1] publisher WebM      — VP9+alpha, decoded with libvpx-vp9
  //   [2] iPhone UI PNG       — static, looped
  //
  // Layer order bottom → top:
  //   clip → scrim → publisher WebM → iPhone UI
  //
  // Key fixes vs v16:
  //   - No shortest=1 on scrim overlay (was cutting output early)
  //   - iPhone UI uses eof_action=repeat instead of shortest=1 (was glitching)
  //   - Explicit -t on output to hard-lock 30s duration
  const ffArgs = [
    '-y',
    '-i', fullTrack,                                    // [0] clip track
    '-vcodec', 'libvpx-vp9', '-i', publisherWebmPath,  // [1] publisher WebM
    '-loop', '1', '-framerate', String(FPS), '-i', iphoneScaled, // [2] iPhone UI
    '-filter_complex', [
      // Scrim: black, fades 70% → 0% opacity between T_SCRIM_PEAK and T_SCRIM_END
      `color=black:size=${W}x${H}:rate=${FPS}:duration=${TOTAL_SEC}[blacksrc]`,
      `[blacksrc]format=rgba,fade=t=out:st=${T_SCRIM_PEAK}:d=${T_SCRIM_END - T_SCRIM_PEAK}:alpha=1,colorchannelmixer=aa=0.70[scrim]`,
      // clip + scrim (no shortest — both are 30s)
      `[0:v][scrim]overlay=x=0:y=0[clipped]`,
      // publisher WebM overlay (alpha composited)
      `[1:v]format=rgba[pub]`,
      `[clipped][pub]overlay=x=0:y=0:shortest=1[base]`,
      // iPhone UI — eof_action=repeat keeps static PNG locked for full duration
      `[2:v]scale=${W}:${IPHONE_UI_H},pad=${W}:${H}:0:0:color=black@0[ui]`,
      `[base][ui]overlay=x=0:y=0:eof_action=repeat[out]`,
    ].join(';'),
    '-map', '[out]',
    '-t', TOTAL_SEC.toFixed(3),
    '-r', String(FPS),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '20', '-preset', 'ultrafast', '-threads', '1', '-movflags', '+faststart',
    outPath,
  ];

  await run(FFMPEG, ffArgs);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  onProgress(100, 'Done');
}

// ── Legacy compositor — Sharp frame-by-frame, for uploaded publishers ────────
async function runCompositorLegacy({
  clipPath, publisherTopPath, publisherBottomPath,
  adBarTopPath, adBarBottomPath, iphoneUiPath,
  outPath, trimStart = 0, trimEnd = null, cropRect = null, onProgress,
}) {
  const AD_BAR_TOP_H = 41;
  const AD_BAR_BOT_H = 37;
  const CREATIVE_TOP = 158;
  const FPS_L        = 30;
  const TOTAL_SEC_L  = 30;
  const TOTAL_FRAMES_L = TOTAL_SEC_L * FPS_L;
  const T_HOLD1_END_L   = 1.0;
  const T_SCROLL1_END_L = 2.5;
  const T_REVEAL_L      = 4.0;
  const T_HOLD_END_L    = 27.0;
  const T_END_L         = 30.0;
  const T_SCRIM_PEAK_L  = 3.0;
  const T_SCRIM_END_L   = 4.0;
  const CLIP_PLAY_START_L = T_REVEAL_L;

  const easeOut_L   = p => 1 - Math.pow(1 - p, 3);
  const easeInOut_L = p => p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2,3)/2;

  onProgress(5, 'Building your scene…');

  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();
  const topH    = Math.round(topMeta.height * (W / topMeta.width));
  const botH    = Math.round(botMeta.height * (W / botMeta.width));

  const topScaled  = await sharp(publisherTopPath).resize(W,topH,{fit:'fill'}).toBuffer();
  const botScaled  = await sharp(publisherBottomPath).resize(W,botH,{fit:'fill'}).toBuffer();
  const adBarTopSc = await sharp(adBarTopPath).resize(W,AD_BAR_TOP_H,{fit:'fill'}).toBuffer();
  const adBarBotSc = await sharp(adBarBottomPath).resize(W,AD_BAR_BOT_H,{fit:'fill'}).toBuffer();

  const pubCanvasH  = topH + AD_BAR_TOP_H + (CLIP_H - AD_BAR_TOP_H - AD_BAR_BOT_H) + AD_BAR_BOT_H + botH;
  const maxScroll   = pubCanvasH - H;
  const scrollStart = -CREATIVE_TOP;
  const scrollStep2 = topH - H;
  const scrollMid   = Math.round(scrollStart + 0.50 * (scrollStep2 - scrollStart));
  const scrollTarget = topH - CLIP_TOP;
  const scrollEnd   = Math.min(topH + CLIP_H - CLIP_TOP, maxScroll);

  onProgress(10, 'Building your scene…');

  const frameScrollY = [];
  for (let f = 0; f < TOTAL_FRAMES_L; f++) {
    const t = f / FPS_L;
    let sy;
    if      (t <= T_HOLD1_END_L)   sy = scrollStart;
    else if (t <= T_SCROLL1_END_L) { const p = easeOut_L((t-T_HOLD1_END_L)/(T_SCROLL1_END_L-T_HOLD1_END_L)); sy = scrollStart + p*(scrollMid-scrollStart); }
    else if (t <= T_REVEAL_L)      { const p = easeInOut_L((t-T_SCROLL1_END_L)/(T_REVEAL_L-T_SCROLL1_END_L)); sy = scrollMid + p*(scrollTarget-scrollMid); }
    else if (t <= T_HOLD_END_L)    sy = scrollTarget;
    else                           { const p = easeInOut_L((t-T_HOLD_END_L)/(T_END_L-T_HOLD_END_L)); sy = scrollTarget + p*(scrollEnd-scrollTarget); }
    frameScrollY.push(Math.min(Math.max(Math.round(sy), scrollStart), maxScroll));
  }

  const tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
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
      const buf = await sharp(img).extract({ left:0, top:srcTop, width:W, height:h }).toBuffer();
      composites.push({ input: buf, top: dstTop, left: 0 });
    };
    await slice(topScaled,  Math.max(vpTop,0),            Math.min(vpBot,barTopStart),  Math.max(vpTop,0)-vpTop);
    await slice(adBarTopSc, Math.max(vpTop,barTopStart)-barTopStart, Math.min(vpBot,gapStart)-barTopStart, Math.max(vpTop,barTopStart)-vpTop);
    await slice(adBarBotSc, Math.max(vpTop,barBotStart)-barBotStart, Math.min(vpBot,botImgStart)-barBotStart, Math.max(vpTop,barBotStart)-vpTop);
    await slice(botScaled,  Math.max(vpTop,botImgStart)-botImgStart, Math.min(vpBot,pubCanvasH)-botImgStart, Math.max(vpTop,botImgStart)-vpTop);
    const buf = await sharp({ create:{width:W,height:H,channels:4,background:{r:0,g:0,b:0,alpha:0}} })
      .composite(composites.filter(c=>c.input)).png({compressionLevel:1}).toBuffer();
    const fp = path.join(tmpDir, `u_${sy}.png`);
    fs.writeFileSync(fp, buf);
    uniqueCache.set(sy, fp);
    built++;
    onProgress(12 + Math.round((built/uniqueYs.length)*55), 'Building your scene…');
  }

  const seqDir = path.join(tmpDir, 'seq');
  fs.mkdirSync(seqDir);
  for (let i = 0; i < frameScrollY.length; i++) {
    fs.copyFileSync(uniqueCache.get(frameScrollY[i]), path.join(seqDir, `f${String(i).padStart(5,'0')}.png`));
  }

  const iphoneScaled = path.join(tmpDir, 'iphone-ui.png');
  await sharp(iphoneUiPath).resize(W, IPHONE_UI_H, { fit:'fill' }).toFile(iphoneScaled);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const clipTrimStart = trimStart ?? 0;
  const clipTrimEnd   = trimEnd ?? await probeDur(clipPath);
  const clipDur       = clipTrimEnd - clipTrimStart;
  let sourceClip = clipPath;
  if (cropRect) {
    const probeOut2 = await run(FFPROBE, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',clipPath]);
    const [vw2, vh2] = probeOut2.trim().split(',').map(Number);
    const cx2 = Math.max(0, Math.min(cropRect.x, vw2 - 2));
    const cy2 = Math.max(0, Math.min(cropRect.y, vh2 - 2));
    const cw2 = Math.min(cropRect.width,  vw2 - cx2);
    const ch2 = Math.min(cropRect.height, vh2 - cy2);
    const ew2 = cw2 % 2 === 0 ? cw2 : cw2 - 1;
    const eh2 = ch2 % 2 === 0 ? ch2 : ch2 - 1;
    if (ew2 > 0 && eh2 > 0) {
      const croppedClip = path.join(tmpDir, 'clip-cropped.webm');
      await run(FFMPEG, ['-y','-i',clipPath,'-vf',`crop=${ew2}:${eh2}:${cx2}:${cy2}`,'-c:v','libvpx','-b:v','4M','-threads','1',croppedClip]);
      sourceClip = croppedClip;
    }
  }

  const firstFrame = path.join(tmpDir, 'first-frame.png');
  await run(FFMPEG, ['-y','-ss',clipTrimStart.toFixed(3),'-i',sourceClip,'-vframes','1',firstFrame]);

  const freezeStart = path.join(tmpDir, 'freeze-start.mp4');
  await run(FFMPEG, ['-y','-loop','1','-framerate',String(FPS_L),'-i',firstFrame,
    '-vf',`scale=${W}:${CLIP_H}:force_original_aspect_ratio=disable,setsar=1,pad=${W}:${H}:0:${CLIP_TOP}:color=black@1`,
    '-t',CLIP_PLAY_START_L.toFixed(3),'-c:v','libx264','-pix_fmt','yuv420p','-r',String(FPS_L),'-threads','1',freezeStart]);

  const clipScaled = path.join(tmpDir, 'clip-scaled.mp4');
  await run(FFMPEG, ['-y','-ss',clipTrimStart.toFixed(3),'-t',clipDur.toFixed(3),'-i',sourceClip,
    '-vf',`scale=${W}:${CLIP_H}:force_original_aspect_ratio=disable,setsar=1,pad=${W}:${H}:0:${CLIP_TOP}:color=black@1`,
    '-c:v','libx264','-pix_fmt','yuv420p','-r',String(FPS_L),'-threads','1',clipScaled]);

  const concatParts = [freezeStart, clipScaled];
  const clipNeededSec = TOTAL_SEC_L - CLIP_PLAY_START_L;
  if (clipDur < clipNeededSec) {
    const lastFrame = path.join(tmpDir, 'last-frame.png');
    await run(FFMPEG, ['-y','-sseof','-0.1','-i',clipScaled,'-vframes','1',lastFrame]);
    const freezeEnd = path.join(tmpDir, 'freeze-end.mp4');
    await run(FFMPEG, ['-y','-loop','1','-framerate',String(FPS_L),'-i',lastFrame,
      '-vf',`scale=${W}:${H}:force_original_aspect_ratio=disable,setsar=1`,
      '-t',(clipNeededSec-clipDur).toFixed(3),'-c:v','libx264','-pix_fmt','yuv420p','-r',String(FPS_L),'-threads','1',freezeEnd]);
    concatParts.push(freezeEnd);
  }

  const concatList = path.join(tmpDir, 'clip-concat.txt');
  fs.writeFileSync(concatList, concatParts.map(f=>`file '${f}'`).join('\n'));

  const fullTrack = path.join(tmpDir, 'full-track.mp4');
  await run(FFMPEG, ['-y','-f','concat','-safe','0','-i',concatList,
    '-c:v','libx264','-pix_fmt','yuv420p','-r',String(FPS_L),'-t',TOTAL_SEC_L.toFixed(3),fullTrack]);

  onProgress(69, 'Encoding…');

  await run(FFMPEG, [
    '-y',
    '-i', fullTrack,
    '-framerate', String(FPS_L), '-r', String(FPS_L), '-f', 'image2', '-i', path.join(seqDir, 'f%05d.png'),
    '-loop', '1', '-framerate', String(FPS_L), '-i', iphoneScaled,
    '-filter_complex', [
      `color=black:size=${W}x${H}:rate=${FPS_L}:duration=${TOTAL_SEC_L}[blacksrc]`,
      `[blacksrc]format=rgba,fade=t=out:st=${T_SCRIM_PEAK_L}:d=${T_SCRIM_END_L-T_SCRIM_PEAK_L}:alpha=1,colorchannelmixer=aa=0.70[scrim]`,
      `[1:v]format=rgba[pub]`,
      `[0:v][scrim]overlay=x=0:y=0[clipped]`,
      `[clipped][pub]overlay=x=0:y=0:shortest=1[base]`,
      `[2:v]scale=${W}:${IPHONE_UI_H},pad=${W}:${H}:0:0:color=black@0[ui]`,
      `[base][ui]overlay=x=0:y=0:eof_action=repeat[out]`,
    ].join(';'),
    '-map', '[out]', '-t', TOTAL_SEC_L.toFixed(3), '-r', String(FPS_L),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'ultrafast', '-threads', '1', '-movflags', '+faststart',
    outPath,
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  onProgress(100, 'Done');
}
