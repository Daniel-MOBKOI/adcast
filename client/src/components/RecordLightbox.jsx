import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './RecordLightbox.module.css';

function injectTouchEmulator(iframe) {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;
    const script = doc.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hammer.js@2.0.8/hammer.min.js';
    script.onload = () => {
      const emScript = doc.createElement('script');
      emScript.textContent = `
        (function() {
          var el = document.documentElement;
          var touching = false;
          function mouseToTouch(type, e) {
            var touch = new Touch({
              identifier: 1, target: e.target,
              clientX: e.clientX, clientY: e.clientY,
              screenX: e.screenX, screenY: e.screenY,
              pageX: e.pageX, pageY: e.pageY,
            });
            var te = new TouchEvent(type, {
              cancelable: true, bubbles: true,
              touches: type === 'touchend' ? [] : [touch],
              targetTouches: type === 'touchend' ? [] : [touch],
              changedTouches: [touch],
            });
            e.target.dispatchEvent(te);
          }
          el.addEventListener('mousedown', function(e) { touching = true;  mouseToTouch('touchstart', e); }, {passive: false});
          el.addEventListener('mousemove', function(e) { if (touching) mouseToTouch('touchmove', e); },   {passive: false});
          el.addEventListener('mouseup',   function(e) { touching = false; mouseToTouch('touchend', e); }, {passive: false});
        })();
      `;
      doc.body.appendChild(emScript);
    };
    doc.head.appendChild(script);
  } catch(e) {
    console.warn('Touch emulator injection blocked (cross-origin):', e.message);
  }
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

export default function RecordLightbox({
  iframeUrl, recorderState, duration, error,
  iframeRef, onRecord, onStop, onClose,
}) {
  const isRecording   = recorderState === 'recording';
  const isRequesting  = recorderState === 'requesting';
  const isStreamReady = recorderState === 'streamReady';
  const isDone        = recorderState === 'done';

  // ── Fake cursor — tracks at document level, covers entire page ──────────────
  const [cursor, setCursor] = useState({ x: -100, y: -100, pressed: false });

  useEffect(() => {
    // Hide real cursor on entire page while lightbox is open
    document.documentElement.style.cursor = 'none';

    const onMove  = e => setCursor(c => ({ ...c, x: e.clientX, y: e.clientY }));
    const onDown  = () => setCursor(c => ({ ...c, pressed: true }));
    const onUp    = () => setCursor(c => ({ ...c, pressed: false }));

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup',   onUp);

    return () => {
      // Restore real cursor when lightbox closes
      document.documentElement.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup',   onUp);
    };
  }, []);

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape' && !isRecording) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRecording, onClose]);

  useEffect(() => {
    if (isDone) onClose();
  }, [isDone, onClose]);

  return createPortal(
    <>
      {/* Fake touch cursor — fixed to viewport, always on top */}
      <div
        className={styles.fakeCursor}
        style={{
          left: cursor.x,
          top:  cursor.y,
          transform: `translate(-50%, -50%) scale(${cursor.pressed ? 0.6 : 1})`,
        }}
      />

      <div className={styles.overlay}>
        <div className={styles.inner}>

          <div className={styles.header}>
            <div className={styles.headerLeft}>
              {isRecording && (
                <div className={styles.recPill}>
                  <span className={styles.recDot} />
                  {fmtTime(duration)}
                </div>
              )}
              {!isRecording && (
                <span className={styles.headerLabel}>
                  {isRequesting   ? 'Waiting for permission…'
                  : isStreamReady ? 'Ad loaded — interact freely, then hit record'
                  :                 'Interact with the ad, then hit record'}
                </span>
              )}
            </div>
            <button
              className={styles.closeBtn}
              onClick={onClose}
              disabled={isRecording}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className={styles.frameWrap}>
            <iframe
              ref={iframeRef}
              src={iframeUrl}
              className={styles.frame}
              allow="camera; microphone; autoplay; fullscreen; accelerometer; gyroscope"
              allowFullScreen
              title="Celtra ad — record mode"
              scrolling="no"
              frameBorder="0"
            />
          </div>

          <div className={styles.controls}>
            {error && <span className={styles.errorMsg}>{error}</span>}
            <button
              className={isRecording ? styles.stopBtn : styles.recordBtn}
              onClick={isRecording ? onStop : onRecord}
              disabled={isRequesting}
            >
              {isRecording ? '■ Stop recording'
                : isRequesting ? 'Starting…'
                : '● Start recording'}
            </button>
            {!isRecording && (
              <p className={styles.hint}>Hit stop when done — clip saves automatically.</p>
            )}
          </div>

        </div>
      </div>
    </>,
    document.body
  );
}
