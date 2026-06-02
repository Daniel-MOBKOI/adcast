import { useState, useRef } from 'react';
import { useRecorder } from '../hooks/useRecorder.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import RecordLightbox from './RecordLightbox.jsx';
import styles from './StepLayout.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

/**
 * Build the Celtra preview URL.
 * standalonePreview=1 → used in the phone frame preview (shows ad bars).
 * standalonePreview omitted → used in the recording lightbox (pure creative).
 */
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
    // Recording mode — remove all Celtra chrome
    f.searchParams.set('rp.removeAdvertisementBars', '1');
    f.searchParams.set('rp.standalonePreview', '0');
  }
  return f.toString();
}

export default function Step1Record({ clipBlob, onClip, onNext }) {
  const [celtraUrl, setCeltraUrl] = useState('');
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { state, duration, error, blob, start, stop, reset } = useRecorder();

  // Ref to the iframe inside the lightbox — passed to cropTo()
  const lightboxIframeRef = useRef(null);

  // Preview URL (with standalone chrome) — shown in phone frame
  const previewUrl = celtraUrl.trim() ? creativeFrameUrl(celtraUrl.trim(), { standalone: true }) : null;

  // Recording URL — direct Celtra embed (no proxy, proxy breaks Celtra JS)
  // Touch emulation handled by AdCast Recorder Chrome extension
  const recordUrl = celtraUrl.trim() ? creativeFrameUrl(celtraUrl.trim(), { standalone: false }) : null;

  function handleReload() {
    const u = celtraUrl;
    setCeltraUrl('');
    setTimeout(() => setCeltraUrl(u), 50);
  }

  function handleOpenLightbox() {
    reset(); // clear any previous recording
    setLightboxOpen(true);
  }

  function handleCloseLightbox() {
    if (state === 'recording') return; // don't allow close mid-recording
    setLightboxOpen(false);
  }

  function handleRecord() {
    start(lightboxIframeRef);
  }

  // When recording finishes, lift the blob up and close the lightbox
  if (state === 'done' && blob && blob !== clipBlob) {
    onClip(blob, duration);
    // lightbox auto-closes via useEffect in RecordLightbox
  }

  const clipReady = !!clipBlob || (state === 'done' && blob);
  const hasCreative = !!celtraUrl.trim() && !!previewUrl;

  return (
    <>
      <div className={styles.layout}>
        <div className={styles.sidebar}>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <span className={styles.fieldLabel}>Celtra creative ID or link</span>
              <button
                className={styles.iconBtn}
                onClick={handleReload}
                title="Reload ad"
                aria-label="Reload ad"
                disabled={!celtraUrl.trim()}
              >
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

          {!clipReady && (
            <div className={styles.infoBox}>
              Preview the ad in the phone frame to check it looks right. When
              ready, hit <strong>Open recorder</strong> to capture your session
              in a clean full-screen view.
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
                <button className={styles.textBtn} onClick={() => { reset(); setLightboxOpen(false); }}>
                  Re-record
                </button>
              </div>
              <div className={styles.infoBox}>
                Clip captured. Continue to Step 2 to choose your publisher page.
              </div>
            </>
          )}

          {error && <p className={styles.errorMsg}>{error}</p>}

          <div style={{ marginTop: 'auto' }}>
            <button
              className={styles.btnPrimary}
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleOpenLightbox}
              disabled={!hasCreative}
            >
              {clipReady ? '↺ Re-record' : '● Open recorder'}
            </button>
          </div>

        </div>

        <div className={styles.centre}>
          <div className={styles.toolbar}>
            <button
              className={styles.tbtn}
              onClick={handleReload}
              title="Reload ad"
              aria-label="Reload ad"
            >
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
            {clipReady
              ? 'Clip ready — continue to Step 2'
              : hasCreative
              ? 'Preview looks good? Hit "Open recorder" in the sidebar'
              : 'Paste a Celtra ID or link to load the ad'}
          </p>
        </div>

        <div className={styles.navBar}>
          <span className={styles.navHint}>Step 1 of 3</span>
          <button className={styles.btnPrimary} onClick={onNext} disabled={!clipReady}>
            Next step →
          </button>
        </div>
      </div>

      {lightboxOpen && recordUrl && (
        <RecordLightbox
          iframeUrl={recordUrl}
          recorderState={state}
          duration={duration}
          error={error}
          iframeRef={lightboxIframeRef}
          onRecord={handleRecord}
          onStop={stop}
          onClose={handleCloseLightbox}
        />
      )}
    </>
  );
}
