import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { runCompositor } from '../compositor.mjs';
import { resolvePublisherPath } from './publishers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, '..', '..', 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: JOBS_DIR,
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// In-memory job store (sufficient for a small team tool)
const jobs = new Map();

const router = express.Router();

// POST /api/jobs  — multipart: clip (webm), publisherId, publisherLabel
router.post('/', upload.single('clip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No clip uploaded' });

  const { publisherId, publisherLabel } = req.body;
  if (!publisherId) return res.status(400).json({ error: 'publisherId required' });

  // Look up publisher file path server-side by ID — never trust a client-supplied path
  const publisherPath = resolvePublisherPath(publisherId);
  if (!publisherPath) return res.status(400).json({ error: 'Publisher not found: ' + publisherId });

  const jobId = uuid();
  const outPath = path.join(JOBS_DIR, jobId + '.mp4');

  jobs.set(jobId, { status: 'queued', progress: 0, outPath, error: null });
  res.json({ jobId });

  // Run compositor in background
  runCompositor({
    clipPath: req.file.path,
    publisherPath,
    outPath,
    onProgress: (pct, msg) => {
      const job = jobs.get(jobId);
      if (job) { job.progress = pct; job.message = msg; }
    }
  })
    .then(() => {
      const job = jobs.get(jobId);
      if (job) { job.status = 'done'; job.progress = 100; }
      fs.rmSync(req.file.path, { force: true });
    })
    .catch(err => {
      console.error('Compositor error:', err);
      const job = jobs.get(jobId);
      if (job) { job.status = 'error'; job.error = err.message; }
      fs.rmSync(req.file.path, { force: true });
    });
});

// GET /api/jobs/:id — poll status
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId: req.params.id,
    status: job.status,
    progress: job.progress,
    message: job.message || null,
    error: job.error || null
  });
});

// GET /api/jobs/:id/download — stream the finished MP4
router.get('/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  if (!fs.existsSync(job.outPath)) return res.status(404).json({ error: 'File missing' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="adcast.mp4"');
  fs.createReadStream(job.outPath).pipe(res);
});

export default router;
