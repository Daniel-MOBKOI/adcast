import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import cors from 'cors';
import ffmpegStatic  from 'ffmpeg-static';

import { authMiddleware } from './auth.mjs';
import publishersRouter from './routes/publishers.mjs';
import jobsRouter from './routes/jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT    = process.env.PORT || 3001;
const FFMPEG  = ffmpegStatic || 'ffmpeg';
const W       = 1080;
const H       = 2342;

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, o, se) =>
    e ? rej(new Error(se || e.message)) : res(o)));

/**
 * Pre-convert all built-in publisher WebMs to side-by-side H.264 on startup.
 *
 * Side-by-side layout: left 1080px = RGB, right 1080px = alpha as greyscale.
 * Total width = 2160px, height = 2342px. Stored as H.264 yuv420p.
 *
 * This is a one-time cost (~20-30s per publisher). Once done, every export
 * reads fast H.264 instead of decoding slow VP9 — saving ~20-30s per job.
 *
 * The H.264 file sits alongside the WebM:
 *   conde-nast-traveler.webm → conde-nast-traveler-sbs.mp4
 */
async function preConvertPublisherWebms() {
  const publishersDir = path.join(__dirname, '..', 'publishers');
  const webms = fs.readdirSync(publishersDir).filter(f => f.endsWith('.webm'));

  for (const webmFile of webms) {
    const webmPath = path.join(publishersDir, webmFile);
    const h264Path = path.join(publishersDir, webmFile.replace('.webm', '-sbs.mp4'));

    if (fs.existsSync(h264Path)) {
      console.log(`[startup] Publisher H.264 already exists: ${path.basename(h264Path)}`);
      continue;
    }

    console.log(`[startup] Pre-converting ${webmFile} → side-by-side H.264…`);
    try {
      // Extract RGB and alpha side-by-side into a single H.264 file.
      // [0:v] = full RGBA frame from VP9+alpha decode
      // Left  half (0,0): RGB channels
      // Right half (W,0): alpha channel as greyscale
      await run(FFMPEG, [
        '-y',
        '-vcodec', 'libvpx-vp9', '-i', webmPath,
        '-filter_complex', [
          `[0:v]format=rgba,split[rgb][alpha_src]`,
          `[alpha_src]alphaextract,format=gray,pad=${W*2}:${H}:${W}:0:color=black[alpha_padded]`,
          `[rgb]format=yuv420p,pad=${W*2}:${H}:0:0:color=black[rgb_padded]`,
          `[rgb_padded][alpha_padded]blend=all_mode=addition[sbs]`,
        ].join(';'),
        '-map', '[sbs]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-crf', '18',        // slightly higher quality for source material
        '-preset', 'medium', // better compression on this one-time encode
        '-r', '30',
        h264Path,
      ]);
      console.log(`[startup] ✓ ${path.basename(h264Path)} ready`);
    } catch (err) {
      console.error(`[startup] Failed to pre-convert ${webmFile}:`, err.message);
      // Non-fatal — compositor falls back to VP9 WebM
    }
  }
}

const app = express();

app.use(cors());
app.use(express.json());

// Static publisher screenshots
app.use('/publishers', express.static(path.join(__dirname, '..', 'publishers')));

// Uploaded publisher screenshots (runtime uploads)
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Auth wall — all /api routes require the team password
app.use('/api', authMiddleware);
app.use('/api/publishers', publishersRouter);
app.use('/api/jobs', jobsRouter);

// Serve React client in production
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// Start server, then kick off pre-conversion in the background.
// Server is ready immediately — pre-conversion doesn't block requests.
// First export after a cold deploy may still use VP9 fallback if not done yet.
app.listen(PORT, () => {
  console.log(`AdCast server on :${PORT}`);
  preConvertPublisherWebms().catch(err =>
    console.error('[startup] Pre-conversion error:', err.message));
});
