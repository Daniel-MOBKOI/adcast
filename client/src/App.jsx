import { useState } from 'react';
import { setToken } from './api.js';
import Nav from './components/Nav.jsx';
import StepBar from './components/StepBar.jsx';
import Step1Record from './components/Step1Record.jsx';
import Step2Publisher from './components/Step2Publisher.jsx';
import Step3Export from './components/Step3Export.jsx';
import Login from './components/Login.jsx';
import styles from './App.module.css';

export default function App() {
  const [authed, setAuthed] = useState(
    !!sessionStorage.getItem('adcast_token') ||
    !import.meta.env.VITE_REQUIRE_AUTH // skip auth in dev if env var not set
  );
  const [step, setStep] = useState(1);

  // Shared state passed between steps
  const [clipBlob, setClipBlob] = useState(null);
  const [clipDuration, setClipDuration] = useState(0);
  const [publisher, setPublisher] = useState(null); // { id, label, url, filePath }
  const [jobId, setJobId] = useState(null);

  if (!authed) {
    return <Login onAuth={token => { setToken(token); setAuthed(true); }} />;
  }

  function goStep(n) {
    if (n === 2 && !clipBlob) return;
    if (n === 3 && (!clipBlob || !publisher)) return;
    setStep(n);
  }

  return (
    <div className={styles.app}>
      <Nav />
      <div className={styles.body}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>
              {step === 1 && 'Record your ad'}
              {step === 2 && 'Choose publisher context'}
              {step === 3 && 'Export MP4'}
            </h1>
            <p className={styles.sub}>
              {step === 1 && 'Load a Celtra preview link, interact with the ad, then record.'}
              {step === 2 && 'Pick a publisher page. Your ad will be composited into it.'}
              {step === 3 && 'Your video is rendering. Download when ready.'}
            </p>
          </div>
          <StepBar step={step} onStep={goStep} clipReady={!!clipBlob} publisherReady={!!publisher} />
        </div>

        {step === 1 && (
          <Step1Record
            clipBlob={clipBlob}
            onClip={(blob, dur) => { setClipBlob(blob); setClipDuration(dur); }}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <Step2Publisher
            publisher={publisher}
            onPublisher={setPublisher}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <Step3Export
            clipBlob={clipBlob}
            clipDuration={clipDuration}
            publisher={publisher}
            jobId={jobId}
            onJobId={setJobId}
            onBack={() => setStep(2)}
            onNew={() => { setClipBlob(null); setClipDuration(0); setPublisher(null); setJobId(null); setStep(1); }}
          />
        )}
      </div>
    </div>
  );
}
