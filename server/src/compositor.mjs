/**
 * Compositor v15 — Smooth two-phase scroll, no hold freeze.
 *
 * TIMING (30s total @ 30fps = 900 frames):
 *   0.0 –  2.5s : First scroll  — gentle drift ~20% toward ad (ease out)
 *   2.5 –  5.0s : Second scroll — full reveal to scrollTarget (ease in/out)
 *   5.0 – 27.0s : Ad plays — scroll rests at scrollTarget (no hard freeze)
 *   27.0– 30.0s : Scroll out (ease in/out)
 *
 * CLIP:
 *   Frozen first frame 0 → 2.5s (publisher covering ad anyway)
 *   Plays from 2.5s onward
 *   If clip < 24.5s, last frame frozen to fill to 27s
 *   Hard cut at 30s
 *
 * NO HOLD FREEZE on scroll — easing curves arrive at destination naturally.
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

// ── Canvas ─────────────────────────────────────────────────────────────────────
const W            = 1080;
const H            = 2342;
const IPHONE_UI_H  = 158;
const AD_BAR_TOP_H = 41;
const AD_BAR_BOT_H = 37;
const CREATIVE_TOP = 158;
const CREATIVE_H   = 2184;
const CLIP_TOP     = CREATIVE_TOP;
const CLIP_H       = H - CLIP_TOP;   // 2184

// ── Timing ─────────────────────────────────────────────────────────────────────
const FPS          = 30;
const TOTAL_SEC    = 30;
const TOTAL_FRAMES = TOTAL_SEC * FPS; // 900

// Phase boundaries
const T_HOLD1_END   = 1.0;   // initial hold ends
const T_SCROLL1_END = 2.5;   // first scroll ends (35% drift)
const T_REVEAL      = 4.0;   // second scroll ends — ad fully revealed
const T_HOLD_END    = 27.0;  // scroll-out begins
const T_END         = 30.0;

// Scrim: dark overlay above clip, beneath publisher/bars/UI
const T_SCRIM_PEAK  = 3.0;   // 70% opacity
const T_SCRIM_END   = 4.0;   // fades to 0% (matches T_REVEAL)


// Clip starts playing when first scroll ends (no point showing frozen frame through publisher)
const CLIP_PLAY_START = T_REVEAL;                  // 4.0s
const CLIP_NEEDED     = T_END - CLIP_PLAY_START;   // 26.0s
const CLIP_HOLD_DUR   = T_HOLD_END - CLIP_PLAY_START; // 23.0s of clip needed before scroll-out

// ── Easing ─────────────────────────────────────────────────────────────────────
const easeOut   = p => 1 - Math.pow(1 - p, 3);
const easeInOut = p => p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2,3)/2;

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

const probeDur = async f => parseFloat(
  (await run(FFPROBE, ['-v','error','-show_entries','format=duration',
    '-of','default=nw=1:nk=1', f])).trim());

// ── Publisher overlay frame builder ───────────────────────────────────────────
async function buildFrame({ scrollY, topImg, topH, botImg, botH,
                             adBarTop, adBarBot, pubCanvasH }) {
  const barTopStart = topH;
  const gapStart    = topH + AD_BAR_TOP_H;
  const gapEnd      = gapStart + (CLIP_H - AD_BAR_TOP_H - AD_BAR_BOT_H);
  const barBotStart = gapEnd;
  const botImgStart = barBotStart + AD_BAR_BOT_H;

  const vpTop = scrollY;
  const vpBot = scrollY + H;
  const composites = [];

  const slice = async (img, srcTop, srcBot, dstTop) => {
    const h = srcBot - srcTop;
    if (h <= 0) return;
    const buf = await sharp(img).extract({ left:0, top:srcTop, width:W, height:h }).toBuffer();
    composites.push({ input: buf, top: dstTop, left: 0 });
  };

  await slice(topImg,   Math.max(vpTop,0),           Math.min(vpBot,barTopStart),  Math.max(vpTop,0) - vpTop);
  await slice(adBarTop, Math.max(vpTop,barTopStart)-barTopStart, Math.min(vpBot,gapStart)-barTopStart, Math.max(vpTop,barTopStart) - vpTop);
  await slice(adBarBot, Math.max(vpTop,barBotStart)-barBotStart, Math.min(vpBot,botImgStart)-barBotStart, Math.max(vpTop,barBotStart) - vpTop);
  await slice(botImg,   Math.max(vpTop,botImgStart)-botImgStart, Math.min(vpBot,pubCanvasH)-botImgStart, Math.max(vpTop,botImgStart) - vpTop);

  return sharp({
    create: { width:W, height:H, channels:4, background:{ r:0,g:0,b:0,alpha:0 } }
  })
  .composite(composites.filter(c => c.input))
  .png({ compressionLevel: 1 })
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
  cropRect  = null,
  onProgress,
}) {
  onProgress(5, 'Building your scene…');

  // ── Scale assets ────────────────────────────────────────────────────────────
  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();
  const topH    = Math.round(topMeta.height * (W / topMeta.width));
  const botH    = Math.round(botMeta.height * (W / botMeta.width));

  const topScaled  = await sharp(publisherTopPath).resize(W,topH,{fit:'fill'}).toBuffer();
  const botScaled  = await sharp(publisherBottomPath).resize(W,botH,{fit:'fill'}).toBuffer();
  const adBarTopSc = await sharp(adBarTopPath).resize(W,AD_BAR_TOP_H,{fit:'fill'}).toBuffer();
  const adBarBotSc = await sharp(adBarBottomPath).resize(W,AD_BAR_BOT_H,{fit:'fill'}).toBuffer();

  const pubCanvasH = topH + AD_BAR_TOP_H + (CLIP_H - AD_BAR_TOP_H - AD_BAR_BOT_H) + AD_BAR_BOT_H + botH;

  onProgress(10, 'Building your scene…');

  // ── Scroll positions ────────────────────────────────────────────────────────
  const maxScroll    = pubCanvasH - H;
  const scrollStart  = -CREATIVE_TOP;          // -158 — article top at y=158, below UI
  const scrollStep2  = topH - H;               // ADVERTISEMENT bar just enters bottom of viewport

  // Intermediate: only 20% of the way from scrollStart to scrollStep2
  // This gives a gentle hint of the ad without revealing the bar too early
  const scrollMid    = Math.round(scrollStart + 0.50 * (scrollStep2 - scrollStart));

  const scrollTarget = topH - CLIP_TOP;        // ADVERTISEMENT at y=158, fully revealed
  const scrollEnd    = Math.min(topH + CLIP_H - CLIP_TOP, maxScroll);

  // ── Per-frame scroll Y ──────────────────────────────────────────────────────
  const frameScrollY = [];

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const t = f / FPS;
    let sy;

    if (t <= T_HOLD1_END) {
      // Phase 1: initial hold — no movement, article sits at scrollStart
      sy = scrollStart;

    } else if (t <= T_SCROLL1_END) {
      // Phase 2: first scroll — gentle 35% drift toward ad (ease out)
      const p = easeOut((t - T_HOLD1_END) / (T_SCROLL1_END - T_HOLD1_END));
      sy = scrollStart + p * (scrollMid - scrollStart);

    } else if (t <= T_REVEAL) {
      // Phase 3: second scroll — full reveal scrollMid → scrollTarget (ease in/out)
      const p = easeInOut((t - T_SCROLL1_END) / (T_REVEAL - T_SCROLL1_END));
      sy = scrollMid + p * (scrollTarget - scrollMid);

    } else if (t <= T_HOLD_END) {
      // Phase 4: ad plays — rests at scrollTarget
      sy = scrollTarget;

    } else {
      // Phase 5: scroll out — scrollTarget → scrollEnd (ease in/out)
      const p = easeInOut((t - T_HOLD_END) / (T_END - T_HOLD_END));
      sy = scrollTarget + p * (scrollEnd - scrollTarget);
    }

    frameScrollY.push(Math.min(Math.max(Math.round(sy), scrollStart), maxScroll));
  }

  // ── Per-frame scrim alpha (0–255) ──────────────────────────────────────────
  // Dark overlay sits above the clip, beneath publisher/ad-bars/iPhone UI.
  // Fades in during scroll, peaks at T_SCRIM_PEAK, fully gone by T_SCRIM_END.
  const frameScrimAlpha = [];
  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const t = f / FPS;
    let alpha = 0;
    if (t >= T_SCRIM_PEAK && t <= T_SCRIM_END) {
      // Linear fade out: 70% → 0% over 1 second
      const p = (t - T_SCRIM_PEAK) / (T_SCRIM_END - T_SCRIM_PEAK);
      alpha = Math.round(0.70 * 255 * (1 - p));
    } else if (t < T_SCRIM_PEAK) {
      // Before peak: not needed for current timing (scrim appears at peak)
      alpha = 0;
    }
    frameScrimAlpha.push(alpha);
  }

  // ── Build publisher overlay frames ──────────────────────────────────────────
  onProgress(12, 'Building your scene…');

  const tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  const uniqueCache = new Map();
  const uniqueYs    = [...new Set(frameScrollY)];
  let   built       = 0;

  // Unique scrim buffers keyed by alpha value
  const scrimCache  = new Map();
  const uniqueAlphas = [...new Set(frameScrimAlpha)];
  for (const alpha of uniqueAlphas) {
    if (alpha === 0) { scrimCache.set(0, null); continue; } // transparent — skip composite
    const buf = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha } }
    }).png({ compressionLevel: 1 }).toBuffer();
    scrimCache.set(alpha, buf);
  }

  for (const sy of uniqueYs) {
    const fp  = path.join(tmpDir, `u_${sy}.png`);
    const buf = await buildFrame({
      scrollY: sy, topImg:topScaled, topH,
      botImg:botScaled, botH,
      adBarTop:adBarTopSc, adBarBot:adBarBotSc, pubCanvasH,
    });
    fs.writeFileSync(fp, buf);
    uniqueCache.set(sy, fp);
    built++;
    onProgress(12 + Math.round((built/uniqueYs.length)*55), 'Building your scene…');
  }

  const frameFiles = frameScrollY.map(sy => uniqueCache.get(sy));

  // ── Numbered sequence for image2 ────────────────────────────────────────────
  onProgress(69, 'Encoding…');

  const seqDir = path.join(tmpDir, 'seq');
  fs.mkdirSync(seqDir);
  for (let i = 0; i < frameFiles.length; i++) {
    const scrimAlpha = frameScrimAlpha[i];
    const scrimBuf   = scrimCache.get(scrimAlpha);
    if (scrimBuf) {
      // Composite scrim above clip frame (publisher frame is transparent in clip area)
      // We bake the scrim into the clip track instead — insert as overlay in ffmpeg filter
      // Store scrim alpha for this frame so ffmpeg can apply it
    }
    fs.copyFileSync(frameFiles[i], path.join(seqDir, `f${String(i).padStart(5,'0')}.png`));
  }

  // Write scrim frames as separate image sequence for ffmpeg overlay
  const scrimDir = path.join(tmpDir, 'scrim');
  fs.mkdirSync(scrimDir);
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const alpha    = frameScrimAlpha[i];
    const scrimBuf = scrimCache.get(alpha);
    const scrimPath = path.join(scrimDir, `s${String(i).padStart(5,'0')}.png`);
    if (scrimBuf) {
      fs.writeFileSync(scrimPath, scrimBuf);
    } else {
      // Fully transparent frame
      const emptyBuf = await sharp({
        create: { width: W, height: H, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
      }).png({ compressionLevel: 1 }).toBuffer();
      fs.writeFileSync(scrimPath, emptyBuf);
    }
  }

  const iphoneScaled = path.join(tmpDir, 'iphone-ui.png');
  await sharp(iphoneUiPath).resize(W, IPHONE_UI_H, { fit:'fill' }).toFile(iphoneScaled);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // ── Build clip track ────────────────────────────────────────────────────────
  const clipTrimStart = trimStart ?? 0;
  const clipTrimEnd   = trimEnd ?? await probeDur(clipPath);
  const clipDur       = clipTrimEnd - clipTrimStart;

  // ── Crop raw recording if cropRect provided ──────────────────────────────────
  let sourceClip = clipPath;
  if (cropRect) {
    const croppedClip = path.join(tmpDir, 'clip-cropped.webm');
    const { x, y, width, height } = cropRect;
    await run(FFMPEG, [
      '-y', '-i', clipPath,
      '-vf', `crop=${width}:${height}:${x}:${y}`,
      '-c:v', 'copy',
      croppedClip,
    ]);
    sourceClip = croppedClip;
  }

  // Extract first frame (freeze before clip plays)
  const firstFrame = path.join(tmpDir, 'first-frame.png');
  await run(FFMPEG, [
    '-y', '-ss', clipTrimStart.toFixed(3), '-i', sourceClip,
    '-vframes', '1', firstFrame,
  ]);

  // Freeze first frame 0 → CLIP_PLAY_START
  const freezeStart = path.join(tmpDir, 'freeze-start.mp4');
  await run(FFMPEG, [
    '-y', '-loop', '1', '-framerate', String(FPS),
    '-i', firstFrame,
    '-vf', `scale=${W}:${CLIP_H},pad=${W}:${H}:0:${CLIP_TOP}:color=black`,
    '-t', CLIP_PLAY_START.toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    freezeStart,
  ]);

  // Scale main clip
  const clipScaled = path.join(tmpDir, 'clip-scaled.mp4');
  await run(FFMPEG, [
    '-y', '-ss', clipTrimStart.toFixed(3), '-t', clipDur.toFixed(3),
    '-i', sourceClip,
    '-vf', `scale=${W}:${CLIP_H},pad=${W}:${H}:0:${CLIP_TOP}:color=black`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    clipScaled,
  ]);

  // If clip shorter than needed, freeze last frame to fill
  const concatParts = [freezeStart, clipScaled];
  const clipNeededSec = T_END - CLIP_PLAY_START; // 26.0s

  if (clipDur < clipNeededSec) {
    const lastFrame = path.join(tmpDir, 'last-frame.png');
    await run(FFMPEG, [
      '-y', '-sseof', '-0.1', '-i', clipScaled,
      '-vframes', '1', lastFrame,
    ]);
    const freezeEnd = path.join(tmpDir, 'freeze-end.mp4');
    const freezeDur = clipNeededSec - clipDur;
    await run(FFMPEG, [
      '-y', '-loop', '1', '-framerate', String(FPS),
      '-i', lastFrame,
      '-vf', `scale=${W}:${H}`,  // already padded — just lock canvas size
      '-t', freezeDur.toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      freezeEnd,
    ]);
    concatParts.push(freezeEnd);
  }

  // Concat clip parts → full track
  const concatList = path.join(tmpDir, 'clip-concat.txt');
  fs.writeFileSync(concatList, concatParts.map(f => `file '${f}'`).join('\n'));

  const fullTrack = path.join(tmpDir, 'full-track.mp4');
  await run(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', TOTAL_SEC.toFixed(3),
    fullTrack,
  ]);

  // ── Final compose ────────────────────────────────────────────────────────────
  const ffArgs = [
    '-y',
    '-i', fullTrack,                                                           // [0] clip
    '-loop', '1', '-i', iphoneScaled,                                          // [1] iPhone UI
    '-framerate', String(FPS), '-r', String(FPS), '-f', 'image2',
    '-i', path.join(scrimDir, 's%05d.png'),                                   // [2] scrim
    '-framerate', String(FPS), '-r', String(FPS), '-f', 'image2',
    '-i', path.join(seqDir, 'f%05d.png'),                                     // [3] publisher
    '-filter_complex', [
      `[3:v]format=rgba[pub]`,
      `[2:v]format=rgba[scrim]`,
      `[0:v][scrim]overlay=x=0:y=0:shortest=1[clipped]`,
      `[clipped][pub]overlay=x=0:y=0:shortest=1[base]`,
      `[1:v]scale=${W}:${IPHONE_UI_H}[ui]`,
      `[base][ui]overlay=x=0:y=0:shortest=1[out]`,
    ].join(';'),
    '-map', '[out]',
    '-t', TOTAL_SEC.toFixed(3),
    '-r', String(FPS),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'fast', '-movflags', '+faststart',
    outPath,
  ];

  await run(FFMPEG, ffArgs);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  onProgress(100, 'Done');
}
