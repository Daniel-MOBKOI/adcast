import { useState, useRef, useEffect } from 'react';
import { useRecorder } from '../hooks/useRecorder.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import RecordLightbox from './RecordLightbox.jsx';
import styles from './StepLayout.module.css';

function creativeFrameUrl(input, { standalone = true } = {}) {
  if (!input) return '';
  let id = input.trim();
  if (id.includes('/')) {
    const m = id.match(/\/preview\/([^/?#]+)/);
    id = m ? m[1] : '';
  }
  if (!/^[A-Za-z0-9]+$/.test(id)) return '';
  const f = new URL('https://preview-sandbox.celtra.com/preview/' + id + '/frame');
  f.searchParams.set('rp.useFullWidth', '1');
  f.searchParams.set('overrides.deviceInfo.deviceType', 'Phone');
  f.searchParams.set('rp._useSnapping', '1');
  f.searchParams.set('rp._snappingFraction', '0.5');
  if (standalone) {
    f.searchParams.set('rp.standalonePreview', '1');
  } else {
    f.searchParams.set('rp.removeAdvertisementBars', '1');
    f.searchParams.set('rp.standalonePreview', '1');
  }
  return f.toString();
}

export default function Step1Record({ onRecordingDone }) {
  const [celtraUrl, setCeltraUrl]       = useState('');
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [cropRect, setCropRect]         = useState(null);

  const { state, duration, error, blob, requestStream, beginRecording, stop, reset } = useRecorder();

  const lightboxIframeRef = useRef(null);
  const prevStateRef      = useRef('idle');

  useEffect(() => {
    if (prevStateRef.current !== 'streamReady' && state === 'streamReady') {
      setLightboxOpen(true);
    }
    prevStateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (state === 'done' && blob) {
      setLightboxOpen(false);
      onRecordingDone(blob, duration, cropRect);
    }
  }, [state, blob]);

  function handleReload() {
    const u = celtraUrl;
    setCeltraUrl('');
    setTimeout(() => setCeltraUrl(u), 50);
  }

  async function handleOpenLightbox() {
    reset();
    setCropRect(null);
    await requestStream();
  }

  function handleCloseLightbox() {
    if (state === 'recording') return;
    setLightboxOpen(false);
  }

  // Called by RecordLightbox after 200ms once the portal has painted.
  // Converts CSS-pixel rect to physical pixels using devicePixelRatio.
  function handleMounted(cssRect) {
    const dpr = window.devicePixelRatio || 1;
    setCropRect({
      x:      Math.round(cssRect.x      * dpr),
      y:      Math.round(cssRect.y      * dpr),
      width:  Math.round(cssRect.width  * dpr),
      height: Math.round(cssRect.height * dpr),
    });
  }

  const previewUrl  = celtraUrl.trim() ? creativeFrameUrl(celtraUrl.trim(), { standalone: true })  : null;
  const recordUrl   = celtraUrl.trim() ? creativeFrameUrl(celtraUrl.trim(), { standalone: false }) : null;
  const hasCreative = !!celtraUrl.trim() && !!previewUrl;

  return (
    <>
      <div className={styles.layout}>
        <div className={styles.sidebar}>
          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <span className={styles.fieldLabel}>Celtra creative ID or link</span>
              <button className={styles.iconBtn} onClick={handleReload} title="Reload ad" disabled={!celtraUrl.trim()}>
                <i className="ti ti-refresh" aria-hidden="true" />
              </button>
            </div>
            <input
              className={styles.input}
              placeholder="3b32c8f0  or  https://mobkoi-uk.celtra.com/preview/…"
              value={celtraUrl}
              onChange={e => setCeltraUrl(e.target.value)}
            />
          </div>
          <div className={styles.divider} />
          <div className={styles.infoBox}>
            Preview the ad in the phone frame to check it looks right. When ready,
            hit <strong>Open recorder</strong> to capture your session in a clean full-screen view.
          </div>
          {error && <p className={styles.errorMsg}>{error}</p>}
          <div style={{ marginTop: 'auto' }}>
            <button
              className={styles.btnPrimary}
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleOpenLightbox}
              disabled={!hasCreative}
            >
              ● Open recorder
            </button>
          </div>
        </div>

        <div className={styles.centre}>
          <div className={styles.toolbar}>
            <button className={styles.tbtn} onClick={handleReload} title="Reload ad">
              <i className="ti ti-refresh" aria-hidden="true" />
            </button>
          </div>
          <IPhoneFrame>
            {previewUrl ? (
              <div className={styles.iframeWrap}>
                <div className={styles.creativeStage}>
                  <div className={styles.celtraBleed}>
                    <div className={styles.celtraWrap}>
                      <iframe
                        key={previewUrl}
                        src={previewUrl}
                        className={styles.celtraFrame}
                        allow="camera; microphone; autoplay; fullscreen; accelerometer; gyroscope"
                        allowFullScreen
                        title="Celtra ad preview"
                      />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className={styles.emptyScreen}>
                <i className="ti ti-link" aria-hidden="true" style={{ fontSize: 28, color: 'rgba(0,0,0,0.18)' }} />
                <div className={styles.emptyLabel}>Paste a Celtra link to begin</div>
              </div>
            )}
          </IPhoneFrame>
          <p className={styles.centreHint}>
            {hasCreative ? 'Preview looks good? Hit "Open recorder" in the sidebar' : 'Paste a Celtra ID or link to load the ad'}
          </p>
        </div>

        <div className={styles.navBar}>
          <span className={styles.navHint}>Step 1 of 4</span>
          <button className={styles.btnPrimary} disabled>Record to continue →</button>
        </div>
      </div>

      {lightboxOpen && recordUrl && (
        <RecordLightbox
          iframeUrl={recordUrl}
          recorderState={state}
          duration={duration}
          error={error}
          iframeRef={lightboxIframeRef}
          onRecord={() => beginRecording()}
          onStop={stop}
          onClose={handleCloseLightbox}
          onMounted={handleMounted}
        />
      )}
    </>
  );
}
