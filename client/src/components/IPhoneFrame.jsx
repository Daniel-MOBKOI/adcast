import styles from './IPhoneFrame.module.css';

/**
 * IPhoneFrame — pure-CSS device frame (no PNG asset).
 *
 * Renders a transparent-centre bezel overlay on top of `children`.
 * The screen area is exactly 1080:2184 so content (Celtra iframe,
 * publisher screenshot, export preview) is never distorted.
 *
 * Same interface as before: whatever you pass as children fills the
 * screen. The bezel + Dynamic Island sit on top with pointer-events:none,
 * so clicks / scroll pass straight through to the content underneath.
 */
export default function IPhoneFrame({ children, scroll = false }) {
  return (
    <div className={styles.outer}>
      <div
        className={`${styles.screen} ${scroll ? styles.scroll : ''}`}
      >
        {children}
      </div>
      <div className={styles.frame} aria-hidden="true" />
      <div className={styles.island} aria-hidden="true" />
    </div>
  );
}
