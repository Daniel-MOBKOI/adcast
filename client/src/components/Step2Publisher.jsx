import { useState, useEffect } from 'react';
import { getPublishers, uploadPublisher } from '../api.js';
import IPhoneFrame from './IPhoneFrame.jsx';
import styles from './StepLayout.module.css';

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
              className={`${styles.pubTile} ${publisher?.id === p.id ? styles.pubTileSelected : ''}`}
              onClick={() => onPublisher(p)}
            >
              <div className={styles.pubTileImg}>
                <img src={p.url} alt={p.label} />
              </div>
              <div className={styles.pubTileLbl}>{p.label}</div>
              {publisher?.id === p.id && <div className={styles.pubTileCheck}>✓</div>}
            </div>
          ))}
          <label className={`${styles.pubTile} ${styles.pubTileUpload}`}>
            <input type="file" accept="image/*" onChange={handleUpload} style={{ display: 'none' }} />
            <div className={styles.pubTileImg} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
              <i className="ti ti-upload" aria-hidden="true" style={{ fontSize: 18, color: '#ccc' }} />
            </div>
            <div className={styles.pubTileLbl} style={{ color: '#aaa' }}>
              {uploading ? 'Uploading…' : 'Upload screenshot'}
            </div>
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
        <IPhoneFrame>
          {publisher ? (
            <img
              src={publisher.url}
              alt={publisher.label}
              style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', display: 'block' }}
            />
          ) : (
            <div className={styles.emptyScreen}>
              <div className={styles.emptyLabel}>Select a publisher →</div>
            </div>
          )}
        </IPhoneFrame>
        <p className={styles.centreHint}>{publisher ? publisher.label : 'No publisher selected'}</p>
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
