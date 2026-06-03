/**
 * Compositor v10 — Remotion with Express static asset serving.
 *
 * Instead of spinning up per-file HTTP servers (which Remotion's sandboxed
 * Chrome can't always reach), we copy assets to a temp directory served
 * by the existing Express static middleware, then pass those URLs to Remotion.
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundle }                        from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Express server port — Remotion's Chrome can reach this
const SERVER_PORT = process.env.PORT || 3001;
const BASE_URL    = `http://127.0.0.1:${SERVER_PORT}`;

// Temp assets served via /tmp-assets/ route on Express
const TMP_ASSETS_DIR = path.join(__dirname, '..', 'tmp-assets');
fs.mkdirSync(TMP_ASSETS_DIR, { recursive: true });

// Bundle cache
let bundleCache = null;

async function getBundle() {
  if (bundleCache) return bundleCache;
  console.log('[Compositor] Bundling Remotion…');
  const REMOTION_ENTRY = path.resolve(__dirname, '..', '..', 'remotion', 'src', 'index.ts');
  bundleCache = await bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => config,
  });
  console.log('[Compositor] Bundle ready');
  return bundleCache;
}

/**
 * Copy a file to tmp-assets dir and return its public URL.
 */
function stageAsset(srcPath, name) {
  const dest = path.join(TMP_ASSETS_DIR, name);
  fs.copyFileSync(srcPath, dest);
  return `${BASE_URL}/tmp-assets/${name}`;
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
  onProgress(5, 'Preparing scene…');

  // Stage all assets with unique names to avoid collisions
  const id = Date.now();
  const clipUrl        = stageAsset(clipPath,            `clip-${id}.webm`);
  const topUrl         = stageAsset(publisherTopPath,    `pub-top-${id}.jpg`);
  const botUrl         = stageAsset(publisherBottomPath, `pub-bot-${id}.jpg`);
  const adBarTopUrl    = stageAsset(adBarTopPath,        `adbar-top-${id}.jpg`);
  const adBarBotUrl    = stageAsset(adBarBottomPath,     `adbar-bot-${id}.jpg`);
  const iphoneUrl      = stageAsset(iphoneUiPath,        `iphone-${id}.png`);

  try {
    onProgress(10, 'Building scene…');
    const serveUrl = await getBundle();

    const inputProps = {
      clipUrl,
      publisherTopUrl:    topUrl,
      publisherBottomUrl: botUrl,
      adBarTopUrl,
      adBarBottomUrl:     adBarBotUrl,
      iphoneUiUrl:        iphoneUrl,
      trimStart:          trimStart ?? 0,
      trimEnd:            trimEnd   ?? 10,
    };

    onProgress(15, 'Rendering…');

    const composition = await selectComposition({
      serveUrl,
      id: 'PublisherScene',
      inputProps,
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: outPath,
      inputProps,
      imageFormat: 'jpeg',
      jpegQuality: 95,
      crf: 18,
      onProgress: ({ progress }) => {
        onProgress(15 + Math.round(progress * 80), 'Rendering…');
      },
    });

    onProgress(100, 'Done');

  } finally {
    // Clean up staged assets
    try {
      [`clip-${id}.webm`, `pub-top-${id}.jpg`, `pub-bot-${id}.jpg`,
       `adbar-top-${id}.jpg`, `adbar-bot-${id}.jpg`, `iphone-${id}.png`]
        .forEach(f => fs.rmSync(path.join(TMP_ASSETS_DIR, f), { force: true }));
    } catch {}
  }
}
