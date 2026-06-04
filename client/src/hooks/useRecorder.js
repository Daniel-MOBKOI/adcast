import { useState, useRef, useCallback } from 'react';

/**
 * useRecorder — two-phase recording:
 *
 *   Phase 1 — requestStream()
 *     Fires getDisplayMedia immediately. Browser permission popup appears.
 *     Call this BEFORE opening the lightbox so the popup doesn't disrupt the ad.
 *     State: idle → requesting → streamReady
 *
 *   Phase 2 — beginRecording(elementRef)
 *     Stream is already granted. Crops to element, starts MediaRecorder instantly.
 *     No popup — no page disruption.
 *     State: streamReady → recording → done
 */
export function useRecorder() {
  const [state, setState] = useState('idle'); // idle | requesting | streamReady | recording | done | error
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [blob, setBlob] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const secondsRef = useRef(0);

  // ── Phase 1: request stream (fires permission popup) ──────────────────────
  const requestStream = useCallback(async () => {
    setError(null);
    setBlob(null);
    setState('requesting');

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
      });
      streamRef.current = stream;

      // If user clicks "Stop sharing" in browser UI before recording starts
      stream.getVideoTracks()[0].onended = () => {
        setState('idle');
        streamRef.current = null;
      };

      setState('streamReady');
    } catch (err) {
      setState('error');
      setError(err.name === 'NotAllowedError'
        ? 'Permission denied — please allow tab capture when prompted.'
        : err.message);
    }
  }, []);

  // ── Phase 2: begin recording (stream already granted) ────────────────────
  const beginRecording = useCallback(async (elementRef) => {
    const stream = streamRef.current;
    if (!stream) { setError('No stream — please try again.'); setState('error'); return; }

    // Attempt cropTo() on the target element (Chrome 122+ Element Capture API)
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

    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    const mr = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 20_000_000,
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
      streamRef.current = null;
    };

    // If user clicks "Stop sharing" mid-recording
    stream.getVideoTracks()[0].onended = () => {
      if (mr.state === 'recording') mr.stop();
    };

    secondsRef.current = 0;
    setDuration(0);
    setState('recording');
    mr.start(250);

    timerRef.current = setInterval(() => {
      secondsRef.current += 1;
      setDuration(secondsRef.current);
    }, 1000);
  }, []);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    clearInterval(timerRef.current);
  }, []);

  const reset = useCallback(() => {
    stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setBlob(null);
    setDuration(0);
    setError(null);
    setState('idle');
  }, [stop]);

  return { state, duration, error, blob, requestStream, beginRecording, stop, reset };
}
