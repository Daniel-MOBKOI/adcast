/**
 * Compositor v13 — Pixel-perfect timing from step mockups.
 *
 * TIMING (30s total @ 30fps = 900 frames):
 *   0.0 – 1.5s : First scroll  — article scrolls to show ad bar entering at bottom
 *   1.5 – 1.9s : Hesitation    — natural finger pause
 *   1.9 – 3.0s : Second scroll — ad fully revealed (ADVERTISEMENT bar at top of creative)
 *   3.0 – 27.0s: Hold          — ad plays, both bars visible
 *   27.0– 30.0s: Scroll out    — bottom publisher covers ad
 *
 * CLIP:
 *   Frame 0 frozen until 1.5s (publisher covering clip anyway)
 *   Plays from 1.5s onward
 *   If clip < 24s, last frame frozen to fill hold period
 *   If clip > 27s, plays continuously, scroll-out covers it
 *   Hard cut at 30s
 *
 * SCROLL POSITIONS:
 *   Start   : scrollY = -CREATIVE_TOP (-158)    article top at viewport y=158, below UI
 *   Step 2  : scrollY = topH - H                ADVERTISEMENT bar just enters bottom of viewport
 *   Target  : scrollY = topH - CREATIVE_TOP     ADVERTISEMENT at y=158, SCROLL TO CONT at y=2305
 *   End     : scrollY = topH + CLIP_H + AD_BAR_TOP_H - CREATIVE_TOP
 *
 * PUBLISHER CANVAS LAYOUT:
 *   [topH]        publisher top image
 *   [41px]        ADVERTISEMENT bar
 *   [2106px]      gap (transparent)   ← ad clip shows through (CLIP_H, bars excluded)
 *   [37px]        SCROLL TO CONTINUE bar
 *   [botH]        publisher bottom image
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

// ── Canvas ────────────────────────────────────────────────────────────────────
const W            = 1080;
const H            = 2342;   // total canvas height
const IPHONE_UI_H  = 158;
const AD_BAR_TOP_H = 41;
const AD_BAR_BOT_H = 37;
const CREATIVE_TOP = 158;    // = IPHONE_UI_H — top of content area (below status bar)
const CREATIVE_H   = 2184;   // total content area height (UI to bottom)
const CLIP_TOP     = CREATIVE_TOP + AD_BAR_TOP_H;  // 199 — clip starts below ADVERTISEMENT bar
const CLIP_H       = CREATIVE_H - AD_BAR_TOP_H - AD_BAR_BOT_H;  // 2106 — clip height (bars excluded)

// ── Timing ────────────────────────────────────────────────────────────────────
const FPS           = 30;
const TOTAL_SEC     = 30;
const TOTAL_FRAMES  = TOTAL_SEC * FPS; // 900

const T_SCROLL1_END = 1.5;   // first scroll ends
const T_PAUSE_END   = 1.9;   // hesitation ends
const T_REVEAL      = 3.0;   // ad fully revealed
const T_HOLD_END    = 27.0;  // hold ends, scroll out begins
const T_END         = 30.0;  // animation ends

// Clip: freeze first frame until T_SCROLL1_END, then play
const CLIP_PLAY_START = T_SCROLL1_END;   // 1.5s
const CLIP_HOLD_DUR   = T_HOLD_END - CLIP_PLAY_START; // 25.5s of clip needed
const MIN_CLIP_SEC    = 24.0;  // minimum recording — freeze last frame if shorter

// ── Easing ────────────────────────────────────────────────────────────────────
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
  const gapEnd      = gapStart + CLIP_H;
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

  // Publisher top
  await slice(topImg,   Math.max(vpTop,0),          Math.min(vpBot,barTopStart),
                        Math.max(vpTop,0) - vpTop);

  // Ad bar top (overlaps into gap)
  await slice(adBarTop, Math.max(vpTop,barTopStart)-barTopStart,
                        Math.min(vpBot,gapStart)-barTopStart,
                        Math.max(vpTop,barTopStart) - vpTop);

  // Gap = transparent — nothing to composite

  // Ad bar bottom (overlaps into gap from below)
  await slice(adBarBot, Math.max(vpTop,barBotStart)-barBotStart,
                        Math.min(vpBot,botImgStart)-barBotStart,
                        Math.max(vpTop,barBotStart) - vpTop);

  // Publisher bottom
  await slice(botImg,   Math.max(vpTop,botImgStart)-botImgStart,
                        Math.min(vpBot,pubCanvasH)-botImgStart,
                        Math.max(vpTop,botImgStart) - vpTop);

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
  onProgress,
}) {
  onProgress(5, 'Building your scene…');

  // ── Scale assets ──────────────────────────────────────────────────────────
  const topMeta = await sharp(publisherTopPath).metadata();
  const botMeta = await sharp(publisherBottomPath).metadata();
  const topH    = Math.round(topMeta.height * (W / topMeta.width));
  const botH    = Math.round(botMeta.height * (W / botMeta.width));

  const topScaled  = await sharp(publisherTopPath).resize(W,topH,{fit:'fill'}).toBuffer();
  const botScaled  = await sharp(publisherBottomPath).resize(W,botH,{fit:'fill'}).toBuffer();
  const adBarTopSc = await sharp(adBarTopPath).resize(W,AD_BAR_TOP_H,{fit:'fill'}).toBuffer();
  const adBarBotSc = await sharp(adBarBottomPath).resize(W,AD_BAR_BOT_H,{fit:'fill'}).toBuffer();

  const pubCanvasH = topH + AD_BAR_TOP_H + CLIP_H + AD_BAR_BOT_H + botH;

  onProgress(10, 'Building your scene…');

  // ── Scroll positions ──────────────────────────────────────────────────────
  // scrollY = publisher canvas Y that maps to viewport y=0.
  // Negative scrollY shifts the publisher DOWN — article top appears below the UI overlay.
  //
  //   Start   : -CREATIVE_TOP (-158)   article top at viewport y=158, just below UI
  //   Step2   : topH - H               ADVERTISEMENT bar just enters bottom of viewport
  //   Target  : topH - CREATIVE_TOP + AD_BAR_TOP_H
  //             ADVERTISEMENT spans viewport y=117-158 (overlaps UI zone, still readable)
  //             SCROLL TO CONTINUE flush at viewport bottom y=2305-2342
  //   End     : topH + CREATIVE_H + AD_BAR_TOP_H + AD_BAR_BOT_H - CREATIVE_TOP
  //             bottom publisher image covers ad
  const maxScroll    = pubCanvasH - H;
  const scrollStart  = -CREATIVE_TOP;                                              // -158
  const scrollStep2  = topH - H;                                                   // 1297
  const scrollTarget = topH - CREATIVE_TOP;                                        // ADVERTISEMENT top flush at viewport y=158, SCROLL TO CONT flush at y=2305
  const scrollEnd    = Math.min(topH + AD_BAR_TOP_H + CLIP_H + AD_BAR_BOT_H - CREATIVE_TOP, maxScroll);

  // ── Per-frame scroll Y ────────────────────────────────────────────────────
  const frameScrollY = [];

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const t = f / FPS;
    let sy = scrollStart;

    if (t <= T_SCROLL1_END) {
      // First scroll: scrollStart → scrollStep2, ease out
      const p = easeOut(t / T_SCROLL1_END);
      sy = Math.round(scrollStart + p * (scrollStep2 - scrollStart));
    } else if (t <= T_PAUSE_END) {
      // Hesitation: nearly still, tiny drift
      const p = (t - T_SCROLL1_END) / (T_PAUSE_END - T_SCROLL1_END);
      sy = scrollStep2 + Math.round(p * (scrollTarget - scrollStep2) * 0.03);
    } else if (t <= T_REVEAL) {
      // Second scroll: scrollStep2 → scrollTarget, ease in/out
      const p = easeInOut((t - T_PAUSE_END) / (T_REVEAL - T_PAUSE_END));
      sy = Math.round(scrollStep2 + p * (scrollTarget - scrollStep2));
    } else if (t <= T_HOLD_END) {
      // Hold
      sy = scrollTarget;
    } else {
      // Scroll out: scrollTarget → scrollEnd, ease in/out
      const p = easeInOut((t - T_HOLD_END) / (T_END - T_HOLD_END));
      sy = Math.round(scrollTarget + p * (scrollEnd - scrollTarget));
    }

    frameScrollY.push(Math.min(Math.max(sy, scrollStart), maxScroll));
  }

  // ── Build publisher overlay frames ────────────────────────────────────────
  onProgress(12, 'Building your scene…');

  const tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  const uniqueCache = new Map();
  const uniqueYs    = [...new Set(frameScrollY)];
  let   built       = 0;

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

  // ── Numbered sequence for image2 ─────────────────────────────────────────
  onProgress(69, 'Encoding…');

  const seqDir = path.join(tmpDir, 'seq');
  fs.mkdirSync(seqDir);
  for (let i = 0; i < frameFiles.length; i++) {
    fs.copyFileSync(frameFiles[i], path.join(seqDir, `f${String(i).padStart(5,'0')}.png`));
  }

  const iphoneScaled = path.join(tmpDir, 'iphone-ui.png');
  await sharp(iphoneUiPath).resize(W, IPHONE_UI_H, { fit:'fill' }).toFile(iphoneScaled);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // ── Build clip track ──────────────────────────────────────────────────────
  // Clip structure:
  //   [freeze first frame for CLIP_PLAY_START seconds]
  //   [play clip from trimStart, scaled to canvas]
  //   [freeze last frame if clip shorter than needed]
  //   Total clip track = TOTAL_SEC

  const clipTrimStart = trimStart ?? 0;
  const clipTrimEnd   = trimEnd ?? await probeDur(clipPath);
  const clipDur       = clipTrimEnd - clipTrimStart;

  // Extract first frame (for freeze at start)
  const firstFrame  = path.join(tmpDir, 'first-frame.png');
  await run(FFMPEG, [
    '-y', '-ss', clipTrimStart.toFixed(3), '-i', clipPath,
    '-vframes', '1', firstFrame,
  ]);

  // Freeze first frame video (0 → CLIP_PLAY_START)
  const freezeStart = path.join(tmpDir, 'freeze-start.mp4');
  await run(FFMPEG, [
    '-y', '-loop', '1', '-framerate', String(FPS),
    '-i', firstFrame,
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
    '-t', CLIP_PLAY_START.toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    freezeStart,
  ]);

  // Scale the main clip
  const clipScaled = path.join(tmpDir, 'clip-scaled.mp4');
  await run(FFMPEG, [
    '-y', '-ss', clipTrimStart.toFixed(3), '-t', clipDur.toFixed(3),
    '-i', clipPath,
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    clipScaled,
  ]);

  // If clip is shorter than needed, add last-frame freeze
  const clipNeeded = TOTAL_SEC - CLIP_PLAY_START; // 28.5s
  const concatParts = [freezeStart, clipScaled];

  if (clipDur < clipNeeded) {
    const lastFrame  = path.join(tmpDir, 'last-frame.png');
    await run(FFMPEG, [
      '-y', '-sseof', '-0.1', '-i', clipScaled,
      '-vframes', '1', lastFrame,
    ]);
    const freezeEnd = path.join(tmpDir, 'freeze-end.mp4');
    const freezeDur = clipNeeded - clipDur;
    await run(FFMPEG, [
      '-y', '-loop', '1', '-framerate', String(FPS),
      '-i', lastFrame,
      '-vf', `scale=${W}:${H}`,
      '-t', freezeDur.toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      freezeEnd,
    ]);
    concatParts.push(freezeEnd);
  }

  // Concat all clip parts into full track
  const concatList = path.join(tmpDir, 'clip-concat.txt');
  fs.writeFileSync(concatList, concatParts.map(f => `file '${f}'`).join('\n'));

  const fullTrack = path.join(tmpDir, 'full-track.mp4');
  await run(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', TOTAL_SEC.toFixed(3),
    fullTrack,
  ]);

  // ── Final compose ─────────────────────────────────────────────────────────
  const ffArgs = [
    '-y',
    '-i', fullTrack,
    '-framerate', String(FPS), '-r', String(FPS), '-f', 'image2',
    '-i', path.join(seqDir, 'f%05d.png'),
    '-loop', '1', '-i', iphoneScaled,
    '-filter_complex', [
      `[1:v]format=rgba[pub]`,
      `[0:v][pub]overlay=x=0:y=0:shortest=1[base]`,
      `[2:v]scale=${W}:${IPHONE_UI_H}[ui]`,
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
