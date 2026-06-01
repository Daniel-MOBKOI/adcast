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
  // Require a stored token. (Login validates the team password against the
  // server and stores it as the token.) Without this, the app would skip login,
  // send no token, and every /api call would 401 — which the fetch wrapper turns
  // into a page reload, bouncing the user back to step 1.
  const [authed, setAuthed] = useState(!!sessionStorage.getItem('adcast_token'));
  const [step, setStep] = useState(1);
  const [clipBlob, setClipBlob] = useState(null);
  const [clipDuration, setClipDuration] = useState(0);
  const [publisher, setPublisher] = useState(null);
  const [jobId, setJobId] = useState(null);

  if (!authed) {
    return <Login onAuth={token => { setToken(token); setAuthed(true); }} />;
  }

  function goStep(n) {
    if (n === 2 && !clipBlob) return;
    if (n === 3 && (!clipBlob || !publisher)) return;
    setStep(n);
  }

  const titles = ['Record your ad', 'Choose publisher context', 'Export MP4'];
  const subs = [
    'Load a Celtra preview link, interact with the ad, then record.',
    'Pick a publisher page. Your ad will be composited into it.',
    'Your video is rendering. Download when ready.'
  ];

  return (
    <div className={styles.app}>
      <Nav />
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>{titles[step - 1]}</h1>
          <p className={styles.sub}>{subs[step - 1]}</p>
        </div>
        <StepBar step={step} onStep={goStep} clipReady={!!clipBlob} publisherReady={!!publisher} />
      </div>
      <div className={styles.card}>
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
