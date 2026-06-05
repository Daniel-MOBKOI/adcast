import { useState, useEffect } from 'react';
import { getPublishers, uploadPublisher } from '../api.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './StepLayout.module.css';

function initials(label) {
  const words = label.trim().split(/\s+/);
  if (words.length === 1) return label.slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export default function Step2Publisher({ publisher, onPublisher, onBack, onNext, onNav }) {
  const [publishers, setPublishers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    getPublishers()
      .then(list => { setPublishers(list); if (!publisher && list.length) onPublisher(list[0]); })
      .finally(() => setLoading(false));
  }, []);

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const p = await uploadPublisher(file, file.name.replace(/\.[^.]+$/, ''));
      setPublishers(prev => [...prev, p]);
      onPublisher(p);
    } catch (err) {
      alert('Upload failed: ' + err.message);
    }
    setUploading(false);
  }

  useEffect(() => {
    onNav?.({
      canBack: true, backLabel: 'Back', onBack,
      canNext: !!publisher, nextLabel: 'Continue', onNext,
    });
  }, [publisher, onNav, onBack, onNext]);

  return (
    <div className={styles.layout}>
      <div className={styles.sidebar}>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldHeader}>
            <span className={styles.fieldLabel}>Publisher library</span>
          </div>
          <p className={styles.fieldHint}>Select a publisher page. Your recorded ad will be composited into it.</p>
        </div>

        <div className={styles.divider} />

        {loading && <p className={styles.fieldHint}>Loading…</p>}

        <div className={styles.pubGrid}>
          {publishers.map(p => (
            <div
              key={p.id}
              className={`${styles.pubRow} ${publisher?.id === p.id ? styles.pubRowSelected : ''}`}
              onClick={() => onPublisher(p)}
            >
              <span className={styles.pubAvatar}>{initials(p.label)}</span>
              <span className={styles.pubName}>{p.label}</span>
              {publisher?.id === p.id && <span className={styles.pubCheck}>✓</span>}
            </div>
          ))}
          <label className={styles.pubRowUpload}>
            <input type="file" accept="image/*" onChange={handleUpload} style={{ display: 'none' }} />
            <span className={styles.pubAvatar} style={{ background: 'transparent', border: `1px dashed var(--line)`, color: 'var(--grey-lite)' }}>+</span>
            <span className={styles.pubName} style={{ color: 'var(--grey)' }}>
              {uploading ? 'Uploading…' : 'Upload screenshot'}
            </span>
          </label>
        </div>

        <div className={styles.divider} />

        <div className={styles.infoBox}>
          Screenshots should be full-bleed portrait. The ad will scroll in from below the article content.
        </div>

        <div className={styles.fieldGroup} style={{ marginTop: 4 }}>
          <div className={styles.fieldLabel} style={{ marginBottom: 6 }}>Paste a URL</div>
          <div style={{ position: 'relative' }}>
            <input className={styles.input} placeholder="https://publisher.com/article…" disabled style={{ paddingRight: 90 }} />
            <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: '#bbb', fontWeight: 500, pointerEvents: 'none' }}>Coming soon</span>
          </div>
        </div>

      </div>

      <div className={styles.centre}>
        <IPhoneFrame scroll>
          {publisher ? (
            <img
              src={publisher.url}
              alt={publisher.label}
              style={{ width: '100%', height: 'auto', display: 'block' }}
            />
          ) : (
            <div className={styles.emptyScreen}>
              <div className={styles.emptyLabel}>Select a publisher →</div>
            </div>
          )}
        </IPhoneFrame>
        <p className={styles.centreHint}>{publisher ? publisher.label + ' · scroll to preview' : 'No publisher selected'}</p>
      </div>

    </div>
  );
}
