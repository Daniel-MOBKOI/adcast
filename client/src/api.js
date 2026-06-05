const BASE = '/api';

function getToken() {
  return sessionStorage.getItem('adcast_token') || '';
}

export function setToken(token) {
  sessionStorage.setItem('adcast_token', token);
}

export function clearToken() {
  sessionStorage.removeItem('adcast_token');
}

async function apiFetch(path, options = {}) {
  const headers = {
    'Authorization': `Bearer ${getToken()}`,
    ...(options.headers || {})
  };
  const res = await fetch(BASE + path, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Unauthorized');
  }
  return res;
}

export async function getPublishers() {
  const res = await apiFetch('/publishers');
  return res.json();
}

export async function uploadPublisher(file, label) {
  const fd = new FormData();
  fd.append('screenshot', file);
  fd.append('label', label || file.name);
  const res = await apiFetch('/publishers/upload', { method: 'POST', body: fd });
  return res.json();
}

export async function createJob({ clipBlob, publisherId, publisherLabel, trimStart, trimEnd, cropRect }) {
  const fd = new FormData();
  fd.append('clip', clipBlob, 'recording.webm');
  fd.append('publisherId', publisherId);
  fd.append('publisherLabel', publisherLabel || '');
  if (trimStart  != null) fd.append('trimStart',  trimStart.toFixed(3));
  if (trimEnd    != null) fd.append('trimEnd',    trimEnd.toFixed(3));
  if (cropRect   != null) fd.append('cropRect',   JSON.stringify(cropRect));
  const res = await apiFetch('/jobs', { method: 'POST', body: fd });
  return res.json();
}

export async function pollJob(jobId) {
  const res = await apiFetch(`/jobs/${jobId}`);
  return res.json();
}

export async function downloadJob(jobId) {
  const res = await apiFetch(`/jobs/${jobId}/download`);
  return res.blob();
}

// ── Mobile session API ─────────────────────────────────────────────────────

export async function createMobileSession(creativeId) {
  const res = await apiFetch('/mobile-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creativeId }),
  });
  return res.json(); // { token }
}

export async function pollMobileSession(token) {
  const res = await apiFetch(`/mobile-sessions/${token}/status`);
  return res.json(); // { status, error }
}

export async function fetchMobileClip(token) {
  const res = await apiFetch(`/mobile-sessions/${token}/clip`);
  if (!res.ok) throw new Error('Failed to fetch mobile clip');
  return res.blob(); // returns the cropped MP4 as a blob
}
