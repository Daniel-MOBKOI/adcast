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

// Celtra embed wrapper — serves a minimal HTML page that loads a Celtra
// creative directly via web.js. No article skeleton, no ad bars.
// Used by the recording lightbox for a clean full-screen ad view.
app.get('/celtra-embed/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9]+$/.test(id)) return res.status(400).send('Invalid ID');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=390, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 390px; height: 100%; overflow: hidden; background: #000; }
  </style>
</head>
<body>
  <div class="celtra-ad-v3">
    <img src="data:image/png,celtra" style="display:none" onerror="
      (function(img) {
        var params = {
          'accountId': '${id}',
          'removeAdvertisementBars': '1',
          'useFullWidth': '1',
          'clickEvent': 'advertiser',
          'overrides.deviceInfo.deviceType': 'Phone',
          'tagVersion': 'html-standard-7'
        };
        var req = document.createElement('script');
        req.id = params.scriptId = 'celtra-script-1';
        params.clientTimestamp = new Date / 1000;
        params.clientTimeZoneOffsetInMinutes = new Date().getTimezoneOffset();
        params.hostPageLoadId = (Math.random() + '').slice(2);
        var qs = '';
        for (var k in params) qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        req.src = 'https://ads.celtra.com/' + '${id}' + '/web.js?' + qs;
        img.parentNode.insertBefore(req, img.nextSibling);
      })(this);
    "/>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
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
