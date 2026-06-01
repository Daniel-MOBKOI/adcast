import styles from './IPhoneFrame.module.css';

/**
 * IPhoneFrame — overlays the real MOBKOI iPhone frame PNG on top of content.
 *
 * Original image: 785 × 1609 px
 * Screen area:    x=18..769 (752px wide), y=15..1596 (1582px tall)
 * Screen as % of image: left=2.29%, top=0.93%, width=95.8%, height=98.3%
 *
 * The frame PNG sits on top via pointer-events:none so all clicks
 * pass through to the iframe underneath.
 */
export default function IPhoneFrame({ children }) {
  return (
    <div className={styles.outer}>
      <div className={styles.screen}>
        {children}
      </div>
      <img
        src="/iphone-frame.png"
        className={styles.frame}
        alt=""
        aria-hidden="true"
        draggable="false"
      />
    </div>
  );
}
