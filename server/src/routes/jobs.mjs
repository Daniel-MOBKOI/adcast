import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { runCompositor } from '../compositor.mjs';
import { resolvePublisherPaths } from './publishers.mjs';
import ffprobeStatic from 'ffprobe-static';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, '..', '..', 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: JOBS_DIR,
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── ffprobe inspection ─────────────────────────────────────────────────────
async function inspectClip(filePath) {
  try {
    const { stdout } = await execFileAsync(ffprobeStatic.path, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      '-count_frames',
      filePath,
    ]);

    const info = JSON.parse(stdout);
    const video = info.streams?.find(s => s.codec_type === 'video');
    const fmt   = info.format;

    if (!video) {
      console.log('[ffprobe] No video stream found');
      return;
    }

    const duration    = parseFloat(fmt?.duration  ?? video.duration ?? 0);
    const nbFrames    = parseInt(video.nb_read_frames ?? video.nb_frames ?? 0, 10);
    const avgFps      = video.avg_frame_rate;   // e.g. "30/1" or "2997/100"
    const realFps     = video.r_frame_rate;     // codec-level FPS
    const isVfr       = video.avg_frame_rate !== video.r_frame_rate;
    const actualFps   = nbFrames > 0 && duration > 0 ? (nbFrames / duration).toFixed(2) : 'unknown';

    console.log('─────────────────────────────────────');
    console.log('[ffprobe] Clip inspection:');
    console.log(`  File:           ${path.basename(filePath)}`);
    console.log(`  Duration:       ${duration.toFixed(2)}s`);
    console.log(`  Frames:         ${nbFrames}`);
    console.log(`  avg_frame_rate: ${avgFps}  (codec declared)`);
    console.log(`  r_frame_rate:   ${realFps}  (container declared)`);
    console.log(`  Actual fps:     ${actualFps} fps  (frames ÷ duration)`);
    console.log(`  Variable FPS:   ${isVfr ? '⚠️  YES — avg ≠ r_frame_rate' : '✅ No'}`);
    console.log('─────────────────────────────────────');
  } catch (err) {
    console.error('[ffprobe] Inspection failed:', err.message);
  }
}

// ── In-memory job store ────────────────────────────────────────────────────
const jobs = new Map();

// ── Concurrency queue — max 1 compositor job at a time ────────────────────
let activeJobs = 0;
const MAX_CONCURRENT = 1;
const pendingQueue = [];

function enqueueJob(fn) {
  if (activeJobs < MAX_CONCURRENT) {
    runJob(fn);
  } else {
    pendingQueue.push({ fn });
  }
}

async function runJob(fn) {
  activeJobs++;
  try {
    await fn();
  } finally {
    activeJobs--;
    if (pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      runJob(next.fn);
    }
  }
}

const router = express.Router();

// POST /api/jobs
router.post('/', upload.single('clip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No clip uploaded' });

  const { publisherId, publisherLabel, trimStart, trimEnd, cropRect } = req.body;
  if (!publisherId) return res.status(400).json({ error: 'publisherId required' });

  const publisherPaths = resolvePublisherPaths(publisherId);
  if (!publisherPaths) return res.status(400).json({ error: 'Publisher not found: ' + publisherId });

  console.log('Compositing with Sharp for publisher:', publisherId);

  // ── Inspect the incoming clip immediately ──────────────────────────────
  await inspectClip(req.file.path);

  const jobId    = uuid();
  const outPath  = path.join(JOBS_DIR, jobId + '.mp4');
  const queuePos = pendingQueue.length;

  jobs.set(jobId, {
    status:   activeJobs < MAX_CONCURRENT ? 'queued' : 'waiting',
    progress: 0,
    message:  activeJobs < MAX_CONCURRENT ? 'Starting…' : `Queued — ${queuePos + 1} job${queuePos > 0 ? 's' : ''} ahead`,
    outPath,
    error: null,
  });
  res.json({ jobId });

  const assetsDir       = path.join(__dirname, '..', '..', 'publishers', 'assets');
  const adBarTopPath    = path.join(assetsDir, 'ad-bar-top.jpg');
  const adBarBottomPath = path.join(assetsDir, 'ad-bar-bottom.jpg');
  const iphoneUiPath    = path.join(assetsDir, 'iphone-ui.png');

  let parsedCropRect = null;
  if (cropRect) {
    try { parsedCropRect = JSON.parse(cropRect); } catch (_) {}
  }

  enqueueJob(async () => {
    const job = jobs.get(jobId);
    if (job) { job.status = 'processing'; job.message = 'Building your scene…'; }

    await runCompositor({
      clipPath:            req.file.path,
      publisherTopPath:    publisherPaths.top,
      publisherBottomPath: publisherPaths.bottom,
      adBarTopPath,
      adBarBottomPath,
      iphoneUiPath,
      outPath,
      trimStart:  trimStart ? parseFloat(trimStart) : 0,
      trimEnd:    trimEnd   ? parseFloat(trimEnd)   : null,
      cropRect:   parsedCropRect,
      onProgress: (pct, msg) => {
        const j = jobs.get(jobId);
        if (j) { j.progress = pct; j.message = msg; }
      },
    })
    .then(() => {
      const j = jobs.get(jobId);
      if (j) { j.status = 'done'; j.progress = 100; }
      fs.rmSync(req.file.path, { force: true });
    })
    .catch(err => {
      console.error('Compositor error:', err);
      const j = jobs.get(jobId);
      if (j) { j.status = 'error'; j.error = err.message; }
      fs.rmSync(req.file.path, { force: true });
    });
  });
});

// GET /api/jobs/:id
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId:    req.params.id,
    status:   job.status,
    progress: job.progress,
    message:  job.message || null,
    error:    job.error   || null,
  });
});

// GET /api/jobs/:id/download
router.get('/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  if (!fs.existsSync(job.outPath)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="adcast.mp4"');
  fs.createReadStream(job.outPath).pipe(res);
});

export default router;
