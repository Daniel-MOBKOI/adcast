import styles from './IPhoneFrame.module.css';

export default function IPhoneFrame({ children }) {
  return (
    <div className={styles.phone}>
      <div className={styles.volTop} />
      <div className={styles.volBot} />
      <div className={styles.pwr} />
      <div className={styles.shell}>
        <div className={styles.notch} />
        <div className={styles.screen}>
          {children}
        </div>
      </div>
    </div>
  );
}
