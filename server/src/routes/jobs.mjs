import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { runCompositor } from '../compositor.mjs';
import { resolvePublisherPaths } from './publishers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, '..', '..', 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: JOBS_DIR,
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── In-memory job store ────────────────────────────────────────────────────
const jobs = new Map();

// ── Concurrency queue — max 1 compositor job at a time ────────────────────
// Prevents simultaneous exports from exhausting the 2GB memory limit.
// Jobs are processed FIFO; queued jobs show status 'queued' until a slot opens.
let activeJobs = 0;
const MAX_CONCURRENT = 1;
const pendingQueue = []; // { fn: async function }[]

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

  const { publisherId, publisherLabel, trimStart, trimEnd } = req.body;
  if (!publisherId) return res.status(400).json({ error: 'publisherId required' });

  const publisherPaths = resolvePublisherPaths(publisherId);
  if (!publisherPaths) return res.status(400).json({ error: 'Publisher not found: ' + publisherId });

  // Log whether we're using the fast WebM path or the Sharp fallback
  if (publisherPaths.webm) {
    console.log('Using pre-built WebM for publisher:', publisherId);
  } else {
    console.log('Using Sharp compositor for publisher:', publisherId);
  }

  const jobId   = uuid();
  const outPath = path.join(JOBS_DIR, jobId + '.mp4');
  const queuePos = pendingQueue.length; // position before this job is added

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

  enqueueJob(async () => {
    const job = jobs.get(jobId);
    if (job) { job.status = 'processing'; job.message = 'Building your scene…'; }

    await runCompositor({
      clipPath:            req.file.path,
      publisherWebmPath:   publisherPaths.webm,       // fast path — null falls back to Sharp
      publisherTopPath:    publisherPaths.top,
      publisherBottomPath: publisherPaths.bottom,
      adBarTopPath,
      adBarBottomPath,
      iphoneUiPath,
      outPath,
      trimStart: trimStart ? parseFloat(trimStart) : 0,
      trimEnd:   trimEnd   ? parseFloat(trimEnd)   : null,
      onProgress: (pct, msg) => {
        const j = jobs.get(jobId);
        if (j) { j.progress = pct; j.message = msg; }
      }
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
