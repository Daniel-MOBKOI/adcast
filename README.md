# AdCast — MOBKOI

Internal web app: Celtra ad → publisher-in-context MP4.

---

## Local development

**Prerequisites:** Node 18+, ffmpeg, Playwright Chromium

```bash
# 1. Install dependencies
npm install
npm install --prefix server
npm install --prefix client

# 2. Install Playwright's Chromium
cd server && npx playwright install chromium && cd ..

# 3. Set the team password (skip in dev — auth is disabled if unset)
export ADCAST_PASSWORD=yourpassword

# 4. Start both server and client in parallel
npm run dev
```

- React dev server: http://localhost:5173
- Express API: http://localhost:3001

---

## Deploy to Render

### One-time setup

1. Push this folder to a new GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Initial AdCast build"
   git remote add origin https://github.com/YOUR_ORG/adcast.git
   git push -u origin main
   ```

2. In [Render dashboard](https://dashboard.render.com):
   - New → Web Service
   - Connect your GitHub repo
   - Render auto-detects `render.yaml` — click **Apply**

3. Set the environment variable:
   - Go to your service → Environment
   - Add `ADCAST_PASSWORD` = your chosen team password

4. Click **Deploy** — first deploy takes ~5 min (installs Playwright + Chromium).

### Subsequent deploys
Push to `main` — Render auto-deploys.

---

## Adding publisher screenshots

Drop full-bleed portrait JPGs into `server/publishers/` and add an entry to the `BUILTIN` array in `server/src/routes/publishers.mjs`:

```js
{ id: 'my-pub', label: 'My Publisher', file: 'my-publisher.jpg' },
```

Or use the Upload button in the app UI (stored in `server/uploads/`).

---

## Auth

**Phase 1 (current):** shared team password via `ADCAST_PASSWORD` env var.

**Phase 2 (Google SSO):** set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Render — the `auth.mjs` stub is ready for the implementation. Restrict to `@mobkoi.com` domain.

---

## Project structure

```
adcast-web/
  server/
    src/
      index.mjs          Express entry point
      auth.mjs           Password / SSO middleware
      compositor.mjs     Playwright + ffmpeg engine (adapted from CLI prototype)
      routes/
        publishers.mjs   GET /api/publishers, POST /api/publishers/upload
        jobs.mjs         POST /api/jobs, GET /api/jobs/:id, GET /api/jobs/:id/download
    publishers/          Seeded publisher screenshots
    uploads/             Runtime-uploaded screenshots
    jobs/                Temp job files (webm input + mp4 output)
  client/
    src/
      App.jsx            Three-step shell + login gate
      api.js             Fetch wrapper with Bearer auth
      hooks/
        useRecorder.js   getDisplayMedia tab capture hook
      components/
        Nav.jsx
        StepBar.jsx
        Login.jsx
        IPhoneFrame.jsx
        Step1Record.jsx  Celtra preview + recorder
        Step2Publisher.jsx Publisher library picker
        Step3Export.jsx  Job submission + polling + download
  render.yaml            Render deploy config
```
