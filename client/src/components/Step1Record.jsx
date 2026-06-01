import { useState, useEffect } from 'react';
import { useRecorder } from '../hooks/useRecorder.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './StepLayout.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// Turn a pasted Celtra preview URL (e.g. https://mobkoi-uk.celtra.com/preview/<id>)
// into the embeddable /frame endpoint with the same params the mobkoi.com site uses.
// This forces the mobile creative and the clean standalone phone render.
function celtraFrameUrl(raw) {
  try {
    const u = new URL(raw.trim());
    // normalise: drop any existing /frame, trailing slash, and query
    const path = u.pathname.replace(/\/frame\/?$/, '').replace(/\/$/, '');
    u.pathname = path + '/frame';
    u.search = '';
    u.searchParams.set('rp.useFullWidth', '1');
    u.searchParams.set('overrides.deviceInfo.deviceType', 'Phone');
    u.searchParams.set('rp._useSnapping', '1');
    u.searchParams.set('rp._snappingFraction', '0.5');
    u.searchParams.set('rp.standalonePreview', '1');
    return u.toString();
  } catch {
    return '';
  }
}

function proxyUrl(url) {
  const frame = celtraFrameUrl(url);
  if (!frame) return '';
  return '/celtra-proxy?url=' + encodeURIComponent(frame);
}

export default function Step1Record({ clipBlob, onClip, onNext }) {
  const [celtraUrl, setCeltraUrl] = useState('');
  const { state, duration, error, blob, start, stop, reset } = useRecorder();

  // Auto-load as soon as a URL is pasted
  const iframeUrl = celtraUrl.trim() ? proxyUrl(celtraUrl.trim()) : null;

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
  const isRecording = state === 'recording';

  return (
    <div className={styles.layout}>
      <div className={styles.sidebar}>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldHeader}>
            <span className={styles.fieldLabel}>Celtra preview link</span>
            <button
              className={styles.iconBtn}
              onClick={() => { const u = celtraUrl; setCeltraUrl(''); setTimeout(() => setCeltraUrl(u), 50); }}
              title="Reload ad"
              aria-label="Reload ad"
              disabled={!celtraUrl.trim()}
            >
              <i className="ti ti-refresh" aria-hidden="true" />
            </button>
          </div>
          <input
            className={styles.input}
            placeholder="https://mobkoi-uk.celtra.com/preview/…"
            value={celtraUrl}
            onChange={e => setCeltraUrl(e.target.value)}
          />
        </div>

        <div className={styles.divider} />

        {!clipReady && (
          <div className={styles.infoBox}>
            Interact with the ad in the phone frame — swipe between pages, tap elements and play video. When you're ready, hit the record button to capture your session.
          </div>
        )}

        {clipReady && (
          <>
            <div className={styles.clipCard}>
              <div className={styles.clipLabel}>Clip ready</div>
              <div className={styles.metaList}>
                <div className={styles.metaRow}>
                  <span className={styles.metaKey}>Duration</span>
                  <span className={styles.metaVal}>{fmtTime(duration)}</span>
                </div>
                <div className={styles.metaRow}>
                  <span className={styles.metaKey}>Format</span>
                  <span className={styles.metaVal}>WebM</span>
                </div>
              </div>
              <button className={styles.textBtn} onClick={reset}>Re-record</button>
            </div>
            <div className={styles.infoBox}>
              Clip captured. Continue to Step 2 to choose your publisher page.
            </div>
          </>
        )}

        {error && <p className={styles.errorMsg}>{error}</p>}
      </div>

      <div className={styles.centre}>
        <div className={styles.toolbar}>
          <button
            className={styles.tbtn}
            onClick={() => { const u = celtraUrl; setCeltraUrl(''); setTimeout(() => setCeltraUrl(u), 50); }}
            title="Reload ad"
            aria-label="Reload ad"
          >
            <i className="ti ti-refresh" aria-hidden="true" />
          </button>
          <div className={styles.tdiv} />
          <button
            className={`${styles.tbtn} ${isRecording ? styles.tbtnStop : styles.tbtnRec}`}
            onClick={handleRecordToggle}
            aria-label={isRecording ? 'Stop recording' : 'Start recording'}
            title={isRecording ? 'Stop recording' : 'Start recording'}
          >
            {isRecording
              ? <i className="ti ti-player-stop" aria-hidden="true" />
              : <i className="ti ti-circle-dot" aria-hidden="true" />
            }
          </button>
        </div>

        <IPhoneFrame>
          {iframeUrl ? (
            <div className={styles.iframeWrap}>
              {isRecording && (
                <div className={styles.recBadge}>
                  <span className={styles.recDot} />
                  {fmtTime(duration)}
                </div>
              )}
              <iframe
                key={iframeUrl}
                src={iframeUrl}
                className={styles.adIframe}
                scrolling="no"
                frameBorder="0"
                allow="autoplay; fullscreen; accelerometer; gyroscope"
                title="Celtra ad preview"
              />
            </div>
          ) : (
            <div className={styles.emptyScreen}>
              <i className="ti ti-link" aria-hidden="true" style={{ fontSize: 28, color: 'rgba(0,0,0,0.18)' }} />
              <div className={styles.emptyLabel}>Paste a Celtra link to begin</div>
            </div>
          )}
        </IPhoneFrame>

        <p className={styles.centreHint}>
          {isRecording
            ? `Recording ${fmtTime(duration)} · swipe, tap, play · hit ■ to stop`
            : clipReady
            ? 'Clip ready — continue to Step 2'
            : 'Interact with the ad · hit ● to record'}
        </p>
      </div>

      <div className={styles.navBar}>
        <span className={styles.navHint}>Step 1 of 3</span>
        <button className={styles.btnPrimary} onClick={onNext} disabled={!clipReady}>
          Next step →
        </button>
      </div>
    </div>
  );
}
