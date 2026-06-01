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

export async function createJob({ clipBlob, publisherId, publisherLabel }) {
  const fd = new FormData();
  fd.append('clip', clipBlob, 'recording.webm');
  fd.append('publisherId', publisherId);
  fd.append('publisherLabel', publisherLabel || '');
  const res = await apiFetch('/jobs', { method: 'POST', body: fd });
  return res.json();
}

export async function pollJob(jobId) {
  const res = await apiFetch(`/jobs/${jobId}`);
  return res.json();
}

export function downloadUrl(jobId) {
  return `${BASE}/jobs/${jobId}/download?token=${encodeURIComponent(getToken())}`;
}
