import { useState, useEffect } from 'react';
import { getPublishers, uploadPublisher } from '../api.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './Step2Publisher.module.css';

export default function Step2Publisher({ publisher, onPublisher, onBack, onNext }) {
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

  return (
    <div className={styles.layout}>
      <div className={styles.left}>
        <div className={styles.card}>
          <div className={styles.label}>Publisher library</div>
          <p className={styles.hint}>Select a publisher page for the final video.</p>
        </div>

        <div className={styles.divider} />

        <div className={styles.card}>
          <div className={styles.label}>Paste a URL</div>
          <div className={styles.comingWrap}>
            <input className={styles.input} placeholder="https://publisher.com/article…" disabled />
            <span className={styles.comingTag}>Coming soon</span>
          </div>
          <p className={styles.hint}>Live URL capture will be available in a future update.</p>
        </div>
      </div>

      <div className={styles.centre}>
        <div className={styles.toolbar}>
          <button className={styles.tbtn} onClick={onBack} aria-label="Back">←</button>
          <span className={styles.toolbarLabel}>Choose publisher page</span>
        </div>

        <IPhoneFrame>
          {publisher ? (
            <div className={styles.pubPreview}>
              <img
                src={publisher.url}
                alt={publisher.label}
                className={styles.pubImg}
              />
            </div>
          ) : (
            <div className={styles.emptyScreen}>
              <div className={styles.emptyLabel}>Select a publisher →</div>
            </div>
          )}
        </IPhoneFrame>

        <p className={styles.hint2}>
          {publisher ? publisher.label : 'No publisher selected'}
        </p>
      </div>

      <div className={styles.right}>
        <div className={styles.label} style={{ padding: '0 2px' }}>Publisher library</div>

        {loading && <p className={styles.hint}>Loading…</p>}

        <div className={styles.pubGrid}>
          {publishers.map(p => (
            <div
              key={p.id}
              className={`${styles.pubTile} ${publisher?.id === p.id ? styles.selected : ''}`}
              onClick={() => onPublisher(p)}
            >
              <div className={styles.tileImg}>
                <img src={p.url} alt={p.label} />
              </div>
              <div className={styles.tileLabel}>{p.label}</div>
              {publisher?.id === p.id && <div className={styles.tileCheck}>✓</div>}
            </div>
          ))}

          <label className={`${styles.pubTile} ${styles.uploadTile}`}>
            <input type="file" accept="image/*" onChange={handleUpload} style={{ display: 'none' }} />
            <div className={styles.tileImg} style={{ background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 22, color: '#ccc' }}>{uploading ? '…' : '+'}</span>
            </div>
            <div className={styles.tileLabel} style={{ color: '#aaa' }}>
              {uploading ? 'Uploading…' : 'Upload screenshot'}
            </div>
          </label>
        </div>

        <p className={styles.hint} style={{ padding: '0 2px' }}>
          Screenshots should be full-bleed portrait, matching ad dimensions.
        </p>
      </div>

      <div className={styles.navBar}>
        <button className={styles.btnSecondary} onClick={onBack}>← Back</button>
        <button className={styles.btnPrimary} onClick={onNext} disabled={!publisher}>
          Next step →
        </button>
      </div>
    </div>
  );
}
