import { clearToken } from '../api.js';
import styles from './TopBar.module.css';

const STEPS = ['Source', 'Record', 'Trim', 'Publish', 'Export'];

export default function TopBar({ step, onStep, rawReady, clipReady, publisherReady }) {
  function canGoTo(n) {
    if (n === 1) return true;
    if (n === 2 || n === 3) return rawReady;
    if (n === 4) return clipReady;
    if (n === 5) return clipReady && publisherReady;
    return false;
  }

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.logo} />
        <span className={styles.name}>Ad Cast</span>
      </div>

      <nav className={styles.rail}>
        {STEPS.map((label, i) => {
          const n = i + 1;
          const active  = step === n;
          const done    = step > n;
          const enabled = canGoTo(n);
          return (
            <span key={label} className={styles.railItem}>
              <button
                className={`${styles.step} ${active ? styles.active : ''} ${done ? styles.done : ''}`}
                onClick={() => enabled && onStep(n)}
                disabled={!enabled}
              >
                <span className={styles.num}>{done ? '✓' : n}</span>
                <span className={styles.label}>{label}</span>
              </button>
              {n < STEPS.length && <span className={styles.connector} />}
            </span>
          );
        })}
      </nav>

      <div className={styles.account}>
        <button className={styles.saveExit} onClick={() => { clearToken(); window.location.reload(); }}>
          Sign out
        </button>
      </div>
    </header>
  );
}
