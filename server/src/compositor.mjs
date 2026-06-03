/**
 * Compositor v12 — Correct timing, clip freeze, bar overlap.
 *
 * Timing (30s total):
 *   0–1.2s:  First scroll — ease out, ~65% reveal
 *   1.2–1.6s: Hesitation — natural finger pause
 *   1.6–3.0s: Second scroll — ease in/out, full reveal
 *   3–27s:   Hold — clip plays from frame 1, last frame frozen if clip < 24s
 *   27–30s:  Scroll out — ease in/out
 *
 * Ad bars overlap into the creative area:
 *   Gap = CREATIVE_H + AD_BAR_TOP_H + AD_BAR_BOT_H (bars overlap unit)
 *   Bars always visible on top of the ad clip when revealed
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

// ── Canvas dimensions ─────────────────────────────────────────────────────────
const W            = 1080;
const H            = 2342;
const IPHONE_UI_H  = 158;
const CREATIVE_H   = 2184;
const CREATIVE_TOP = H - CREATIVE_H; // 158px
const AD_BAR_TOP_H = 41;
const AD_BAR_BOT_H = 37;

// Gap = creative area + both bars overlapping in
// Bars overlap into the creative area so they're visible on top of the ad
const PUB_GAP_H = CREATIVE_H + AD_BAR_TOP_H + AD_BAR_BOT_H; // 2262px

// ── Timing ────────────────────────────────────────────────────────────────────
const FPS          = 30;
const TOTAL_SEC    = 30;
const TOTAL_FRAMES = TOTAL_SEC * FPS; // 900

// Key timestamps (seconds)
const SCROLL1_START  = 0;
const SCROLL1_END    = 1.2;   // first scroll ends
const PAUSE_END      = 1.6;   // hesitation ends
const SCROLL2_END    = 3.0;   // second scroll ends — ad fully revealed
const HOLD_END       = 27.0;  // hold ends — clip plays 3s–27s = 24s
const SCROLLOUT_END  = 30.0;  // scroll out ends

// Clip plays during hold: starts at 3s, 24s of content available
const CLIP_START_SEC  = SCROLL2_END;  // 3s
const CLIP_HOLD_SEC   = HOLD_END - CLIP_START_SEC; // 24s

const easeOut      = p => 1 - Math.pow(1 - p, 3);
const easeInOut    = p => p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2,3)/2;
const easeOutSoft  = p => 1 - Math.pow(1 - p, 2); // gentler ease out

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

const probeDur = async f => parseFloat(
  (await run(FFPROBE, ['-v','error','-show_entries','format=duration',
    '-of','default=nw=1:nk=1', f])).trim());

async function buildFrame({ scrollY, topImg, topH, botImg, botH, adBarTop, adBarBot, pubCanvasH }) {
  // Bar positions in the publisher canvas:
  // top bar: topH → topH + AD_BAR_TOP_H  (overlaps into gap)
  // gap:     topH + AD_BAR_TOP_H → topH + AD_BAR_TOP_H + CREATIVE_H
  // bot bar: topH + AD_BAR_TOP_H + CREATIVE_H → + AD_BAR_BOT_H (overlaps gap end)
  const barTopStart = topH;
  const gapStart    = topH + AD_BAR_TOP_H;
  const gapEnd      = gapStart + CREATIVE_H;
  const barBotStart = gapEnd;
  const botStart_c  = barBotStart + AD_BAR_BOT_H;

  const vpTop = scrollY;
  const vpBot = scrollY + H;
  const composites = [];

  // Publisher top image
  const s1 = Math.max(vpTop, 0), e1 = Math.min(vpBot, barTopStart);
  if (e1 > s1) {
    const slice = await sharp(topImg).extract({ left:0, top:s1, width:W, height:e1-s1 }).toBuffer();
    composites.push({ input: slice, top: s1-vpTop, left:0 });
  }

  // Ad bar top (overlaps into gap)
  const s2 = Math.max(vpTop, barTopStart), e2 = Math.min(vpBot, gapStart);
  if (e2 > s2) {
    const slice = await sharp(adBarTop).extract({ left:0, top:s2-barTopStart, width:W, height:e2-s2 }).toBuffer();
    composites.push({ input: slice, top: s2-vpTop, left:0 });
  }

  // Gap = transparent (creative area shows through) — nothing to composite

  // Ad bar bottom (overlaps into gap from below)
  const s3 = Math.max(vpTop, barBotStart), e3 = Math.min(vpBot, botStart_c);
  if (e3 > s3) {
    const slice = await sharp(adBarBot).extract({ left:0, top:s3-barBotStart, width:W, height:e3-s3 }).toBuffer();
    composites.push({ input: slice, top: s3-vpTop, left:0 });
  }

  // Publisher bottom image
  const s4 = Math.max(vpTop, botStart_c), e4 = Math.min(vpBot, pubCanvasH);
  if (e4 > s4) {
    const slice = await sharp(botImg).extract({ left:0, top:s4-botStart_c, width:W, height:e4-s4 }).toBuffer();
    composites.push({ input: slice, top: s4-vpTop, left:0 });
  }

  return sharp({
    create: { width:W, height:H, channels:4, background:{ r:0, g:0, b:0, alpha:0 } }
  })
  .composite(composites)
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

  const topScaled    = await sharp(publisherTopPath).resize(W, topH, { fit:'fill' }).toBuffer();
  const botScaled    = await sharp(publisherBottomPath).resize(W, botH, { fit:'fill' }).toBuffer();
  const adBarTopSc   = await sharp(adBarTopPath).resize(W, AD_BAR_TOP_H, { fit:'fill' }).toBuffer();
  const adBarBotSc   = await sharp(adBarBottomPath).resize(W, AD_BAR_BOT_H, { fit:'fill' }).toBuffer();

  // Publisher canvas: top + adBarTop + gap(creative) + adBarBot + bottom
  const pubCanvasH = topH + AD_BAR_TOP_H + CREATIVE_H + AD_BAR_BOT_H + botH;

  onProgress(10, 'Building your scene…');

  // ── Scroll geometry ────────────────────────────────────────────────────────
  // Target: gap aligned so top ad bar sits at CREATIVE_TOP in the viewport
  // pubCanvas Y of adBarTop top = topH
  // viewport Y of adBarTop top = topH - scrollY = CREATIVE_TOP
  // scrollY = topH - CREATIVE_TOP
  const targetY   = Math.max(0, topH - CREATIVE_TOP);
  const maxScroll = Math.max(0, pubCanvasH - H);
  const tY        = Math.min(targetY, maxScroll);

  // First scroll goes 65% of the way
  const firstScrollTarget = Math.round(tY * 0.65);

  // ── Build per-frame scroll Y ───────────────────────────────────────────────
  const frameScrollY = [];

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const t = f / FPS; // time in seconds
    let scrollY = 0;

    if (t < SCROLL1_END) {
      // First scroll: 0 → firstScrollTarget, ease out
      const p = easeOut(t / SCROLL1_END);
      scrollY = Math.round(p * firstScrollTarget);
    } else if (t < PAUSE_END) {
      // Hesitation: barely moving, slight drift continues
      const p = (t - SCROLL1_END) / (PAUSE_END - SCROLL1_END);
      const drift = Math.round(firstScrollTarget * 0.02 * p); // 2% drift
      scrollY = firstScrollTarget + drift;
    } else if (t < SCROLL2_END) {
      // Second scroll: firstScrollTarget → tY, ease in/out
      const p = easeInOut((t - PAUSE_END) / (SCROLL2_END - PAUSE_END));
      scrollY = Math.round(firstScrollTarget + p * (tY - firstScrollTarget));
    } else if (t < HOLD_END) {
      // Hold at target
      scrollY = tY;
    } else if (t < SCROLLOUT_END) {
      // Scroll out: tY → maxScroll, ease in/out
      const p = easeInOut((t - HOLD_END) / (SCROLLOUT_END - HOLD_END));
      scrollY = Math.round(tY + p * (maxScroll - tY));
    } else {
      scrollY = maxScroll;
    }

    frameScrollY.push(Math.min(scrollY, pubCanvasH - H));
  }

  // ── Build unique publisher overlay frames ──────────────────────────────────
  onProgress(12, 'Building your scene…');

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'adcast-'));
  const uniqueCache = new Map();
  const uniqueYs    = [...new Set(frameScrollY)];
  let   done        = 0;

  for (const scrollY of uniqueYs) {
    const fp  = path.join(tmpDir, `u_${scrollY}.png`);
    const buf = await buildFrame({
      scrollY,
      topImg: topScaled, topH,
      botImg: botScaled, botH,
      adBarTop: adBarTopSc,
      adBarBot: adBarBotSc,
      pubCanvasH,
    });
    fs.writeFileSync(fp, buf);
    uniqueCache.set(scrollY, fp);
    done++;
    onProgress(12 + Math.round((done / uniqueYs.length) * 55), 'Building your scene…');
  }

  // Map all frames
  const frameFiles = frameScrollY.map(y => uniqueCache.get(y));

  // ── Write sequentially numbered files for image2 ──────────────────────────
  onProgress(69, 'Encoding…');

  const seqDir = path.join(tmpDir, 'seq');
  fs.mkdirSync(seqDir);
  for (let i = 0; i < frameFiles.length; i++) {
    fs.copyFileSync(frameFiles[i], path.join(seqDir, `f${String(i).padStart(5,'0')}.png`));
  }

  // ── iPhone UI ─────────────────────────────────────────────────────────────
  const iphoneScaled = path.join(tmpDir, 'iphone-ui.png');
  await sharp(iphoneUiPath).resize(W, IPHONE_UI_H, { fit:'fill' }).toFile(iphoneScaled);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // ── Clip timing ───────────────────────────────────────────────────────────
  // Clip starts playing at CLIP_START_SEC (3s) in the output.
  // Trim the clip to the user-selected range.
  // If trimmed clip < CLIP_HOLD_SEC (24s), freeze last frame for remainder.
  const clipTrimStart = trimStart ?? 0;
  const clipTrimEnd   = trimEnd   ?? await probeDur(clipPath);
  const clipDur       = clipTrimEnd - clipTrimStart;

  // We need the clip to fill exactly CLIP_HOLD_SEC seconds.
  // Strategy: trim clip, then if short, concat with a freeze of the last frame.
  let finalClipPath = clipPath;
  let finalTrimSS   = clipTrimStart.toFixed(3);
  let finalTrimT    = clipDur.toFixed(3);

  if (clipDur < CLIP_HOLD_SEC) {
    // Extract last frame as PNG, create a freeze video for the remainder
    const freezeFrame = path.join(tmpDir, 'freeze.png');
    const freezeVideo = path.join(tmpDir, 'freeze.mp4');
    const stitched    = path.join(tmpDir, 'clip-full.mp4');
    const freezeDur   = CLIP_HOLD_SEC - clipDur;

    // Extract last frame
    await run(FFMPEG, [
      '-y', '-ss', clipTrimEnd.toFixed(3), '-i', clipPath,
      '-vframes', '1', freezeFrame
    ]);

    // Create freeze video from last frame
    await run(FFMPEG, [
      '-y',
      '-loop', '1', '-framerate', String(FPS),
      '-i', freezeFrame,
      '-t', freezeDur.toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      freezeVideo,
    ]);

    // Write concat list
    const concatList = path.join(tmpDir, 'clip-concat.txt');
    // First: the trimmed original clip
    const trimmedClip = path.join(tmpDir, 'clip-trimmed.mp4');
    await run(FFMPEG, [
      '-y',
      '-ss', clipTrimStart.toFixed(3),
      '-t', clipDur.toFixed(3),
      '-i', clipPath,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      trimmedClip,
    ]);

    fs.writeFileSync(concatList,
      `file '${trimmedClip}'\nfile '${freezeVideo}'`);

    await run(FFMPEG, [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatList,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      stitched,
    ]);

    finalClipPath = stitched;
    finalTrimSS   = '0';
    finalTrimT    = CLIP_HOLD_SEC.toFixed(3);
  }

  // ── ffmpeg final compose ───────────────────────────────────────────────────
  // Input 0: clip — delayed to start at CLIP_START_SEC using itsoffset
  // Input 1: publisher overlay PNG sequence
  // Input 2: iPhone UI
  //
  // We pad the clip with black at the start (0 → CLIP_START_SEC = 3s)
  // so it aligns with the hold phase of the publisher animation.

  const ffArgs = [
    '-y',
    // Input 0: ad clip (starts at CLIP_START_SEC in the output)
    '-ss', finalTrimSS,
    '-t',  finalTrimT,
    '-i', finalClipPath,
    // Input 1: publisher overlay PNG sequence
    '-framerate', String(FPS),
    '-r', String(FPS),
    '-f', 'image2',
    '-i', path.join(seqDir, 'f%05d.png'),
    // Input 2: iPhone UI
    '-loop', '1', '-i', iphoneScaled,
    '-filter_complex', [
      // Black leader for scroll-in phase (0 → CLIP_START_SEC)
      `color=black:size=${W}x${H}:rate=${FPS}:duration=${CLIP_START_SEC}[leader]`,
      // Clip: scale to fill creative area, pad to full canvas
      `[0:v]scale=${W}:${CREATIVE_H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${CREATIVE_H},` +
        `pad=${W}:${H}:0:${CREATIVE_TOP}:color=black[clipscaled]`,
      // Concatenate leader + clip so clip starts at CLIP_START_SEC
      `[leader][clipscaled]concat=n=2:v=1:a=0[clip]`,
      // Publisher overlay — RGBA with transparent gap
      `[1:v]format=rgba[pub]`,
      // Composite clip under publisher
      `[clip][pub]overlay=x=0:y=0:shortest=1[base]`,
      // iPhone UI on top
      `[2:v]scale=${W}:${IPHONE_UI_H}[ui]`,
      `[base][ui]overlay=x=0:y=0:shortest=1[out]`,
    ].join(';'),
    '-map', '[out]',
    '-t', TOTAL_SEC.toFixed(3),
    '-r', String(FPS),
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
