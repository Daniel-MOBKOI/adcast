import styles from './StepBar.module.css';

const STEPS = ['Record', 'Publisher', 'Export'];

export default function StepBar({ step, onStep, clipReady, publisherReady }) {
  function canGoTo(n) {
    if (n === 1) return true;
    if (n === 2) return clipReady;
    if (n === 3) return clipReady && publisherReady;
    return false;
  }

  return (
    <div className={styles.bar}>
      {STEPS.map((label, i) => {
        const n = i + 1;
        const active = step === n;
        const done = step > n;
        const enabled = canGoTo(n);
        return (
          <button
            key={n}
            className={`${styles.step} ${active ? styles.active : ''} ${done ? styles.done : ''}`}
            onClick={() => enabled && onStep(n)}
            disabled={!enabled}
          >
            <span className={styles.num}>
              {done ? '✓' : n}
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
