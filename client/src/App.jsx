import { useState, useCallback, useEffect } from 'react';
import { setToken } from './api.js';
import TopBar from './components/TopBar.jsx';
import BottomBar from './components/BottomBar.jsx';
import Step1Record from './components/Step1Record.jsx';
import Step2RecordReview from './components/Step2RecordReview.jsx';
import Step2Trim from './components/Step2Trim.jsx';
import Step3Publisher from './components/Step3Publisher.jsx';
import Step4Export from './components/Step4Export.jsx';
import Login from './components/Login.jsx';
import styles from './App.module.css';

const TITLES = [
  'Source the creative',
  'Record your session',
  'Trim the recording',
  'Choose a publisher',
  'Export & download',
];

export default function App() {
  const [authed, setAuthed] = useState(!!sessionStorage.getItem('adcast_token'));
  const [step,   setStep]   = useState(1);

  const [rawBlob,     setRawBlob]     = useState(null);
  const [rawDuration, setRawDuration] = useState(0);
  const [cropRect,    setCropRect]    = useState(null);

  const [clipBlob,      setClipBlob]      = useState(null);
  const [clipDuration,  setClipDuration]  = useState(0);
  const [clipTrimStart, setClipTrimStart] = useState(0);
  const [clipTrimEnd,   setClipTrimEnd]   = useState(null);

  const [publisher, setPublisher] = useState(null);
  const [jobId,     setJobId]     = useState(null);

  // Footer nav config, reported by whichever step is mounted.
  const [nav, setNav] = useState(null);
  const onNav = useCallback((cfg) => setNav(cfg), []);
  // Clear stale footer buttons the instant the step changes.
  useEffect(() => { setNav(null); }, [step]);

  if (!authed) {
    return <Login onAuth={token => { setToken(token); setAuthed(true); }} />;
  }

  function goStep(n) {
    if (n >= 2 && !rawBlob)  return;
    if (n >= 3 && !rawBlob)  return;
    if (n >= 4 && !clipBlob) return;
    if (n >= 5 && (!clipBlob || !publisher)) return;
    setStep(n);
  }

  function resetAll() {
    setRawBlob(null); setRawDuration(0); setCropRect(null);
    setClipBlob(null); setClipDuration(0);
    setClipTrimStart(0); setClipTrimEnd(null);
    setPublisher(null); setJobId(null);
    setStep(1);
  }

  return (
    <div className={styles.app}>
      <TopBar
        step={step}
        onStep={goStep}
        rawReady={!!rawBlob}
        clipReady={!!clipBlob}
        publisherReady={!!publisher}
      />

      <main className={styles.main}>
        {step === 1 && (
          <Step1Record
            onNav={onNav}
            onRecordingDone={(blob, duration, rect) => {
              setRawBlob(blob); setRawDuration(duration); setCropRect(rect);
              setStep(2);
            }}
          />
        )}

        {step === 2 && (
          <Step2RecordReview
            blob={rawBlob}
            duration={rawDuration}
            cropRect={cropRect}
            onNav={onNav}
            onConfirm={() => setStep(3)}
            onReRecord={() => { setRawBlob(null); setRawDuration(0); setCropRect(null); setStep(1); }}
          />
        )}

        {step === 3 && (
          <Step2Trim
            blob={rawBlob}
            duration={rawDuration}
            cropRect={cropRect}
            onNav={onNav}
            onConfirm={(trimStart, trimEnd) => {
              setClipBlob(rawBlob);
              setClipDuration(trimEnd - trimStart);
              setClipTrimStart(trimStart);
              setClipTrimEnd(trimEnd);
              setStep(4);
            }}
            onBack={() => setStep(2)}
          />
        )}

        {step === 4 && (
          <Step3Publisher
            publisher={publisher}
            onPublisher={setPublisher}
            onNav={onNav}
            onBack={() => setStep(3)}
            onNext={() => setStep(5)}
          />
        )}

        {step === 5 && (
          <Step4Export
            clipBlob={clipBlob}
            clipDuration={clipDuration}
            clipTrimStart={clipTrimStart}
            clipTrimEnd={clipTrimEnd}
            cropRect={cropRect}
            publisher={publisher}
            jobId={jobId}
            onJobId={setJobId}
            onNav={onNav}
            onBack={() => setStep(4)}
            onNew={resetAll}
          />
        )}
      </main>

      <BottomBar step={step} title={TITLES[step - 1]} nav={nav} />
    </div>
  );
}
