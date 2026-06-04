import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './Step2Trim.module.css';
import layoutStyles from './StepLayout.module.css';

const THUMB_COUNT = 16;
const GOOD_MIN    = 10;
const GOOD_MAX    = 30;

function fmtTime(s) {
  s = Math.max(0, s);
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms  = Math.floor((s % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${ms}`;
}

/**
 * Extract thumbnails from a video, cropping to cropRect if provided.
 * cropRect is in physical pixels (devicePixelRatio space) — convert to
 * video-space by scaling proportionally.
 */
async function extractThumbs(url, duration, count, cropRect) {
  const video   = document.createElement('video');
  video.src     = url;
  video.muted   = true;
  video.preload = 'auto';
  await new Promise(res => { video.onloadedmetadata = res; video.load(); });

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // Convert physical-pixel cropRect to video-space coordinates
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (cropRect) {
    const dpr = window.devicePixelRatio || 1;
    // cropRect is in physical pixels, video dimensions are also physical
    // so no dpr conversion needed — they're the same space
    sx = Math.max(0, Math.min(cropRect.x, vw - 2));
    sy = Math.max(0, Math.min(cropRect.y, vh - 2));
    sw = Math.min(cropRect.width,  vw - sx);
    sh = Math.min(cropRect.height, vh - sy);
  }

  const thumbH = Math.round(120 * (sh / sw));
  const canvas = document.createElement('canvas');
  canvas.width  = 120;
  canvas.height = thumbH;
  const ctx = canvas.getContext('2d');
  const thumbs = [];

  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * duration;
    video.currentTime = t;
    await new Promise(res => { video.onseeked = res; });
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 120, thumbH);
    thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
  }
  return thumbs;
}

export default function Step2Trim({ blob, duration, cropRect, onConfirm, onReRecord, onBack }) {
  const videoRef   = useRef(null);
  const canvasRef  = useRef(null);
  const trackRef   = useRef(null);
  const rafRef     = useRef(null);

  const [objectUrl, setObjectUrl] = useState(null);
  const [thumbs,    setThumbs]    = useState([]);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd,   setTrimEnd]   = useState(duration);
  const [playing,   setPlaying]   = useState(false);
  const [dragging,  setDragging]  = useState(null);
  const [currentT,  setCurrentT]  = useState(0);

  // Compute video-space crop coordinates once
  const cropSrc = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!cropRect || !vw || !vh) return { sx: 0, sy: 0, sw: vw, sh: vh };
    const sx = Math.max(0, Math.min(cropRect.x, vw - 2));
    const sy = Math.max(0, Math.min(cropRect.y, vh - 2));
    const sw = Math.min(cropRect.width,  vw - sx);
    const sh = Math.min(cropRect.height, vh - sy);
    return { sx, sy, sw, sh };
  }, [cropRect]);

  // Draw current video frame to canvas (cropped)
  const drawFrame = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const src = cropSrc();
    if (!src) return;
    const ctx = canvas.getContext('2d');
    canvas.width  = src.sw;
    canvas.height = src.sh;
    ctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, src.sw, src.sh);
  }, [cropSrc]);

  // RAF loop while playing
  useEffect(() => {
    if (playing) {
      const loop = () => { drawFrame(); rafRef.current = requestAnimationFrame(loop); };
      rafRef.current = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(rafRef.current);
      drawFrame(); // draw single frame when paused
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, drawFrame]);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    extractThumbs(url, duration, THUMB_COUNT, cropRect).then(setThumbs);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  useEffect(() => { setTrimEnd(duration); }, [duration]);

  useEffect(() => {
    const v = videoRef.current;
    if (v && !playing && dragging === 'start') {
      v.currentTime = trimStart; setCurrentT(trimStart);
    }
  }, [trimStart]);

  useEffect(() => {
    const v = videoRef.current;
    if (v && !playing && dragging === 'end') {
      v.currentTime = trimEnd; setCurrentT(trimEnd);
    }
  }, [trimEnd]);

  useEffect(() => {
    if (dragging !== null) return;
    const v = videoRef.current;
    if (v && !playing) { v.currentTime = trimStart; setCurrentT(trimStart); }
  }, [dragging]);

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

  // Draw frame when video seeks while paused
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.addEventListener('seeked', drawFrame);
    return () => v.removeEventListener('seeked', drawFrame);
  }, [drawFrame]);

  function getPct(t)    { return (t / duration) * 100; }
  function pctToTime(p) { return Math.max(0, Math.min(duration, (p / 100) * duration)); }

  function getTrackPct(clientX) {
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  }

  const onMouseMove = useCallback((e) => {
    if (!dragging) return;
    const t = pctToTime(getTrackPct(e.clientX));
    if (dragging === 'start') setTrimStart(Math.min(t, trimEnd - GOOD_MIN));
    else                      setTrimEnd(Math.max(t, trimStart + GOOD_MIN));
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
  const isTooShort   = trimDuration < GOOD_MIN;
  const isGood       = !isTooShort && trimDuration <= GOOD_MAX;
  const accentColor  = isGood ? '#16a34a' : '#dc2626';
  const startPct     = getPct(trimStart);
  const endPct       = getPct(trimEnd);
  const playheadPct  = getPct(Math.min(currentT, trimEnd));

  return (
    <div className={layoutStyles.layout}>

      {/* LEFT SIDEBAR */}
      <div className={layoutStyles.sidebar}>

        <div className={layoutStyles.fieldGroup}>
          <div className={layoutStyles.fieldLabel} style={{ marginBottom: 6 }}>Selected duration</div>
          <div className={styles.durationNum} style={{ color: accentColor }}>
            {fmtTime(trimDuration)}
          </div>
          <div className={styles.durationBadge} style={{
            background: isGood ? '#f0fdf4' : '#fef2f2',
            color: accentColor,
            borderColor: isGood ? '#bbf7d0' : '#fecaca'
          }}>
            {isTooShort ? '⚠ Minimum 10 seconds required' : isGood ? '✓ Good length for export' : '⚠ Trim to under 30s for best results'}
          </div>
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
          <div className={styles.dimLeft}  style={{ width: `${startPct}%` }} />
          <div className={styles.dimRight} style={{ width: `${100 - endPct}%` }} />
          <div className={styles.selBorder} style={{ left: `${startPct}%`, width: `${endPct - startPct}%`, borderColor: accentColor }} />
          <div className={styles.playhead} style={{ left: `${playheadPct}%` }} />
          <div className={styles.handle} style={{ left: `${startPct}%` }} onMouseDown={() => setDragging('start')}>
            <div className={styles.handlePill} style={{ background: accentColor }} />
          </div>
          <div className={styles.handle} style={{ left: `${endPct}%` }} onMouseDown={() => setDragging('end')}>
            <div className={styles.handlePill} style={{ background: accentColor }} />
          </div>
        </div>

        <div className={layoutStyles.divider} />

        {/* Play control */}
        <button className={styles.playBtn} onClick={togglePlay}>
          <span className={styles.playIconWrap}>
            {playing
              ? <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="1" width="3.5" height="10" rx="1"/><rect x="7.5" y="1" width="3.5" height="10" rx="1"/></svg>
              : <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2 1.5L11 6L2 10.5V1.5Z"/></svg>
            }
          </span>
          {playing ? 'Pause preview' : 'Play preview'}
        </button>

        <div className={layoutStyles.divider} />

        <div className={layoutStyles.infoBox}>
          Trim to remove the scroll at the start — keep from when the ad first appears on screen.
        </div>

        <p className={styles.instructionText}>
          Your recorded clip will be composited into the publisher scroll animation.
          The ad plays during the hold section — ideally between 5 and 30 seconds.
          Drag the <strong>In</strong> handle to cut any dead time before the ad loads,
          and the <strong>Out</strong> handle to trim the end if needed.
        </p>

        <button className={layoutStyles.btnSecondary} onClick={onReRecord}
          style={{ width: '100%', justifyContent: 'center', marginTop: 'auto' }}>
          ↩ Re-record
        </button>

      </div>

      {/* CENTRE: canvas-cropped video preview */}
      <div className={layoutStyles.centre}>
        {/* Hidden video element — source of truth for playback */}
        {objectUrl && (
          <video
            ref={videoRef}
            src={objectUrl}
            playsInline
            muted
            style={{ display: 'none' }}
          />
        )}
        <div className={styles.videoWrap}>
          <canvas ref={canvasRef} className={styles.video} />
        </div>
        <p className={layoutStyles.centreHint}>
          Drag handles to set in and out points — preview updates as you drag
        </p>
      </div>

      {/* NAV BAR */}
      <div className={layoutStyles.navBar}>
        <button className={layoutStyles.btnSecondary} onClick={onBack}>← Back</button>
        <button className={layoutStyles.btnPrimary} onClick={() => onConfirm(trimStart, trimEnd)} disabled={isTooShort}>
          Use this clip →
        </button>
      </div>

    </div>
  );
}
