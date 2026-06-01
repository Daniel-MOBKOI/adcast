import { useRef, useEffect } from 'react';
import styles from './RecordLightbox.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

/**
 * RecordLightbox — fullscreen overlay for clean ad recording.
 *
 * - Renders the Celtra iframe WITHOUT standalonePreview=1, removing the
 *   "Advertisement" and "Scroll to continue" bars.
 * - Scales the iframe to fit 90vh while maintaining the 9:19.5 ad aspect ratio.
 * - Exposes the iframe element via iframeRef for cropTo() element capture.
 * - Minimal UI: just a record/stop button and timer — nothing else in frame.
 */
export default function RecordLightbox({
  iframeUrl,       // URL without standalonePreview — pure creative
  recorderState,   // 'idle' | 'requesting' | 'recording' | 'done' | 'error'
  duration,
  error,
  iframeRef,       // passed in so parent can use it for cropTo()
  onRecord,
  onStop,
  onClose,
}) {
  const isRecording = recorderState === 'recording';
  const isRequesting = recorderState === 'requesting';
  const isDone = recorderState === 'done';

  // Close on Escape
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape' && !isRecording) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRecording, onClose]);

  // Auto-close when recording finishes
  useEffect(() => {
    if (isDone) onClose();
  }, [isDone, onClose]);

  return (
    <div className={styles.overlay}>
      <div className={styles.inner}>

        {/* Header bar — minimal, outside the recording area */}
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            {isRecording
              ? `Recording ${fmtTime(duration)}`
              : isRequesting
              ? 'Waiting for permission…'
              : 'Ready to record — interact with the ad, then hit record'}
          </span>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            disabled={isRecording}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* The ad frame — viewport-relative sizing, 9:19.5 aspect ratio */}
        <div className={styles.frameWrap}>
          {isRecording && (
            <div className={styles.recBadge}>
              <span className={styles.recDot} />
              {fmtTime(duration)}
            </div>
          )}
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

        {/* Controls — outside the recording area */}
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
              Interact with the ad above first, then hit record when ready.
              Hit stop when done — the clip will be saved automatically.
            </p>
          )}
        </div>

      </div>
    </div>
  );
}
