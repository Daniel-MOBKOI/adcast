/**
 * Auth middleware.
 *
 * Phase 1: shared team password via Authorization: Bearer <password> header.
 * The password is set via the ADCAST_PASSWORD environment variable in Render.
 *
 * Phase 2 (Google SSO): set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars
 * to enable — the stub below is where that logic goes. Flip the toggle without
 * touching any other code.
 */

const GOOGLE_SSO_ENABLED =
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function authMiddleware(req, res, next) {
  if (GOOGLE_SSO_ENABLED) {
    // TODO Phase 2: validate Google OAuth JWT, verify hd === 'mobkoi.com'
    return next();
  }

  // Phase 1: Bearer password
  const password = process.env.ADCAST_PASSWORD;
  if (!password) {
    console.warn('ADCAST_PASSWORD not set — auth disabled (dev mode)');
    return next();
  }

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (token === password) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}
