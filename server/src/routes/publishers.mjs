import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { v4 as uuid } from 'uuid';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(__dirname, '..', '..', 'publishers');
const UPLOAD_DIR  = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * Seeded publisher library.
 *
 * Built-in publishers can optionally include a pre-rendered VP9+alpha WebM
 * (fileWebm). On server startup, index.mjs pre-converts each WebM to a
 * side-by-side H.264 (fileWebm → same name with -sbs.mp4 suffix).
 * The compositor prefers the H.264 for speed; falls back to WebM if not ready.
 *
 * Uploaded publishers have no WebM so they fall back to the Sharp legacy path.
 */
const BUILTIN = [
  {
    id:         'cnt-1',
    label:      'Condé Nast Traveler — Las Vegas',
    fileTop:    'conde-nast-traveler-1.jpg',
    fileBottom: 'conde-nast-traveler-2.jpg',
    fileWebm:   'conde-nast-traveler.webm',
    thumb:      'conde-nast-traveler-1.jpg',
  },
];

const router = express.Router();

// GET /api/publishers
router.get('/', (_req, res) => {
  const builtin = BUILTIN.map(p => ({
    id:     p.id,
    label:  p.label,
    url:    `/publishers/${p.thumb}`,
    source: 'builtin',
  }));

  const uploaded = fs.existsSync(UPLOAD_DIR)
    ? fs.readdirSync(UPLOAD_DIR)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .map(f => ({
          id:     'upload-' + f,
          label:  path.basename(f, path.extname(f)),
          url:    `/uploads/${f}`,
          source: 'upload',
        }))
    : [];

  res.json([...builtin, ...uploaded]);
});

// POST /api/publishers/upload
router.post('/upload', upload.single('screenshot'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    id:     'upload-' + req.file.filename,
    label:  req.body.label || req.file.originalname,
    url:    `/uploads/${req.file.filename}`,
    source: 'upload',
  });
});

export default router;

/**
 * resolvePublisherPaths(id) → { top, bottom, webm, h264 } | null
 *
 * h264: path to pre-converted side-by-side H.264 (preferred, fast)
 * webm: path to VP9+alpha WebM (fallback if H.264 not ready yet)
 * Both may be null for uploaded publishers (legacy Sharp path used).
 */
export function resolvePublisherPaths(id) {
  const builtin = BUILTIN.find(p => p.id === id);
  if (builtin) {
    const webmPath = builtin.fileWebm
      ? path.join(BUILTIN_DIR, builtin.fileWebm)
      : null;
    const h264Path = webmPath
      ? webmPath.replace('.webm', '-sbs.mp4')
      : null;

    return {
      top:    path.join(BUILTIN_DIR, builtin.fileTop),
      bottom: path.join(BUILTIN_DIR, builtin.fileBottom),
      webm:   webmPath && fs.existsSync(webmPath) ? webmPath : null,
      h264:   h264Path && fs.existsSync(h264Path) ? h264Path : null,
    };
  }

  const filename = id.startsWith('upload-') ? id.slice('upload-'.length) : null;
  if (!filename) return null;
  const uploadPath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(uploadPath)) return null;
  return { top: uploadPath, bottom: uploadPath, webm: null, h264: null };
}
