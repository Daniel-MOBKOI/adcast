import { useRef, useEffect } from 'react';
import styles from './RecordLightbox.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

/**
 * RecordLightbox — fullscreen overlay for clean ad recording.
 *
 * - iframe loads Celtra WITHOUT standalonePreview — no ad bars
 * - Recording timer sits OUTSIDE the iframe capture area
 * - iframe sized to 9:19.5 aspect ratio, fits 90vh
 */
export default function RecordLightbox({
  iframeUrl,
  recorderState,
  duration,
  error,
  iframeRef,
  onRecord,
  onStop,
  onClose,
}) {
  const isRecording  = recorderState === 'recording';
  const isRequesting = recorderState === 'requesting';
  const isDone       = recorderState === 'done';

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape' && !isRecording) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRecording, onClose]);

  useEffect(() => {
    if (isDone) onClose();
  }, [isDone, onClose]);

  return (
    <div className={styles.overlay}>
      <div className={styles.inner}>

        {/* ── Header — entirely outside capture area ── */}
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
                {isRequesting
                  ? 'Waiting for permission…'
                  : 'Interact with the ad, then hit record'}
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

        {/* ── Ad iframe — only this element is captured ── */}
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

        {/* ── Controls — entirely outside capture area ── */}
        <div className={styles.controls}>
          {error && <span className={styles.errorMsg}>{error}</span>}
          <button
            className={isRecording ? styles.stopBtn : styles.recordBtn}
            onClick={isRecording ? onStop : onRecord}
            disabled={isRequesting}
          >
            {isRecording
              ? '■ Stop recording'
              : isRequesting
              ? 'Starting…'
              : '● Start recording'}
          </button>
          {!isRecording && (
            <p className={styles.hint}>
              Hit stop when done — clip saves automatically.
            </p>
          )}
        </div>

      </div>
    </div>
  );
}
