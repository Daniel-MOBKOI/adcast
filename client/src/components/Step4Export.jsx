import { useState, useEffect, useRef } from 'react';
import { createJob, pollJob, downloadJob } from '../api.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './StepLayout.module.css';

function fmtTime(s) {
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

export default function Step4Export({ clipBlob, clipDuration, clipTrimStart, clipTrimEnd, cropRect, publisher, jobId, onJobId, onBack, onNew, onNav }) {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const pollRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startJob();
    return () => clearInterval(pollRef.current);
  }, []);

  async function startJob() {
    setStatus('uploading'); setProgress(5); setMessage('Uploading clip…');
    try {
      const { jobId: id, error } = await createJob({ clipBlob, publisherId: publisher.id, publisherLabel: publisher.label, trimStart: clipTrimStart, trimEnd: clipTrimEnd });
      if (error) throw new Error(error);
      onJobId(id);
      setProgress(15); setStatus('processing'); setMessage('Job queued…');
      poll(id);
    } catch (err) {
      setStatus('error'); setErrorMsg(err.message);
    }
  }

  function poll(id) {
    pollRef.current = setInterval(async () => {
      try {
        const data = await pollJob(id);
        setProgress(data.progress || 0);
        setMessage(data.message || '');
        if (data.status === 'done') { clearInterval(pollRef.current); setStatus('done'); setProgress(100); }
        else if (data.status === 'error') { clearInterval(pollRef.current); setStatus('error'); setErrorMsg(data.error || 'Compositor failed.'); }
      } catch (err) { clearInterval(pollRef.current); setStatus('error'); setErrorMsg(err.message); }
    }, 2000);
  }

  async function handleDownload() {
    try {
      const blob = await downloadJob(jobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'adcast.mp4';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg('Download failed: ' + err.message);
    }
  }

  const isDone = status === 'done';
  const isError = status === 'error';
  const isWorking = status === 'uploading' || status === 'processing';

  // Fetch the finished MP4 for in-frame preview once the job completes.
  useEffect(() => {
    if (!isDone || !jobId) return;
    let url;
    downloadJob(jobId)
      .then(blob => { url = URL.createObjectURL(blob); setVideoUrl(url); })
      .catch(() => {}); // silent — download button still works
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [isDone, jobId]);

  useEffect(() => {
    onNav?.({
      canBack: !isWorking, backLabel: 'Back', onBack,
      canNext: isDone && !!jobId,
      nextLabel: isDone ? '↓ Download MP4'
        : isWorking ? `Rendering… ${Math.round(progress)}%`
        : isError ? 'Failed' : 'Preparing…',
      onNext: handleDownload,
      arrow: false,
    });
  }, [status, jobId, progress, onNav, onBack]);

  return (
    <div className={styles.layout}>
      <div className={styles.sidebar}>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabel} style={{ marginBottom: 8 }}>Export summary</div>
          <div className={styles.metaList}>
            <div className={styles.metaRow}><span className={styles.metaKey}>Format</span><span className={styles.metaVal}>H.264 MP4</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Resolution</span><span className={styles.metaVal}>1080 × 2342</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Frame rate</span><span className={styles.metaVal}>30 fps</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Trimmed length</span><span className={styles.metaVal}>{fmtTime(clipDuration)}</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Publisher</span><span className={styles.metaVal} style={{ maxWidth: 120, textAlign: 'right' }}>{publisher?.label}</span></div>
          </div>
        </div>

        <div className={styles.divider} />

        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabel} style={{ marginBottom: 8 }}>Progress</div>
          <div className={styles.statusRow}>
            <div className={`${styles.statusDot} ${isWorking ? styles.dotWorking : isDone ? styles.dotDone : isError ? styles.dotErr : ''}`} />
            <span className={styles.statusText}>
              {status === 'uploading' && 'Uploading clip'}
              {status === 'processing' && (message || 'Compositing…')}
              {status === 'done' && 'Complete'}
              {status === 'error' && 'Failed'}
              {status === 'idle' && 'Starting…'}
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${progress}%`, background: isError ? '#ef4444' : '#0a0a0a' }} />
          </div>
        </div>

        <div className={styles.divider} />

        {isDone && jobId && (
          <button onClick={handleDownload} className={styles.btnPrimary} style={{ width: '100%', textAlign: 'center' }}>
            ↓ Download MP4
          </button>
        )}

        <button className={styles.btnSecondary} onClick={onNew} style={{ width: '100%', justifyContent: 'center' }}>
          + New video
        </button>

      </div>

      <div className={styles.centre}>
        <IPhoneFrame>
          {isWorking && (
            <div className={styles.procScreen}>
              <div className={styles.spinner} />
              <div className={styles.procLabel}>{message || 'Compositing…'}</div>
              <div className={styles.procMiniBar}>
                <div className={styles.procMiniFill} style={{ width: `${progress}%` }} />
              </div>
              <div className={styles.procPct}>{Math.round(progress)}%</div>
            </div>
          )}
          {isDone && (
            videoUrl
              ? <video
                  src={videoUrl}
                  autoPlay
                  loop
                  muted
                  playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              : <div className={styles.doneScreen}>
                  <div className={styles.doneBadge}>Ready</div>
                  <div className={styles.procLabel}>Loading preview…</div>
                </div>
          )}
          {isError && (
            <div className={styles.errScreen}>
              <i className="ti ti-x" aria-hidden="true" style={{ fontSize: 28, color: '#ef4444' }} />
              <div className={styles.errLabel}>Export failed</div>
              <div className={styles.errMsg}>{errorMsg}</div>
            </div>
          )}
          {status === 'idle' && (
            <div className={styles.procScreen}>
              <div className={styles.spinner} />
              <div className={styles.procLabel}>Starting…</div>
            </div>
          )}
        </IPhoneFrame>
        <p className={styles.centreHint}>
          {isWorking && 'Scroll-in → hold → scroll-out'}
          {isDone && 'Your MP4 is ready — playing in the frame above.'}
          {isError && 'Something went wrong — try again.'}
        </p>
      </div>

    </div>
  );
}
