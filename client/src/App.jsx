import { useState } from 'react';
import { setToken } from './api.js';
import Nav from './components/Nav.jsx';
import StepBar from './components/StepBar.jsx';
import Step1Record from './components/Step1Record.jsx';
import Step2Trim from './components/Step2Trim.jsx';
import Step3Publisher from './components/Step3Publisher.jsx';
import Step4Export from './components/Step4Export.jsx';
import Login from './components/Login.jsx';
import styles from './App.module.css';

export default function App() {
  const [authed, setAuthed] = useState(!!sessionStorage.getItem('adcast_token'));
  const [step,   setStep]   = useState(1);

  const [rawBlob,     setRawBlob]     = useState(null);
  const [rawDuration, setRawDuration] = useState(0);
  const [rawCropRect, setRawCropRect] = useState(null);

  const [clipBlob,      setClipBlob]      = useState(null);
  const [clipDuration,  setClipDuration]  = useState(0);
  const [clipTrimStart, setClipTrimStart] = useState(0);
  const [clipTrimEnd,   setClipTrimEnd]   = useState(null);

  const [publisher, setPublisher] = useState(null);
  const [jobId,     setJobId]     = useState(null);

  if (!authed) {
    return <Login onAuth={token => { setToken(token); setAuthed(true); }} />;
  }

  function goStep(n) {
    if (n === 2 && !rawBlob)  return;
    if (n === 3 && !rawBlob)  return;
    if (n === 4 && (!clipBlob || !publisher)) return;
    setStep(n);
  }

  const titles = [
    'Record your ad',
    'Trim your clip',
    'Choose publisher context',
    'Export MP4',
  ];
  const subs = [
    'Load a Celtra preview link, interact with the ad, then record.',
    'Drag the handles to trim — keep from when the ad first appears.',
    'Pick a publisher page. Your ad will be composited into it.',
    'Your video is rendering. Download when ready.',
  ];

  return (
    <div className={styles.app}>
      <Nav />
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>{titles[step - 1]}</h1>
          <p className={styles.sub}>{subs[step - 1]}</p>
        </div>
        <StepBar
          step={step}
          onStep={goStep}
          clipReady={!!rawBlob}
          publisherReady={!!publisher}
        />
      </div>

      <div className={styles.card}>
        {step === 1 && (
          <Step1Record
            onRecordingDone={(blob, duration, cropRect) => {
              setRawBlob(blob);
              setRawDuration(duration);
              setRawCropRect(cropRect);
              setStep(2);
            }}
          />
        )}

        {step === 2 && (
          <Step2Trim
            blob={rawBlob}
            duration={rawDuration}
            onConfirm={(trimStart, trimEnd) => {
              setClipBlob(rawBlob);
              setClipDuration(trimEnd - trimStart);
              setClipTrimStart(trimStart);
              setClipTrimEnd(trimEnd);
              setStep(3);
            }}
            onReRecord={() => {
              setRawBlob(null);
              setRawDuration(0);
              setRawCropRect(null);
              setStep(1);
            }}
            onBack={() => setStep(1)}
          />
        )}

        {step === 3 && (
          <Step3Publisher
            publisher={publisher}
            onPublisher={setPublisher}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
          />
        )}

        {step === 4 && (
          <Step4Export
            clipBlob={clipBlob}
            clipDuration={clipDuration}
            clipTrimStart={clipTrimStart}
            clipTrimEnd={clipTrimEnd}
            cropRect={rawCropRect}
            publisher={publisher}
            jobId={jobId}
            onJobId={setJobId}
            onBack={() => setStep(3)}
            onNew={() => {
              setRawBlob(null);
              setRawDuration(0);
              setRawCropRect(null);
              setClipBlob(null);
              setClipDuration(0);
              setClipTrimStart(0);
              setClipTrimEnd(null);
              setPublisher(null);
              setJobId(null);
              setStep(1);
            }}
          />
        )}
      </div>
    </div>
  );
}
