import { useState, useRef, useCallback } from 'react';

/**
 * useRecorder — two-phase recording with cropRect capture.
 *
 *   Phase 1 — requestStream(wrapRef)
 *     Captures getBoundingClientRect of wrapRef × devicePixelRatio BEFORE
 *     firing getDisplayMedia, so we have the crop coordinates ready.
 *     State: idle → requesting → streamReady
 *
 *   Phase 2 — beginRecording()
 *     Stream already granted. Starts MediaRecorder instantly.
 *     State: streamReady → recording → done
 */
export function useRecorder() {
  const [state,    setState]    = useState('idle');
  const [duration, setDuration] = useState(0);
  const [error,    setError]    = useState(null);
  const [blob,     setBlob]     = useState(null);
  const [cropRect, setCropRect] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef        = useRef([]);
  const streamRef        = useRef(null);
  const timerRef         = useRef(null);
  const secondsRef       = useRef(0);

  // ── Phase 1: capture cropRect then request stream ─────────────────────────
  const requestStream = useCallback(async (wrapRef) => {
    setError(null);
    setBlob(null);
    setCropRect(null);
    setState('requesting');

    // Capture bounding box BEFORE permission popup (element is visible and stable)
    if (wrapRef?.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      setCropRect({
        x:      Math.round(rect.left   * dpr),
        y:      Math.round(rect.top    * dpr),
        width:  Math.round(rect.width  * dpr),
        height: Math.round(rect.height * dpr),
      });
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
      });
      streamRef.current = stream;

      stream.getVideoTracks()[0].onended = () => {
        setState('idle');
        streamRef.current = null;
      };

      setState('streamReady');
    } catch (err) {
      setState('error');
      setCropRect(null);
      setError(err.name === 'NotAllowedError'
        ? 'Permission denied — please allow tab capture when prompted.'
        : err.message);
    }
  }, []);

  // ── Phase 2: begin recording (stream already granted) ────────────────────
  const beginRecording = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream) { setError('No stream — please try again.'); setState('error'); return; }

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
    setCropRect(null);
    setState('idle');
  }, [stop]);

  return { state, duration, error, blob, cropRect, requestStream, beginRecording, stop, reset };
}
