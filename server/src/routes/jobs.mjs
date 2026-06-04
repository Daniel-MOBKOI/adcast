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

const jobs = new Map();

const router = express.Router();

// POST /api/jobs
router.post('/', upload.single('clip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No clip uploaded' });

  const { publisherId, publisherLabel, trimStart, trimEnd, cropRect: cropRectRaw } = req.body;
  if (!publisherId) return res.status(400).json({ error: 'publisherId required' });

  const publisherPaths = resolvePublisherPaths(publisherId);
  if (!publisherPaths) return res.status(400).json({ error: 'Publisher not found: ' + publisherId });

  // Parse cropRect if provided — { x, y, width, height } in physical pixels
  let cropRect = null;
  if (cropRectRaw) {
    try {
      cropRect = JSON.parse(cropRectRaw);
      // Validate all fields are positive numbers
      if (!['x','y','width','height'].every(k => typeof cropRect[k] === 'number' && cropRect[k] >= 0)) {
        console.warn('Invalid cropRect, ignoring:', cropRect);
        cropRect = null;
      }
    } catch (e) {
      console.warn('Failed to parse cropRect, ignoring:', e.message);
    }
  }

  const jobId  = uuid();
  const outPath = path.join(JOBS_DIR, jobId + '.mp4');

  jobs.set(jobId, { status: 'queued', progress: 0, outPath, error: null });
  res.json({ jobId });

  const assetsDir       = path.join(__dirname, '..', '..', 'publishers', 'assets');
  const adBarTopPath    = path.join(assetsDir, 'ad-bar-top.jpg');
  const adBarBottomPath = path.join(assetsDir, 'ad-bar-bottom.jpg');
  const iphoneUiPath    = path.join(assetsDir, 'iphone-ui.png');

  runCompositor({
    clipPath:            req.file.path,
    publisherTopPath:    publisherPaths.top,
    publisherBottomPath: publisherPaths.bottom,
    adBarTopPath,
    adBarBottomPath,
    iphoneUiPath,
    outPath,
    trimStart: trimStart ? parseFloat(trimStart) : 0,
    trimEnd:   trimEnd   ? parseFloat(trimEnd)   : null,
    cropRect,
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
