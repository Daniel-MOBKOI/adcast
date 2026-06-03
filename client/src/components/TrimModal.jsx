import { useState, useEffect, useRef, useCallback } from 'react';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './TrimModal.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return (
    m + ':' +
    String(Math.floor(s % 60)).padStart(2, '0') +
    '.' +
    String(Math.floor((s % 1) * 10))
  );
}

export default function TrimModal({ blob, duration, onConfirm, onReRecord }) {
  const videoRef  = useRef(null);
  const trackRef  = useRef(null);
  const [objectUrl, setObjectUrl] = useState(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd,   setTrimEnd]   = useState(duration);
  const [playing,   setPlaying]   = useState(false);
  const [dragging,  setDragging]  = useState(null);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  useEffect(() => { setTrimEnd(duration); }, [duration]);

  useEffect(() => {
    if (videoRef.current && !playing) {
      videoRef.current.currentTime = trimStart;
    }
  }, [trimStart, playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const check = () => {
      if (video.currentTime >= trimEnd) {
        video.pause();
        video.currentTime = trimStart;
        setPlaying(false);
      }
    };
    video.addEventListener('timeupdate', check);
    return () => video.removeEventListener('timeupdate', check);
  }, [trimStart, trimEnd]);

  function getPct(t)     { return (t / duration) * 100; }
  function pctToTime(p)  { return Math.max(0, Math.min(duration, (p / 100) * duration)); }

  function getTrackPct(clientX) {
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  }

  const onMouseMove = useCallback((e) => {
    if (!dragging) return;
    const t = pctToTime(getTrackPct(e.clientX));
    if (dragging === 'start') setTrimStart(Math.min(t, trimEnd - 0.5));
    else                      setTrimEnd(Math.max(t, trimStart + 0.5));
  }, [dragging, trimStart, trimEnd, duration]);

  const onMouseUp = useCallback(() => setDragging(null), []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, onMouseMove, onMouseUp]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (playing) { video.pause(); setPlaying(false); }
    else { video.currentTime = trimStart; video.play(); setPlaying(true); }
  }

  const trimDuration = trimEnd - trimStart;

  return (
    <div className={styles.overlay}>
      <div className={styles.inner}>

        {/* ── Left: controls ── */}
        <div className={styles.controls}>

          <div className={styles.header}>
            <span className={styles.title}>Trim clip</span>
            <span className={styles.subtitle}>
              Drag the handles to trim — keep from when the ad first appears.
            </span>
          </div>

          <div className={styles.divider} />

          {/* Duration badge */}
          <div className={styles.durationRow}>
            <span className={styles.durationLabel}>Selected</span>
            <span className={styles.durationValue}>{fmtTime(trimDuration)}</span>
          </div>

          {/* Timeline */}
          <div className={styles.timeline}>
            <div className={styles.times}>
              <span>{fmtTime(trimStart)}</span>
              <span>{fmtTime(trimEnd)}</span>
            </div>

            <div className={styles.track} ref={trackRef}>
              <div className={styles.trackBg} />
              <div
                className={styles.selected}
                style={{
                  left:  `${getPct(trimStart)}%`,
                  width: `${getPct(trimEnd) - getPct(trimStart)}%`,
                }}
              />
              <div className={styles.dimLeft}  style={{ width: `${getPct(trimStart)}%` }} />
              <div className={styles.dimRight} style={{ width: `${100 - getPct(trimEnd)}%` }} />

              <div
                className={styles.handle}
                style={{ left: `${getPct(trimStart)}%` }}
                onMouseDown={() => setDragging('start')}
              >
                <div className={styles.handleBar} />
              </div>
              <div
                className={styles.handle}
                style={{ left: `${getPct(trimEnd)}%` }}
                onMouseDown={() => setDragging('end')}
              >
                <div className={styles.handleBar} />
              </div>
            </div>
          </div>

          <div className={styles.divider} />

          {/* Play button */}
          <button className={styles.playRowBtn} onClick={togglePlay}>
            <span className={styles.playIcon}>
              <i className={`ti ${playing ? 'ti-player-pause' : 'ti-player-play'}`} />
            </span>
            <span>{playing ? 'Pause preview' : 'Preview clip'}</span>
          </button>

          <div className={styles.divider} />

          {/* Actions */}
          <div className={styles.actions}>
            <button
              className={styles.btnPrimary}
              onClick={() => onConfirm(trimStart, trimEnd)}
            >
              Use this clip →
            </button>
            <button className={styles.btnSecondary} onClick={onReRecord}>
              ↩ Re-record
            </button>
          </div>

        </div>

        {/* ── Right: phone frame with video ── */}
        <div className={styles.framePanel}>
          <IPhoneFrame>
            <div className={styles.videoScreen}>
              {objectUrl && (
                <video
                  ref={videoRef}
                  src={objectUrl}
                  className={styles.video}
                  playsInline
                  muted
                />
              )}
            </div>
          </IPhoneFrame>
        </div>

      </div>
    </div>
  );
}
