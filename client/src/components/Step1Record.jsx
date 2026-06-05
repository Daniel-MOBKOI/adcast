import { useState, useRef, useEffect, useCallback } from 'react';
import { useRecorder } from '../hooks/useRecorder.js';
import { createMobileSession, pollMobileSession, fetchMobileClip } from '../api.js';
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

// Extract just the creative ID from whatever the user pasted
function extractCreativeId(input) {
  if (!input) return '';
  let id = input.trim();
  if (id.includes('/')) {
    const m = id.match(/\/preview\/([^/?#]+)/);
    id = m ? m[1] : '';
  }
  return /^[A-Za-z0-9]+$/.test(id) ? id : '';
}

// ── QR Code modal ──────────────────────────────────────────────────────────
function QRModal({ token, onClipReady, onClose }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [mobileStatus, setMobileStatus] = useState('waiting'); // waiting | uploading | ready | error
  const [mobileError, setMobileError] = useState(null);
  const pollRef = useRef(null);

  const recordUrl = `${window.location.origin}/mobile-record/${token}`;

  // Generate QR code using the qrcode library via CDN (loaded dynamically)
  useEffect(() => {
    let cancelled = false;
    async function generateQR() {
      try {
        // Dynamically load qrcode library
        if (!window.QRCode) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });
        }
        if (cancelled) return;

        // Render QR to a hidden canvas then export as data URL
        const container = document.createElement('div');
        document.body.appendChild(container);
        const qr = new window.QRCode(container, {
          text: recordUrl,
          width: 256,
          height: 256,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.M,
        });
        // Give it a tick to render
        await new Promise(r => setTimeout(r, 100));
        const canvas = container.querySelector('canvas');
        if (canvas && !cancelled) setQrDataUrl(canvas.toDataURL('image/png'));
        document.body.removeChild(container);
      } catch (err) {
        console.error('QR generation failed:', err);
      }
    }
    generateQR();
    return () => { cancelled = true; };
  }, [recordUrl]);

  // Poll for mobile upload status
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const { status, error } = await pollMobileSession(token);
        if (cancelled) return;
        setMobileStatus(status);
        if (status === 'ready') {
          clearInterval(pollRef.current);
          // Fetch the cropped clip blob and hand it back to Step1
          const blob = await fetchMobileClip(token);
          if (!cancelled) onClipReady(blob);
        } else if (status === 'error') {
          clearInterval(pollRef.current);
          setMobileError(error || 'Upload failed on server');
        }
      } catch (_) {}
    }
    pollRef.current = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(pollRef.current); };
  }, [token]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.75)',
      padding: 24,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: 40,
        maxWidth: 480, width: '100%', textAlign: 'center',
        boxShadow: '0 24px 80px rgba(0,0,0,0.3)',
        maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
      }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: '#111' }}>
          Record on mobile
        </h2>

        {mobileStatus === 'waiting' || mobileStatus === 'uploading' ? (
          <>
            <p style={{ fontSize: 14, color: '#666', marginBottom: 24, lineHeight: 1.5 }}>
              {mobileStatus === 'waiting'
                ? 'Scan this QR code with your iPhone camera to open the ad.'
                : 'Upload received — processing your clip…'}
            </p>

            {mobileStatus === 'waiting' && (
              <>
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="QR code"
                    style={{ width: 200, height: 200, margin: '0 auto 20px', display: 'block', borderRadius: 8 }}
                  />
                ) : (
                  <div style={{
                    width: 200, height: 200, margin: '0 auto 20px',
                    background: '#f5f5f5', borderRadius: 8,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#999', fontSize: 13,
                  }}>
                    Generating…
                  </div>
                )}

                <ol style={{ textAlign: 'left', fontSize: 13, color: '#555', lineHeight: 1.8, paddingLeft: 20, marginBottom: 24 }}>
                  <li>Scan the QR code with your iPhone</li>
                  <li>Swipe up → tap the Screen Recording button</li>
                  <li>Interact with the ad</li>
                  <li>Stop recording, then tap <strong>Done recording</strong> in the page</li>
                  <li>Choose the video from Photos to upload</li>
                </ol>

                <div style={{
                  background: '#f5f5f5', borderRadius: 8, padding: '10px 14px',
                  fontSize: 12, color: '#888', wordBreak: 'break-all', marginBottom: 20,
                }}>
                  {recordUrl}
                </div>
              </>
            )}

            {mobileStatus === 'uploading' && (
              <div style={{ padding: '32px 0' }}>
                <div style={{
                  width: 48, height: 48, border: '3px solid #e5e5e5',
                  borderTop: '3px solid #111', borderRadius: '50%',
                  margin: '0 auto 16px',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <p style={{ fontSize: 13, color: '#888' }}>Processing and cropping your clip…</p>
              </div>
            )}

            <button
              onClick={onClose}
              style={{
                background: 'transparent', border: '1px solid #ddd',
                borderRadius: 8, padding: '10px 20px',
                fontSize: 14, color: '#666', cursor: 'pointer', width: '100%',
              }}
            >
              Cancel
            </button>
          </>
        ) : mobileStatus === 'error' ? (
          <>
            <p style={{ color: '#c00', fontSize: 14, marginBottom: 20 }}>
              {mobileError || 'Something went wrong. Please try again.'}
            </p>
            <button onClick={onClose} style={{
              background: '#111', color: '#fff', border: 'none',
              borderRadius: 8, padding: '12px 24px', fontSize: 14, cursor: 'pointer',
            }}>
              Close
            </button>
          </>
        ) : null}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function Step1Record({ onRecordingDone }) {
  const [celtraUrl, setCeltraUrl]       = useState('');
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [cropRect, setCropRect]         = useState(null);

  // Mobile QR state
  const [mobileToken, setMobileToken]   = useState(null);
  const [mobileLoading, setMobileLoading] = useState(false);

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
      // Desktop recording — no cropRect needed for mobile path, pass null for mobile
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

  function handleMounted(cssRect) {
    setCropRect({
      x:      Math.round(cssRect.x),
      y:      Math.round(cssRect.y),
      width:  Math.round(cssRect.width),
      height: Math.round(cssRect.height),
    });
  }

  // ── Mobile recording ───────────────────────────────────────────────────
  async function handleMobileRecord() {
    const creativeId = extractCreativeId(celtraUrl);
    if (!creativeId) return;
    setMobileLoading(true);
    try {
      const { token } = await createMobileSession(creativeId);
      setMobileToken(token);
    } catch (err) {
      console.error('Failed to create mobile session:', err);
    } finally {
      setMobileLoading(false);
    }
  }

  function handleMobileClipReady(blob) {
    setMobileToken(null);
    // Mobile clip is already cropped to 1080×2184 and has no cropRect needed
    // Duration unknown at this point — pass 0, Step2Trim will probe it from the video element
    onRecordingDone(blob, 0, null);
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
            {/* Phase 2 — Record on mobile (hidden until mobile flow is complete)
            <button
              className={styles.btnSecondary}
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleMobileRecord}
              disabled={!hasCreative || mobileLoading}
            >
              {mobileLoading ? 'Generating…' : '📱 Record on mobile'}
            </button>
            */}
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
          onRecord={() => beginRecording(lightboxIframeRef)}
          onStop={stop}
          onClose={handleCloseLightbox}
          onMounted={handleMounted}
        />
      )}

      {mobileToken && (
        <QRModal
          token={mobileToken}
          onClipReady={handleMobileClipReady}
          onClose={() => setMobileToken(null)}
        />
      )}
    </>
  );
}
