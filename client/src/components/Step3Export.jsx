import { useState, useEffect, useRef } from 'react';
import { createJob, pollJob, downloadUrl } from '../api.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './Step3Export.module.css';

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

export default function Step3Export({ clipBlob, clipDuration, publisher, jobId, onJobId, onBack, onNew }) {
  const [status, setStatus] = useState('idle'); // idle | uploading | processing | done | error
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const pollRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startJob();
    return () => clearInterval(pollRef.current);
  }, []);

  async function startJob() {
    setStatus('uploading');
    setProgress(5);
    setMessage('Uploading clip…');
    try {
      const { jobId: id, error } = await createJob({
        clipBlob,
        publisherId: publisher.id,
        publisherLabel: publisher.label
      });
      if (error) throw new Error(error);
      onJobId(id);
      setProgress(15);
      setStatus('processing');
      setMessage('Job queued…');
      poll(id);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err.message);
    }
  }

  function poll(id) {
    pollRef.current = setInterval(async () => {
      try {
        const data = await pollJob(id);
        setProgress(data.progress || 0);
        setMessage(data.message || '');
        if (data.status === 'done') {
          clearInterval(pollRef.current);
          setStatus('done');
          setProgress(100);
        } else if (data.status === 'error') {
          clearInterval(pollRef.current);
          setStatus('error');
          setErrorMsg(data.error || 'Compositor failed.');
        }
      } catch (err) {
        clearInterval(pollRef.current);
        setStatus('error');
        setErrorMsg(err.message);
      }
    }, 2000);
  }

  const isDone = status === 'done';
  const isError = status === 'error';
  const isWorking = status === 'uploading' || status === 'processing';

  return (
    <div className={styles.layout}>
      <div className={styles.left}>
        <div className={styles.card}>
          <div className={styles.label}>Output settings</div>
          <div className={styles.metaList}>
            <div className={styles.metaRow}><span className={styles.metaKey}>Format</span><span className={styles.metaVal}>H.264 MP4</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Resolution</span><span className={styles.metaVal}>1080 × 1920</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Frame rate</span><span className={styles.metaVal}>30 fps</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Ad duration</span><span className={styles.metaVal}>{fmtTime(clipDuration)}</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Publisher</span><span className={styles.metaVal} style={{ maxWidth: 110, textAlign: 'right' }}>{publisher?.label}</span></div>
          </div>
        </div>

        <div className={styles.divider} />

        {isDone && jobId && (
          <a href={downloadUrl(jobId)} className={styles.btnDownload} download="adcast.mp4">
            ↓ Download MP4
          </a>
        )}

        <button className={styles.btnSecondary} onClick={onNew}>
          + New video
        </button>
      </div>

      <div className={styles.centre}>
        <div className={styles.toolbar}>
          <button className={styles.tbtn} onClick={onBack} aria-label="Back" disabled={isWorking}>←</button>
          <span className={styles.toolbarLabel}>
            {isWorking ? message || 'Processing…' : isDone ? 'Export complete' : isError ? 'Export failed' : 'Export'}
          </span>
        </div>

        <IPhoneFrame>
          {isWorking && (
            <div className={styles.procScreen}>
              <div className={styles.spinner} />
              <div className={styles.procLabel}>{message || 'Compositing…'}</div>
              <div className={styles.procBarWrap}>
                <div className={styles.procBar} style={{ width: `${progress}%` }} />
              </div>
              <div className={styles.procPct}>{Math.round(progress)}%</div>
            </div>
          )}
          {isDone && (
            <div className={styles.doneScreen}>
              <div className={styles.doneBadge}>Ready</div>
              <div className={styles.playBtn}>▶</div>
              <div className={styles.doneMeta}>1080 × 1920 · H.264<br />{fmtTime(clipDuration + 8)} · 30fps</div>
              <div className={styles.doneBar}><div className={styles.doneFill} /></div>
            </div>
          )}
          {isError && (
            <div className={styles.errScreen}>
              <div className={styles.errIcon}>✕</div>
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

        <p className={styles.hint2}>
          {isWorking && 'Scroll-in → hold → scroll-out camera'}
          {isDone && 'Click Download MP4 to save your video.'}
          {isError && 'Check server logs and try again.'}
        </p>
      </div>

      <div className={styles.right}>
        <div className={styles.card}>
          <div className={styles.label}>Job status</div>
          <div className={styles.statusRow}>
            <div className={`${styles.dot}
              ${isWorking ? styles.dotWorking : ''}
              ${isDone ? styles.dotDone : ''}
              ${isError ? styles.dotErr : ''}`}
            />
            <span className={styles.statusText}>
              {status === 'uploading' && 'Uploading clip'}
              {status === 'processing' && 'Compositing'}
              {status === 'done' && 'Complete'}
              {status === 'error' && 'Failed'}
              {status === 'idle' && 'Starting'}
            </span>
          </div>
          <div className={styles.progressBarWrap}>
            <div className={styles.progressBar} style={{ width: `${progress}%`, background: isError ? '#ef4444' : '#2563eb' }} />
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.label}>Clip summary</div>
          <div className={styles.metaList}>
            <div className={styles.metaRow}><span className={styles.metaKey}>Duration</span><span className={styles.metaVal}>{fmtTime(clipDuration)}</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Source</span><span className={styles.metaVal}>WebM</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Motion</span><span className={styles.metaVal}>Scroll + hold</span></div>
          </div>
        </div>
      </div>

      <div className={styles.navBar}>
        <button className={styles.btnSecondary} onClick={onBack} disabled={isWorking}>← Back</button>
        {isDone && jobId ? (
          <a href={downloadUrl(jobId)} className={styles.btnDownloadNav} download="adcast.mp4">
            ↓ Download MP4
          </a>
        ) : (
          <button className={styles.btnPrimary} disabled>
            {isWorking ? `Rendering… ${Math.round(progress)}%` : isError ? 'Failed' : 'Preparing…'}
          </button>
        )}
      </div>
    </div>
  );
}
