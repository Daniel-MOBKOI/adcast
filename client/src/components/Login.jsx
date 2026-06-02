import { useState } from 'react';
import styles from './Login.module.css';

export default function Login({ onAuth }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      </div>
    </div>
  );
}
