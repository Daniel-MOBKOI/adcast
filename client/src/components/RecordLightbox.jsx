import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './RecordLightbox.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

export default function RecordLightbox({
  iframeUrl, recorderState, duration, error,
  iframeRef, onRecord, onStop, onClose, onMounted,
}) {
  const isRecording   = recorderState === 'recording';
  const isRequesting  = recorderState === 'requesting';
  const isStreamReady = recorderState === 'streamReady';
  const isDone        = recorderState === 'done';

  const frameWrapRef = useRef(null);

  // Measure the phone frame after the portal has fully painted.
  // 200ms timeout is critical — without it the div hasn't laid out yet.
  useEffect(() => {
    if (!onMounted) return;
    const id = setTimeout(() => {
      if (frameWrapRef.current) {
        const rect = frameWrapRef.current.getBoundingClientRect();
        onMounted({
          x:      rect.left,
          y:      rect.top,
          width:  rect.width,
          height: rect.height,
        });
      }
    }, 200);
    return () => clearTimeout(id);
  }, []); // run once on mount

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape' && !isRecording) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRecording, onClose]);

  useEffect(() => {
    if (isDone) onClose();
  }, [isDone, onClose]);

  return createPortal(
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
          <button className={styles.closeBtn} onClick={onClose} disabled={isRecording} aria-label="Close">✕</button>
        </div>

        <div className={styles.frameWrap} ref={frameWrapRef}>
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
            {isRecording ? '■ Stop recording' : isRequesting ? 'Starting…' : '● Start recording'}
          </button>
          {!isRecording && (
            <p className={styles.hint}>Hit stop when done — clip saves automatically.</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
