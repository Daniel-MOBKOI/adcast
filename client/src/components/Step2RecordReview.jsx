import { useEffect } from 'react';
import styles from './StepLayout.module.css';

/**
 * Step2RecordReview — confirmation screen for a freshly captured clip.
 * Sits between Source (record) and Trim. No recorder logic here; it just
 * presents the captured blob and lets the user continue or re-record.
 */
function humanSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1048576;
  return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}
function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export default function Step2RecordReview({ blob, duration, cropRect, onNav, onConfirm, onReRecord }) {
  useEffect(() => {
    onNav?.({
      canBack: true,  backLabel: 'Re-record', onBack: onReRecord,
      canNext: !!blob, nextLabel: 'Continue',  onNext: onConfirm,
    });
  }, [blob, onNav, onConfirm, onReRecord]);

  const dims = cropRect?.width && cropRect?.height
    ? `${cropRect.width}×${cropRect.height}`
    : '1080×2184';
  const size = humanSize(blob?.size);
  const dur  = duration ? fmt(duration) : '—';

  return (
    <div className={styles.layout}>
      <div className={styles.sidebar}>
        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabel} style={{ marginBottom: 8 }}>Recording</div>
          <div className={styles.metaList}>
            <div className={styles.metaRow}><span className={styles.metaKey}>Source</span><span className={styles.metaVal}>Browser capture</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Dimensions</span><span className={styles.metaVal} style={{ fontFamily: 'var(--font-mono)' }}>{dims}</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Duration</span><span className={styles.metaVal} style={{ fontFamily: 'var(--font-mono)' }}>{dur}</span></div>
            <div className={styles.metaRow}><span className={styles.metaKey}>Size</span><span className={styles.metaVal} style={{ fontFamily: 'var(--font-mono)' }}>{size}</span></div>
          </div>
        </div>

        <div className={styles.divider} />

        <div className={styles.infoBox}>
          Captured in-browser. A dedicated desktop recorder (native quality, fixed
          1080&times;2184) is on the way — you'll be able to upload a&nbsp;.mov here instead.
        </div>

        <button
          className={styles.btnSecondary}
          onClick={onReRecord}
          style={{ width: '100%', justifyContent: 'center', marginTop: 'auto' }}
        >
          ↩ Re-record
        </button>
      </div>

      <div className={styles.centre}>
        <div style={{
          width: 340, maxWidth: '100%', background: 'var(--panel)',
          border: '1px solid var(--line)', borderRadius: 14, padding: '28px 24px',
          textAlign: 'center', boxShadow: '0 4px 24px rgba(0,0,0,.05)',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', background: '#eaf6ee',
            color: 'var(--green)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', margin: '0 auto 12px', fontSize: 15,
          }}>✓</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Recording ready</div>
          <div style={{ fontSize: 12, color: 'var(--grey)', marginBottom: 18 }}>
            Captured from your browser tab
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            border: '1px solid var(--line)', borderRadius: 10, padding: 10, textAlign: 'left',
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: 8, background: '#1c1c1c', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0,
            }}>▶</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 6 }}>
                adcast-recording.webm
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[dims, dur, size].map((m, i) => (
                  <span key={i} style={{
                    fontFamily: 'var(--font-mono)', fontSize: 9.5, background: '#f3f2f0',
                    borderRadius: 4, padding: '2px 6px', color: 'var(--ink-soft)',
                  }}>{m}</span>
                ))}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--grey-lite)', marginTop: 14 }}>
            Trim it to the right length on the next step.
          </div>
        </div>
      </div>
    </div>
  );
}
