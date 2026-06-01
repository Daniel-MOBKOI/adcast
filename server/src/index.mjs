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

// Celtra mobile proxy — rewrites requests to Celtra with a mobile user agent
// so the ad is served in phone mode regardless of the viewer's browser
// Usage: /celtra-proxy?url=https://mobkoi-uk.celtra.com/preview/xxx
app.get('/celtra-proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url parameter');

  // Only allow Celtra domains
  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).send('Invalid URL'); }
  if (!parsed.hostname.endsWith('celtra.com')) {
    return res.status(403).send('Only celtra.com URLs are allowed');
  }

  try {
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    const contentType = response.headers.get('content-type') || 'text/html';
    const body = await response.text();

    // Rewrite absolute URLs in the HTML so sub-resources (JS, CSS) also go through
    // the proxy or load directly from Celtra
    const rewritten = body
      .replace(/(src|href)=["']\//g, `$1="https://${parsed.hostname}/`)
      .replace(/url\(\//g, `url(https://${parsed.hostname}/`);

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', '');
    res.send(rewritten);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).send('Proxy error: ' + err.message);
  }
});

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

app.listen(PORT, () => console.log(`AdCast server on :${PORT}`));
