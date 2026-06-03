import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './Step2Trim.module.css';
import layoutStyles from './StepLayout.module.css';

const THUMB_COUNT = 16;

function fmtTime(s) {
  s = Math.max(0, s);
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms  = Math.floor((s % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${ms}`;
}

async function extractThumbs(url, duration, count) {
  const video   = document.createElement('video');
  video.src     = url;
  video.muted   = true;
  video.preload = 'auto';
  await new Promise(res => { video.onloadedmetadata = res; video.load(); });

  const canvas  = document.createElement('canvas');
  canvas.width  = 120;
  canvas.height = Math.round(120 / (video.videoWidth / video.videoHeight));
  const ctx     = canvas.getContext('2d');
  const thumbs  = [];

  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * duration;
    video.currentTime = t;
    await new Promise(res => { video.onseeked = res; });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
  }
  return thumbs;
}

export default function Step2Trim({ blob, duration, onConfirm, onReRecord, onBack }) {
  const videoRef  = useRef(null);
  const trackRef  = useRef(null);

  const [objectUrl, setObjectUrl] = useState(null);
  const [thumbs,    setThumbs]    = useState([]);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd,   setTrimEnd]   = useState(duration);
  const [playing,   setPlaying]   = useState(false);
  const [dragging,  setDragging]  = useState(null);
  const [currentT,  setCurrentT]  = useState(0);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    extractThumbs(url, duration, THUMB_COUNT).then(setThumbs);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  useEffect(() => { setTrimEnd(duration); }, [duration]);

  // Seek to trimStart when start handle moves (not while playing)
  useEffect(() => {
    const v = videoRef.current;
    if (v && !playing && dragging === 'start') {
      v.currentTime = trimStart;
      setCurrentT(trimStart);
    }
  }, [trimStart]);

  // Seek to trimEnd when end handle moves (not while playing)
  useEffect(() => {
    const v = videoRef.current;
    if (v && !playing && dragging === 'end') {
      v.currentTime = trimEnd;
      setCurrentT(trimEnd);
    }
  }, [trimEnd]);

  // Seek to trimStart when drag is released (always)
  useEffect(() => {
    if (dragging !== null) return; // only fires on release
    const v = videoRef.current;
    if (v && !playing) {
      v.currentTime = trimStart;
      setCurrentT(trimStart);
    }
  }, [dragging]);

  // Loop within trim region + track playhead
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const check = () => {
      setCurrentT(v.currentTime);
      if (v.currentTime >= trimEnd) {
        v.pause(); v.currentTime = trimStart; setPlaying(false);
      }
    };
    v.addEventListener('timeupdate', check);
    return () => v.removeEventListener('timeupdate', check);
  }, [trimStart, trimEnd]);

  function getPct(t)    { return (t / duration) * 100; }
  function pctToTime(p) { return Math.max(0, Math.min(duration, (p / 100) * duration)); }

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
    if (!dragging) return;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',  onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',  onMouseUp);
    };
  }, [dragging, onMouseMove, onMouseUp]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (playing) { v.pause(); setPlaying(false); }
    else         { v.currentTime = trimStart; v.play(); setPlaying(true); }
  }

  const trimDuration = trimEnd - trimStart;
  const startPct     = getPct(trimStart);
  const endPct       = getPct(trimEnd);
  const playheadPct  = getPct(Math.min(currentT, trimEnd));

  return (
    <div className={layoutStyles.layout}>

      {/* LEFT SIDEBAR */}
      <div className={layoutStyles.sidebar}>

        <div className={layoutStyles.fieldGroup}>
          <div className={layoutStyles.fieldLabel} style={{ marginBottom: 6 }}>Selected duration</div>
          <div className={styles.durationNum}>{fmtTime(trimDuration)}</div>
        </div>

        <div className={layoutStyles.divider} />

        {/* In / Out */}
        <div className={styles.timestamps}>
          <div className={styles.tsBox}>
            <span className={styles.tsLabel}>In</span>
            <span className={styles.tsVal}>{fmtTime(trimStart)}</span>
          </div>
          <div className={styles.tsSep} />
          <div className={styles.tsBox}>
            <span className={styles.tsLabel}>Out</span>
            <span className={styles.tsVal}>{fmtTime(trimEnd)}</span>
          </div>
        </div>

        {/* Film-strip */}
        <div className={styles.filmStrip} ref={trackRef}>
          {thumbs.length > 0
            ? thumbs.map((src, i) => (
                <img key={i} src={src} className={styles.filmThumb} alt="" draggable={false} />
              ))
            : Array.from({ length: THUMB_COUNT }).map((_, i) => (
                <div key={i} className={styles.filmPlaceholder} />
              ))
          }

          {/* Dim outside selection */}
          <div className={styles.dimLeft}  style={{ width: `${startPct}%` }} />
          <div className={styles.dimRight} style={{ width: `${100 - endPct}%` }} />

          {/* Selection border */}
          <div
            className={styles.selBorder}
            style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          />

          {/* Playhead */}
          <div className={styles.playhead} style={{ left: `${playheadPct}%` }} />

          {/* Start handle */}
          <div
            className={styles.handle}
            style={{ left: `${startPct}%` }}
            onMouseDown={() => setDragging('start')}
          >
            <div className={styles.handlePill} />
          </div>

          {/* End handle */}
          <div
            className={styles.handle}
            style={{ left: `${endPct}%` }}
            onMouseDown={() => setDragging('end')}
          >
            <div className={styles.handlePill} />
          </div>
        </div>

        <div className={layoutStyles.divider} />

        {/* Play control */}
        <button className={styles.playBtn} onClick={togglePlay}>
          <span className={styles.playIconWrap}>
            <i className={`ti ${playing ? 'ti-player-pause-filled' : 'ti-player-play-filled'}`} />
          </span>
          {playing ? 'Pause' : 'Preview trim'}
        </button>

        <div className={layoutStyles.divider} />

        <div className={layoutStyles.infoBox}>
          Trim to remove the scroll at the start — keep from when the ad first appears on screen.
        </div>

        <button className={layoutStyles.btnSecondary} onClick={onReRecord} style={{ width: '100%', justifyContent: 'center', marginTop: 'auto' }}>
          ↩ Re-record
        </button>

      </div>

      {/* CENTRE: video panel — portrait 1080:2184, no phone chrome */}
      <div className={layoutStyles.centre}>
        <div className={styles.videoWrap}>
          {objectUrl && (
            <video
              ref={videoRef}
              src={objectUrl}
              className={styles.video}
              playsInline
              muted
            />
          )}
          {/* Play button — small, corner-only, no full overlay */}
          <button className={styles.playOverlayBtn} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            <i className={`ti ${playing ? 'ti-player-pause-filled' : 'ti-player-play-filled'}`} />
          </button>
        </div>
        <p className={layoutStyles.centreHint}>
          Drag handles to set in and out points — preview updates as you drag
        </p>
      </div>

      {/* NAV BAR */}
      <div className={layoutStyles.navBar}>
        <button className={layoutStyles.btnSecondary} onClick={onBack}>← Back</button>
        <button className={layoutStyles.btnPrimary} onClick={() => onConfirm(trimStart, trimEnd)}>
          Use this clip →
        </button>
      </div>

    </div>
  );
}
