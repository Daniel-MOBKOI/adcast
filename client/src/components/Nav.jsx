import { clearToken } from '../api.js';
import styles from './Nav.module.css';

export default function Nav() {
  return (
    <div className={styles.navOuter}>
      <nav className={styles.nav}>
        <div className={styles.logo}>
          <span className={styles.wordmark}>MOBKOI</span>
          <div className={styles.sep} />
          <span className={styles.product}>AdCast</span>
        </div>
        <div className={styles.right}>
          <a
            href="#"
            className={styles.link}
            onClick={e => { e.preventDefault(); clearToken(); window.location.reload(); }}
          >
            Sign out
          </a>
        </div>
      </nav>
    </div>
  );
}
