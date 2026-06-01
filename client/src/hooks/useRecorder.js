import { useState, useRef, useCallback } from 'react';

/**
 * useRecorder — wraps getDisplayMedia tab capture.
 *
 * The user captures the entire tab; we don't crop on the client (the phone
 * frame is a UI metaphor — the actual Celtra ad runs fullscreen in an iframe
 * on the backend scene page). The raw WebM is uploaded as-is for the
 * compositor to use as the ad video element.
 */
export function useRecorder() {
  const [state, setState] = useState('idle'); // idle | requesting | recording | done | error
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [blob, setBlob] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const secondsRef = useRef(0);

  const start = useCallback(async () => {
    setError(null);
    setBlob(null);
    setState('requesting');

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true // Chrome 107+ hint — user still confirms
      });
      streamRef.current = stream;

      // Pick best supported codec
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

      const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const recorded = new Blob(chunksRef.current, { type: mimeType });
        setBlob(recorded);
        setState('done');
        clearInterval(timerRef.current);
        stream.getTracks().forEach(t => t.stop());
      };

      // Stop if user clicks "Stop sharing" in browser UI
      stream.getVideoTracks()[0].onended = () => {
        if (mr.state === 'recording') mr.stop();
      };

      secondsRef.current = 0;
      setDuration(0);
      setState('recording');
      mr.start(500); // collect chunks every 500ms

      timerRef.current = setInterval(() => {
        secondsRef.current += 1;
        setDuration(secondsRef.current);
      }, 1000);

    } catch (err) {
      setState('error');
      setError(err.name === 'NotAllowedError'
        ? 'Permission denied — please allow tab capture when prompted.'
        : err.message);
    }
  }, []);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    clearInterval(timerRef.current);
  }, []);

  const reset = useCallback(() => {
    stop();
    setBlob(null);
    setDuration(0);
    setError(null);
    setState('idle');
  }, [stop]);

  return { state, duration, error, blob, start, stop, reset };
}
