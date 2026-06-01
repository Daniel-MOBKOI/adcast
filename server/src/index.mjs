import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import { authMiddleware } from './auth.mjs';
import publishersRouter from './routes/publishers.mjs';
import jobsRouter from './routes/jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
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

// Serve React client in production (Render sets NODE_ENV=production)
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.listen(PORT, () => console.log(`AdCast server on :${PORT}`));
