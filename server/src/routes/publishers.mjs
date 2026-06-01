import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { v4 as uuid } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(__dirname, '..', '..', 'publishers');
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// Seeded publisher library — edit this list to add/rename built-ins
const BUILTIN = [
  { id: 'cnt-1', label: "Condé Nast Traveler — Las Vegas", file: 'conde-nast-traveler-1.jpg' },
  { id: 'cnt-2', label: "Condé Nast Traveler — Fontainebleau", file: 'conde-nast-traveler-2.jpg' },
];

const router = express.Router();

// GET /api/publishers
router.get('/', (_req, res) => {
  const builtin = BUILTIN.map(p => ({
    id: p.id,
    label: p.label,
    url: `/publishers/${p.file}`,
    filePath: path.join(BUILTIN_DIR, p.file),
    source: 'builtin'
  }));

  const uploaded = fs.existsSync(UPLOAD_DIR)
    ? fs.readdirSync(UPLOAD_DIR)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .map(f => ({
          id: 'upload-' + f,
          label: path.basename(f, path.extname(f)),
          url: `/uploads/${f}`,
          filePath: path.join(UPLOAD_DIR, f),
          source: 'upload'
        }))
    : [];

  res.json([...builtin, ...uploaded]);
});

// POST /api/publishers/upload
router.post('/upload', upload.single('screenshot'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    id: 'upload-' + req.file.filename,
    label: req.body.label || req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    filePath: path.join(UPLOAD_DIR, req.file.filename),
    source: 'upload'
  });
});

export default router;
