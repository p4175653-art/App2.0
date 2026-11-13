export const DEFAULT_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB proxy-safe chunks

const RESUMABLE_SESSIONS_STORAGE_KEY = 'angel_class_resumable_sessions_v1';

export type ResumableUploadPhase =
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'waiting_network'
  | 'assembling'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface ResumableUploadProgress {
  uploadId: string;
  phase: ResumableUploadPhase;
  percentage: number;
  uploadedBytes: number;
  totalBytes: number;
  remainingBytes: number;
  currentChunk: number;
  totalChunks: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  statusText: string;
}

export interface ResumableUploadOptions {
  file: File;
  sectionId: string;
  getAuthToken: () => string;
  refreshAuthToken?: () => Promise<boolean>;
  duration?: string;
  thumbnailDataUrl?: string;
  firebaseUrl?: string | null;
  storagePath?: string | null;
  thumbnailUrl?: string | null;
  chunkSize?: number;
  onProgress?: (progress: ResumableUploadProgress) => void;
  onControllerReady?: (controller: ResumableUploadController) => void;
}

export interface ResumableUploadController {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  isPaused: () => boolean;
}

interface StoredUploadSession {
  uploadId: string;
  fileId: string;
  sectionId: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  updatedAt: number;
}

export function formatBytesReadable(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatEtaReadable(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s left`;
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (mins < 60) return `${mins}m ${secs}s left`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m left`;
}

function getFingerprintKey(sectionId: string, file: File): string {
  return `${sectionId}::${file.name}::${file.size}::${file.lastModified}`;
}

function readStoredSessions(): Record<string, StoredUploadSession> {
  try {
    const raw = localStorage.getItem(RESUMABLE_SESSIONS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStoredSession(key: string, session: StoredUploadSession) {
  try {
    const all = readStoredSessions();
    all[key] = session;
    // Prune stale entries older than 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(all)) {
      if (!v || v.updatedAt < cutoff) delete all[k];
    }
    localStorage.setItem(RESUMABLE_SESSIONS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage quota errors
  }
}

function removeStoredSession(key: string) {
  try {
    const all = readStoredSessions();
    if (key in all) {
      delete all[key];
      localStorage.setItem(RESUMABLE_SESSIONS_STORAGE_KEY, JSON.stringify(all));
    }
  } catch {
    // ignore
  }
}

export function getSavedResumeSession(sectionId: string, file: File): StoredUploadSession | null {
  const all = readStoredSessions();
  return all[getFingerprintKey(sectionId, file)] || null;
}

function waitForOnlineOrResume(
  shouldAbort: () => boolean,
  isPaused: () => boolean,
  timeoutMs: number
): Promise<'retry' | 'resumed' | 'aborted'> {
  return new Promise((resolve) => {
    if (shouldAbort()) {
      resolve('aborted');
      return;
    }

    const onOnline = () => {
      cleanup();
      resolve('resumed');
    };

    const poll = setInterval(() => {
      if (shouldAbort()) {
        cleanup();
        resolve('aborted');
      } else if (!isPaused() && (typeof navigator === 'undefined' || navigator.onLine)) {
        // Allow timer to finish backoff unless online event fired
      }
    }, 300);

    const timer = setTimeout(() => {
      cleanup();
      resolve(shouldAbort() ? 'aborted' : 'retry');
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline, { once: true });
    }
  });
}

function uploadSingleChunk(
  uploadId: string,
  chunkIndex: number,
  blob: Blob,
  authToken: string,
  onChunkProgress: (loadedBytes: number) => void,
  registerXhrAbort: (abortFn: (() => void) | null) => void
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/files/upload/chunk/${encodeURIComponent(uploadId)}/${chunkIndex}`, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    xhr.setRequestHeader('x-chunk-size', String(blob.size));

    let abortedLocally = false;
    registerXhrAbort(() => {
      abortedLocally = true;
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    });

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        onChunkProgress(Math.min(blob.size, evt.loaded));
      }
    };

    xhr.onload = () => {
      registerXhrAbort(null);
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        data = {};
      }
      resolve({ status: xhr.status, data });
    };

    xhr.onerror = () => {
      registerXhrAbort(null);
      reject(new Error(abortedLocally ? 'PAUSED_OR_CANCELLED' : 'NETWORK_INTERRUPTED'));
    };

    xhr.onabort = () => {
      registerXhrAbort(null);
      reject(new Error(abortedLocally ? 'PAUSED_OR_CANCELLED' : 'NETWORK_INTERRUPTED'));
    };

    xhr.send(blob);
  });
}

/**
 * Chunked & resumable uploader for files of any size.
 * Persists session ID in localStorage so interrupted uploads resume from the last verified chunk.
 */
export async function uploadFileResumable(options: ResumableUploadOptions): Promise<any> {
  const {
    file,
    sectionId,
    getAuthToken,
    refreshAuthToken,
    duration,
    thumbnailDataUrl,
    firebaseUrl,
    storagePath,
    thumbnailUrl,
    onProgress,
    onControllerReady
  } = options;

  const chunkSize = options.chunkSize || DEFAULT_UPLOAD_CHUNK_SIZE;
  const totalBytes = file.size;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
  const sessionKey = getFingerprintKey(sectionId, file);
  const existingSession = getSavedResumeSession(sectionId, file);

  let paused = false;
  let cancelled = false;
  let currentXhrAbort: (() => void) | null = null;
  let pauseResolver: (() => void) | null = null;

  let activeUploadId = existingSession?.uploadId || '';

  const controller: ResumableUploadController = {
    pause: () => {
      if (cancelled || paused) return;
      paused = true;
      currentXhrAbort?.();
    },
    resume: () => {
      if (cancelled) return;
      paused = false;
      if (pauseResolver) {
        const res = pauseResolver;
        pauseResolver = null;
        res();
      }
    },
    cancel: () => {
      cancelled = true;
      paused = false;
      currentXhrAbort?.();
      if (pauseResolver) {
        const res = pauseResolver;
        pauseResolver = null;
        res();
      }
      if (activeUploadId) {
        const token = getAuthToken();
        if (token) {
          fetch(`/api/files/upload/${encodeURIComponent(activeUploadId)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
          }).catch(() => {});
        }
        removeStoredSession(sessionKey);
      }
    },
    isPaused: () => paused
  };

  onControllerReady?.(controller);

  const waitWhilePaused = async (currentProgress: ResumableUploadProgress) => {
    if (!paused || cancelled) return;
    onProgress?.({
      ...currentProgress,
      phase: 'paused',
      speedBytesPerSec: 0,
      etaSeconds: null,
      statusText: `Paused at ${currentProgress.percentage}% (${formatBytesReadable(currentProgress.remainingBytes)} remaining)`
    });
    await new Promise<void>((resolve) => {
      pauseResolver = resolve;
    });
  };

  const ensureAuthToken = async (): Promise<string> => {
    let token = getAuthToken();
    if (!token && refreshAuthToken) {
      await refreshAuthToken();
      token = getAuthToken();
    }
    if (!token) {
      throw new Error('Authentication required to upload files.');
    }
    return token;
  };

  let authToken = await ensureAuthToken();

  onProgress?.({
    uploadId: activeUploadId,
    phase: 'initializing',
    percentage: 0,
    uploadedBytes: 0,
    totalBytes,
    remainingBytes: totalBytes,
    currentChunk: 0,
    totalChunks,
    speedBytesPerSec: 0,
    etaSeconds: null,
    statusText: existingSession ? 'Checking previously uploaded chunks...' : 'Preparing upload...'
  });

  // Step 1: Initialize or resume upload session on backend
  const initBody = {
    uploadId: activeUploadId || undefined,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    fileSize: totalBytes,
    lastModified: file.lastModified,
    section: sectionId,
    chunkSize,
    totalChunks,
    duration: duration || undefined,
    firebaseUrl: firebaseUrl || undefined,
    storagePath: storagePath || undefined,
    thumbnailUrl: thumbnailUrl || undefined
  };

  let initRes = await fetch('/api/files/upload/init', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify(initBody)
  });

  if (initRes.status === 401 && refreshAuthToken) {
    const refreshed = await refreshAuthToken();
    if (refreshed) {
      authToken = getAuthToken();
      initRes = await fetch('/api/files/upload/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify(initBody)
      });
    }
  }

  const initData = await initRes.json().catch(() => ({}));
  if (!initRes.ok) {
    throw new Error(initData.error || `Failed to initialize upload (HTTP ${initRes.status})`);
  }

  activeUploadId = initData.uploadId;
  const serverChunkSize = initData.chunkSize || chunkSize;
  const serverTotalChunks = initData.totalChunks || Math.max(1, Math.ceil(totalBytes / serverChunkSize));
  const uploadedChunkSet = new Set<number>(Array.isArray(initData.uploadedChunks) ? initData.uploadedChunks : []);

  saveStoredSession(sessionKey, {
    uploadId: activeUploadId,
    fileId: initData.fileId,
    sectionId,
    fileName: file.name,
    fileSize: totalBytes,
    lastModified: file.lastModified,
    updatedAt: Date.now()
  });

  const computeCompletedBytes = () => {
    let bytes = 0;
    for (const idx of uploadedChunkSet) {
      const start = idx * serverChunkSize;
      const end = Math.min(totalBytes, start + serverChunkSize);
      if (end > start) bytes += end - start;
    }
    return Math.min(totalBytes, bytes);
  };

  let verifiedBytes = computeCompletedBytes();
  let emaSpeed = 0;

  // Step 2: Upload remaining chunks sequentially with resume & retry support
  for (let chunkIndex = 0; chunkIndex < serverTotalChunks; chunkIndex++) {
    if (cancelled) {
      throw new Error('Upload cancelled.');
    }

    if (uploadedChunkSet.has(chunkIndex)) {
      continue;
    }

    const start = chunkIndex * serverChunkSize;
    const end = Math.min(totalBytes, start + serverChunkSize);
    const chunkBlob = file.slice(start, end);

    let chunkUploaded = false;
    let attempt = 0;

    while (!chunkUploaded) {
      if (cancelled) {
        throw new Error('Upload cancelled.');
      }

      if (paused) {
        const pct = totalBytes > 0 ? Math.min(99, Math.round((verifiedBytes / totalBytes) * 100)) : 0;
        await waitWhilePaused({
          uploadId: activeUploadId,
          phase: 'paused',
          percentage: pct,
          uploadedBytes: verifiedBytes,
          totalBytes,
          remainingBytes: Math.max(0, totalBytes - verifiedBytes),
          currentChunk: chunkIndex + 1,
          totalChunks: serverTotalChunks,
          speedBytesPerSec: 0,
          etaSeconds: null,
          statusText: `Paused at ${pct}%`
        });
        if (cancelled) throw new Error('Upload cancelled.');
      }

      const chunkStartedAt = Date.now();
      let lastTickAt = chunkStartedAt;
      let lastTickBytes = 0;

      try {
        authToken = await ensureAuthToken();
        const result = await uploadSingleChunk(
          activeUploadId,
          chunkIndex,
          chunkBlob,
          authToken,
          (chunkLoaded) => {
            const now = Date.now();
            const dt = (now - lastTickAt) / 1000;
            const dBytes = chunkLoaded - lastTickBytes;
            if (dt >= 0.25 && dBytes > 0) {
              const instSpeed = dBytes / dt;
              emaSpeed = emaSpeed > 0 ? emaSpeed * 0.7 + instSpeed * 0.3 : instSpeed;
              lastTickAt = now;
              lastTickBytes = chunkLoaded;
            }

            const totalUploaded = Math.min(totalBytes, verifiedBytes + chunkLoaded);
            const remaining = Math.max(0, totalBytes - totalUploaded);
            const pct = totalBytes > 0 ? Math.min(99, Math.round((totalUploaded / totalBytes) * 100)) : 0;
            const eta = emaSpeed > 0 ? remaining / emaSpeed : null;
            const etaText = formatEtaReadable(eta);

            onProgress?.({
              uploadId: activeUploadId,
              phase: 'uploading',
              percentage: pct,
              uploadedBytes: totalUploaded,
              totalBytes,
              remainingBytes: remaining,
              currentChunk: chunkIndex + 1,
              totalChunks: serverTotalChunks,
              speedBytesPerSec: emaSpeed,
              etaSeconds: eta,
              statusText: `${formatBytesReadable(remaining)} remaining${etaText ? ` • ${etaText}` : ''} (Part ${chunkIndex + 1}/${serverTotalChunks})`
            });
          },
          (abortFn) => {
            currentXhrAbort = abortFn;
          }
        );

        if (result.status === 401 && refreshAuthToken) {
          const refreshed = await refreshAuthToken();
          if (refreshed) {
            authToken = getAuthToken();
            continue;
          }
        }

        if (result.status >= 200 && result.status < 300) {
          uploadedChunkSet.add(chunkIndex);
          verifiedBytes = computeCompletedBytes();
          const elapsedSec = Math.max(0.1, (Date.now() - chunkStartedAt) / 1000);
          const chunkSpeed = chunkBlob.size / elapsedSec;
          emaSpeed = emaSpeed > 0 ? emaSpeed * 0.7 + chunkSpeed * 0.3 : chunkSpeed;

          const remaining = Math.max(0, totalBytes - verifiedBytes);
          const pct = totalBytes > 0 ? Math.min(99, Math.round((verifiedBytes / totalBytes) * 100)) : 99;
          const eta = emaSpeed > 0 ? remaining / emaSpeed : null;
          const etaText = formatEtaReadable(eta);

          onProgress?.({
            uploadId: activeUploadId,
            phase: 'uploading',
            percentage: pct,
            uploadedBytes: verifiedBytes,
            totalBytes,
            remainingBytes: remaining,
            currentChunk: chunkIndex + 1,
            totalChunks: serverTotalChunks,
            speedBytesPerSec: emaSpeed,
            etaSeconds: eta,
            statusText: remaining > 0
              ? `${formatBytesReadable(remaining)} remaining${etaText ? ` • ${etaText}` : ''} (Part ${chunkIndex + 1}/${serverTotalChunks})`
              : 'Verifying file integrity...'
          });

          chunkUploaded = true;
        } else if (result.status >= 500 || result.status === 429 || result.status === 408) {
          throw new Error(`TRANSIENT_HTTP_${result.status}`);
        } else {
          throw new Error(result.data?.error || `Upload rejected (HTTP ${result.status})`);
        }
      } catch (err: any) {
        if (err?.message === 'PAUSED_OR_CANCELLED') {
          if (cancelled) throw new Error('Upload cancelled.');
          continue; // loop will pause cleanly via waitWhilePaused
        }

        const isNetworkOrTransient =
          err?.message === 'NETWORK_INTERRUPTED' ||
          String(err?.message || '').startsWith('TRANSIENT_HTTP_') ||
          (typeof navigator !== 'undefined' && !navigator.onLine);

        if (!isNetworkOrTransient) {
          throw err;
        }

        attempt++;
        const backoffMs = Math.min(15000, 1500 * Math.pow(1.6, Math.min(attempt, 6)));
        const pct = totalBytes > 0 ? Math.min(99, Math.round((verifiedBytes / totalBytes) * 100)) : 0;
        const remaining = Math.max(0, totalBytes - verifiedBytes);

        onProgress?.({
          uploadId: activeUploadId,
          phase: 'waiting_network',
          percentage: pct,
          uploadedBytes: verifiedBytes,
          totalBytes,
          remainingBytes: remaining,
          currentChunk: chunkIndex + 1,
          totalChunks: serverTotalChunks,
          speedBytesPerSec: 0,
          etaSeconds: null,
          statusText: `Connection interrupted at ${pct}% (${formatBytesReadable(remaining)} remaining). Retrying automatically...`
        });

        const outcome = await waitForOnlineOrResume(
          () => cancelled,
          () => paused,
          backoffMs
        );
        if (outcome === 'aborted') {
          throw new Error('Upload cancelled.');
        }

        // Sync actual verified chunks from server before retrying
        try {
          const freshToken = await ensureAuthToken();
          const statusRes = await fetch(`/api/files/upload/status/${encodeURIComponent(activeUploadId)}`, {
            headers: { Authorization: `Bearer ${freshToken}` }
          });
          if (statusRes.ok) {
            const st = await statusRes.json();
            if (Array.isArray(st.uploadedChunks)) {
              for (const idx of st.uploadedChunks) uploadedChunkSet.add(idx);
              verifiedBytes = computeCompletedBytes();
              if (uploadedChunkSet.has(chunkIndex)) {
                chunkUploaded = true;
              }
            }
          }
        } catch {
          // Will retry chunk directly
        }

        if (attempt >= 12 && !chunkUploaded) {
          // Pause automatically instead of losing progress so user can manually click Resume when connection returns
          paused = true;
          onProgress?.({
            uploadId: activeUploadId,
            phase: 'paused',
            percentage: pct,
            uploadedBytes: verifiedBytes,
            totalBytes,
            remainingBytes: remaining,
            currentChunk: chunkIndex + 1,
            totalChunks: serverTotalChunks,
            speedBytesPerSec: 0,
            etaSeconds: null,
            statusText: `Network offline — paused at ${pct}%. Click Resume to continue.`
          });
        }
      }
    }
  }

  // Step 3: Assemble chunks and verify byte-exact completion on server
  onProgress?.({
    uploadId: activeUploadId,
    phase: 'assembling',
    percentage: 99,
    uploadedBytes: totalBytes,
    totalBytes,
    remainingBytes: 0,
    currentChunk: serverTotalChunks,
    totalChunks: serverTotalChunks,
    speedBytesPerSec: emaSpeed,
    etaSeconds: 0,
    statusText: 'Finalizing & verifying file integrity...'
  });

  authToken = await ensureAuthToken();
  let completeRes = await fetch(`/api/files/upload/complete/${encodeURIComponent(activeUploadId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      duration: duration || undefined,
      thumbnailDataUrl: thumbnailDataUrl || undefined,
      firebaseUrl: firebaseUrl || undefined,
      storagePath: storagePath || undefined,
      thumbnailUrl: thumbnailUrl || undefined
    })
  });

  if (completeRes.status === 401 && refreshAuthToken) {
    const refreshed = await refreshAuthToken();
    if (refreshed) {
      authToken = getAuthToken();
      completeRes = await fetch(`/api/files/upload/complete/${encodeURIComponent(activeUploadId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          duration: duration || undefined,
          thumbnailDataUrl: thumbnailDataUrl || undefined,
          firebaseUrl: firebaseUrl || undefined,
          storagePath: storagePath || undefined,
          thumbnailUrl: thumbnailUrl || undefined
        })
      });
    }
  }

  const completeData = await completeRes.json().catch(() => ({}));
  if (!completeRes.ok) {
    throw new Error(completeData.error || `Failed to finalize upload (HTTP ${completeRes.status})`);
  }

  removeStoredSession(sessionKey);

  onProgress?.({
    uploadId: activeUploadId,
    phase: 'completed',
    percentage: 100,
    uploadedBytes: totalBytes,
    totalBytes,
    remainingBytes: 0,
    currentChunk: serverTotalChunks,
    totalChunks: serverTotalChunks,
    speedBytesPerSec: emaSpeed,
    etaSeconds: 0,
    statusText: 'Upload complete & verified'
  });

  return completeData;
}
