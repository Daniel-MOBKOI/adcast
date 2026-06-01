import { useState } from 'react';
import { useRecorder } from '../hooks/useRecorder.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './Step1Record.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// Route the Celtra URL through our server-side proxy which adds a mobile user agent
function proxyUrl(celtraUrl) {
  if (!celtraUrl) return '';
  return '/celtra-proxy?url=' + encodeURIComponent(celtraUrl);
}

export default function Step1Record({ clipBlob, onClip, onNext }) {
  const [celtraUrl, setCeltraUrl] = useState('');
  const [adLoaded, setAdLoaded] = useState(false);
  const { state, duration, error, blob, start, stop, reset } = useRecorder();

  function handleLoad() {
    if (celtraUrl.trim()) setAdLoaded(true);
  }

  function handleRecordToggle() {
    if (state === 'idle' || state === 'done' || state === 'error') {
      start();
    } else if (state === 'recording') {
      stop();
    }
  }

  if (state === 'done' && blob && blob !== clipBlob) {
    onClip(blob, duration);
  }

  const clipReady = !!clipBlob || (state === 'done' && blob);

  return (
    <div className={styles.layout}>
      <div className={styles.left}>
        <div className={styles.card}>
          <div className={styles.label}>Celtra preview link</div>
          <input
            className={styles.input}
            placeholder="https://mobkoi-uk.celtra.com/preview/…"
            value={celtraUrl}
            onChange={e => { setCeltraUrl(e.target.value); setAdLoaded(false); }}
            onKeyDown={e => e.key === 'Enter' && handleLoad()}
          />
          <p className={styles.hint}>Paste any Celtra preview URL — renders in mobile mode automatically.</p>
        </div>

        <button className={styles.btnSecondary} onClick={handleLoad} disabled={!celtraUrl.trim()}>
          ▶ Load ad
        </button>

        <div className={styles.divider} />

        <div className={styles.card}>
          <div className={styles.label}>Status</div>
          <div className={styles.statusRow}>
            <div className={`${styles.dot} ${state === 'recording' ? styles.dotRec : clipReady ? styles.dotReady : ''}`} />
            <span className={styles.statusText}>
              {state === 'idle' && !clipReady && 'Idle — load the ad to begin'}
              {state === 'requesting' && 'Waiting for browser permission…'}
              {state === 'recording' && `Recording ${fmtTime(duration)}`}
              {(state === 'done' || clipReady) && `Clip ready (${fmtTime(duration)})`}
              {state === 'error' && 'Error — see below'}
            </span>
          </div>
          <div className={styles.statRow}>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Duration</div>
              <div className={styles.statValue} style={{ color: duration ? '#111' : '#bbb' }}>
                {duration ? fmtTime(duration) : '—'}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Format</div>
              <div className={styles.statValue} style={{ color: '#bbb', fontSize: 12 }}>WebM</div>
            </div>
          </div>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.permBox}>
          When you click <strong>Record</strong>, your browser will ask to share this tab.
          Select <em>"This Tab"</em> and click Share — MOBKOI only captures the ad preview.
        </div>
      </div>

      <div className={styles.centre}>
        <div className={styles.toolbar}>
          <button className={styles.tbtn} onClick={handleLoad} title="Reload ad" aria-label="Reload ad">↺</button>
          <div className={styles.tdiv} />
          <div className={styles.dots}>
            <div className={`${styles.dot2} ${styles.dotActive}`} />
            <div className={styles.dot2} />
            <div className={styles.dot2} />
          </div>
          <div className={styles.tdiv} />
          <button
            className={`${styles.tbtn} ${state === 'recording' ? styles.tbtnStop : styles.tbtnRec}`}
            onClick={handleRecordToggle}
            aria-label={state === 'recording' ? 'Stop recording' : 'Start recording'}
            title={state === 'recording' ? 'Stop recording' : 'Start recording'}
          >
            {state === 'recording' ? '■' : '●'}
          </button>
        </div>

        <IPhoneFrame>
          {adLoaded && celtraUrl ? (
            <div className={styles.iframeWrap}>
              {state === 'recording' && (
                <div className={styles.recBadge}>
                  <span className={styles.recDot} />
                  {fmtTime(duration)}
                </div>
              )}
              <iframe
                src={proxyUrl(celtraUrl)}
                className={styles.adIframe}
                scrolling="no"
                frameBorder="0"
                allow="autoplay; fullscreen; accelerometer; gyroscope"
                title="Celtra ad preview"
              />
            </div>
          ) : (
            <div className={styles.emptyScreen}>
              <div className={styles.emptyIcon}>▶</div>
              <div className={styles.emptyLabel}>
                {celtraUrl ? 'Click "Load ad" to preview' : 'Paste a Celtra link to begin'}
              </div>
            </div>
          )}
        </IPhoneFrame>

        <p className={styles.hint2}>
          {state === 'recording'
            ? 'Interact with the ad — swipe, tap, play. Click ■ when done.'
            : clipReady
            ? 'Clip ready. Proceed to Step 2.'
            : 'Interact with the ad live, then hit ● to record'}
        </p>
      </div>

      <div className={styles.right}>
        <div className={styles.card}>
          <div className={styles.label}>Ad format</div>
          <div className={styles.metaList}>
            <div className={styles.metaRow}><span className={styles.metaKey}>Type</span><span className={styles.metaVal}>All-in-One</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Size</span><span className={styles.metaVal}>500 × 950</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Pages</span><span className={styles.metaVal}>3</span></div>
          </div>
        </div>
        {clipReady && (
          <div className={styles.card} style={{ borderColor: '#bbf7d0' }}>
            <div className={styles.label} style={{ color: '#16a34a' }}>Clip ready</div>
            <p className={styles.hint}>Recording captured. You can re-record or continue to Step 2.</p>
            <button className={styles.btnTextSm} onClick={reset}>Re-record</button>
          </div>
        )}
      </div>

      <div className={styles.navBar}>
        <span />
        <button className={styles.btnPrimary} onClick={onNext} disabled={!clipReady}>
          Next step →
        </button>
      </div>
    </div>
  );
}
