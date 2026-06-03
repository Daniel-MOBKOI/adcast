/**
 * Compositor v9 — Remotion-powered.
 *
 * Replaces the Sharp+ffmpeg frame-pipe approach with Remotion's renderMedia().
 * Remotion renders each frame at exactly the right timestamp via headless Chrome,
 * producing a perfectly smooth H.264 MP4 with no frame timing issues.
 */

import fs   from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bundle }                        from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMOTION_ENTRY = path.resolve(__dirname, '..', '..', 'remotion', 'src', 'index.ts');

// Bundle cache — only bundle once per server process
let bundleCache = null;

async function getBundle() {
  if (bundleCache) return bundleCache;
  console.log('[Compositor] Bundling Remotion composition…');
  bundleCache = await bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => config,
  });
  console.log('[Compositor] Bundle ready');
  return bundleCache;
}

function serveFile(filePath, contentType) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/file`, close: () => server.close() });
    });
  });
}

function mimeFor(p) {
  const e = path.extname(p).toLowerCase();
  if (e === '.webm') return 'video/webm';
  if (e === '.mp4')  return 'video/mp4';
  if (e === '.png')  return 'image/png';
  return 'image/jpeg';
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

  const servers = await Promise.all([
    serveFile(clipPath,            mimeFor(clipPath)),
    serveFile(publisherTopPath,    'image/jpeg'),
    serveFile(publisherBottomPath, 'image/jpeg'),
    serveFile(adBarTopPath,        mimeFor(adBarTopPath)),
    serveFile(adBarBottomPath,     mimeFor(adBarBottomPath)),
    serveFile(iphoneUiPath,        'image/png'),
  ]);

  const [clipSrv, topSrv, botSrv, adBarTopSrv, adBarBotSrv, iphoneSrv] = servers;

  try {
    onProgress(10, 'Building scene…');
    const serveUrl = await getBundle();

    const inputProps = {
      clipUrl:            clipSrv.url,
      publisherTopUrl:    topSrv.url,
      publisherBottomUrl: botSrv.url,
      adBarTopUrl:        adBarTopSrv.url,
      adBarBottomUrl:     adBarBotSrv.url,
      iphoneUiUrl:        iphoneSrv.url,
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
    servers.forEach(s => s.close());
  }
}
