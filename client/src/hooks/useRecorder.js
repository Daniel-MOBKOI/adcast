import { useState, useRef, useCallback } from 'react';

/**
 * useRecorder — wraps getDisplayMedia with optional cropTo() element capture.
 *
 * When an `elementRef` is passed to `start()`, the stream is cropped to that
 * element using the Element Capture API (Chrome 122+). This records only the
 * iframe content at its actual rendered size — no AdCast UI chrome.
 *
 * Falls back to full tab capture if cropTo() is not supported.
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

  const start = useCallback(async (elementRef) => {
    setError(null);
    setBlob(null);
    setState('requesting');

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true
      });
      streamRef.current = stream;

      // Attempt to crop to the target element (Chrome 122+ Element Capture API)
      if (elementRef?.current && stream.getVideoTracks().length > 0) {
        const track = stream.getVideoTracks()[0];
        if (typeof track.cropTo === 'function') {
          try {
            const cropTarget = await CropTarget.fromElement(elementRef.current);
            await track.cropTo(cropTarget);
          } catch (cropErr) {
            console.warn('cropTo() failed, falling back to full tab capture:', cropErr);
          }
        }
      }

      // Pick best supported codec — prefer vp9 for quality
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

      const mr = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 20_000_000 // 20Mbps for crisp creative capture
      });
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
      mr.start(250); // smaller chunks for smoother quality

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
