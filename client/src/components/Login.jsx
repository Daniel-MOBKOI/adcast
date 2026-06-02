import { useState, useEffect } from 'react';
import styles from './Login.module.css';

export default function Login({ onAuth }) {
  const [password, setPassword]   = useState('');
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);
  const [extInstalled, setExtInstalled] = useState(false);

  // Check if the AdCast Recorder extension is active.
  // The content script sets data-adcast-ext="1" on <html> when present.
  useEffect(() => {
    const check = () => {
      const active = document.documentElement.getAttribute('data-adcast-ext') === '1';
      setExtInstalled(active);
    };
    check();
    // Re-check after a short delay (content script may not have run yet)
    const t = setTimeout(check, 800);
    return () => clearTimeout(t);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/publishers', {
        headers: { Authorization: `Bearer ${password}` }
      });
      if (res.ok) {
        onAuth(password);
      } else {
        setError('Incorrect password. Ask your team admin.');
      }
    } catch {
      setError('Could not reach server.');
    }
    setLoading(false);
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.wordmark}>MOBKOI</span>
          <div className={styles.sep} />
          <span className={styles.product}>AdCast</span>
        </div>

        <p className={styles.desc}>Enter the team password to continue.</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <input
            type="password"
            className={styles.input}
            placeholder="Team password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
          />
          {error && <p className={styles.error}>{error}</p>}
          <button type="submit" className={styles.btn} disabled={loading || !password}>
            {loading ? 'Checking…' : 'Sign in'}
          </button>
        </form>

        {/* Extension banner */}
        <div className={styles.extBanner}>
          {extInstalled ? (
            <div className={styles.extActive}>
              <span className={styles.extDot} />
              AdCast Recorder extension active
            </div>
          ) : (
            <div className={styles.extInstall}>
              <p className={styles.extMsg}>
                Install the AdCast Recorder extension to enable interactive ad recording in Chrome.
              </p>
              <a
                href="/adcast-extension.zip"
                download="adcast-extension.zip"
                className={styles.extLink}
              >
                ↓ Download extension
              </a>
              <p className={styles.extHint}>
                After downloading: open <strong>chrome://extensions</strong>, enable Developer mode, then drag the zip file onto the page.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
