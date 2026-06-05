import styles from './BottomBar.module.css';

export default function BottomBar({ step, title, nav }) {
  const canBack   = nav?.canBack ?? false;
  const canNext   = nav?.canNext ?? false;
  const nextLabel = nav?.nextLabel ?? 'Continue';
  const backLabel = nav?.backLabel ?? 'Back';
  const arrow     = nav?.arrow !== false;

  return (
    <footer className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.stepCount}>STEP {step} / 5</span>
        <span className={styles.title}>{title}</span>
      </div>

      <div className={styles.right}>
        {canBack && (
          <button className={styles.back} onClick={() => nav?.onBack?.()}>
            ← {backLabel}
          </button>
        )}
        <button
          className={styles.next}
          onClick={() => { if (canNext) nav?.onNext?.(); }}
          disabled={!canNext}
        >
          {nextLabel}{arrow ? ' →' : ''}
        </button>
      </div>
    </footer>
  );
}
