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

// ── Celtra touch proxy ────────────────────────────────────────────────────────
// Fetches the Celtra preview page server-side and injects a mouse-to-touch
// emulator so desktop users can swipe/interact with mobile ad creatives.
// Same-origin delivery means we can inject scripts freely — no cross-origin block.
//
// Usage: /celtra-proxy?url=https://preview-sandbox.celtra.com/preview/<id>/frame?...

// The touch emulator script — converts mouse events to touch events
const TOUCH_EMULATOR_SCRIPT = `
<script>
(function() {
  'use strict';
  // Prevent double-injection
  if (window.__adcastTouchEmulator) return;
  window.__adcastTouchEmulator = true;

  var el = document.documentElement;
  var isDown = false;
  var lastX = 0, lastY = 0;

  function mkTouch(e) {
    return new Touch({
      identifier: Date.now(),
      target: e.target,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      pageX: e.pageX,
      pageY: e.pageY,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
      force: 1,
    });
  }

  function fire(type, e, touches) {
    var te = new TouchEvent(type, {
      cancelable: true,
      bubbles: true,
      touches: touches,
      targetTouches: touches,
      changedTouches: [mkTouch(e)],
    });
    // Prevent the original mouse event from also firing
    e.preventDefault();
    e.stopPropagation();
    e.target.dispatchEvent(te);
  }

  el.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    isDown = true;
    lastX = e.clientX; lastY = e.clientY;
    fire('touchstart', e, [mkTouch(e)]);
  }, { capture: true, passive: false });

  el.addEventListener('mousemove', function(e) {
    if (!isDown) return;
    // Only fire touchmove if there was meaningful movement
    if (Math.abs(e.clientX - lastX) < 1 && Math.abs(e.clientY - lastY) < 1) return;
    lastX = e.clientX; lastY = e.clientY;
    fire('touchmove', e, [mkTouch(e)]);
  }, { capture: true, passive: false });

  el.addEventListener('mouseup', function(e) {
    if (!isDown) return;
    isDown = false;
    fire('touchend', e, []);
  }, { capture: true, passive: false });

  el.addEventListener('mouseleave', function(e) {
    if (!isDown) return;
    isDown = false;
    fire('touchcancel', e, []);
  }, { capture: true, passive: false });

  // Override navigator.maxTouchPoints so Celtra detects touch capability
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 5; } });
  } catch(e) {}

  console.log('[AdCast] Touch emulator active');
})();
</script>
`;

app.get('/celtra-proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url parameter');

  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).send('Invalid URL'); }
  if (!parsed.hostname.endsWith('celtra.com')) {
    return res.status(403).send('Only celtra.com URLs are allowed');
  }

  try {
    const response = await fetch(target, {
      headers: {
        // iPhone UA so Celtra serves the mobile creative
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    const contentType = response.headers.get('content-type') || 'text/html';
    let body = await response.text();

    // Rewrite absolute root-relative URLs to load from Celtra directly
    body = body
      .replace(/(src|href)=["']\//g, `$1="https://${parsed.hostname}/`)
      .replace(/url\(\//g, `url(https://${parsed.hostname}/`);

    // Inject touch emulator immediately after <head> or <html> opening tag
    if (body.includes('<head>')) {
      body = body.replace('<head>', '<head>' + TOUCH_EMULATOR_SCRIPT);
    } else if (body.includes('<html')) {
      body = body.replace(/<html[^>]*>/, (m) => m + TOUCH_EMULATOR_SCRIPT);
    } else {
      body = TOUCH_EMULATOR_SCRIPT + body;
    }

    // Remove X-Frame-Options and CSP so the page loads in our iframe
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', '');
    res.send(body);
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
