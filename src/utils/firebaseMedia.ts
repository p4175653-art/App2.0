import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from 'firebase/storage';
import {
  collection,
  doc,
  setDoc,
  getDocs,
  deleteDoc,
  query,
  where
} from 'firebase/firestore';
import {
  auth,
  db,
  storage,
  OperationType,
  handleFirestoreError
} from '../firebase';

export interface FirebaseStorageUploadResult {
  downloadUrl: string | null;
  storagePath: string | null;
}

export interface FirebaseUploadProgress {
  pct: number;
  bytesTransferred: number;
  totalBytes: number;
}

/**
 * Uploads a File directly to Firebase Storage using resumable upload under angel-class/{sectionId}/{fileId}_{name}.
 * Supports arbitrarily large files by monitoring byte activity rather than enforcing a fixed total-duration timeout.
 * Resolves with null values cleanly if Firebase Auth is inactive or Storage is unreachable/stalled,
 * allowing callers to complete persistence via the chunked backend storage endpoint without losing files.
 */
export async function uploadFileToFirebaseStorage(
  file: File,
  sectionId: string,
  fileId: string,
  onProgress?: (pct: number, details?: FirebaseUploadProgress) => void,
  options?: {
    signal?: AbortSignal;
    onTaskCreated?: (controls: { pause: () => boolean; resume: () => boolean; cancel: () => boolean }) => void;
  }
): Promise<FirebaseStorageUploadResult> {
  if (!auth.currentUser || options?.signal?.aborted) {
    return { downloadUrl: null, storagePath: null };
  }

  const safeSection = sectionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `angel-class/${safeSection}/${fileId}_${safeName}`;
  const storageRef = ref(storage, storagePath);

  return new Promise((resolve) => {
    let settled = false;
    let lastBytesTransferred = 0;
    let lastActivityAt = Date.now();
    let hasStartedTransfer = false;

    const finish = (res: FirebaseStorageUploadResult) => {
      if (settled) return;
      settled = true;
      clearInterval(stallCheckInterval);
      if (options?.signal) {
        options.signal.removeEventListener('abort', handleAbort);
      }
      resolve(res);
    };

    const uploadTask = uploadBytesResumable(storageRef, file, {
      contentType: file.type || 'application/octet-stream'
    });

    options?.onTaskCreated?.({
      pause: () => uploadTask.pause(),
      resume: () => uploadTask.resume(),
      cancel: () => uploadTask.cancel()
    });

    const handleAbort = () => {
      try {
        uploadTask.cancel();
      } catch {
        // ignore cancel errors
      }
      finish({ downloadUrl: null, storagePath: null });
    };

    if (options?.signal) {
      options.signal.addEventListener('abort', handleAbort);
    }

    // Monitor inactivity (not total upload duration) so multi-GB uploads can run indefinitely while active
    const stallCheckInterval = setInterval(() => {
      if (settled) return;
      const snap = uploadTask.snapshot;
      if (snap.state === 'paused') {
        lastActivityAt = Date.now();
        return;
      }
      const idleMs = Date.now() - lastActivityAt;
      const thresholdMs = hasStartedTransfer ? 60000 : 15000;
      if (idleMs > thresholdMs) {
        try {
          uploadTask.cancel();
        } catch {
          // ignore
        }
        finish({ downloadUrl: null, storagePath: null });
      }
    }, 5000);

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        if (snapshot.bytesTransferred > lastBytesTransferred) {
          lastBytesTransferred = snapshot.bytesTransferred;
          lastActivityAt = Date.now();
          hasStartedTransfer = true;
        }
        if (snapshot.totalBytes > 0 && onProgress) {
          const pct = Math.min(99, Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
          onProgress(pct, {
            pct,
            bytesTransferred: snapshot.bytesTransferred,
            totalBytes: snapshot.totalBytes
          });
        }
      },
      (err) => {
        console.warn('Firebase Storage upload notice:', err?.code || err?.message);
        finish({ downloadUrl: null, storagePath: null });
      },
      async () => {
        try {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          if (onProgress) {
            onProgress(100, {
              pct: 100,
              bytesTransferred: file.size,
              totalBytes: file.size
            });
          }
          finish({ downloadUrl, storagePath });
        } catch (err: any) {
          console.warn('Firebase Storage getDownloadURL notice:', err?.message);
          finish({ downloadUrl: null, storagePath: null });
        }
      }
    );
  });
}

export async function uploadThumbnailDataUrlToFirebase(
  dataUrl: string,
  sectionId: string,
  fileId: string
): Promise<string | null> {
  if (!auth.currentUser || !dataUrl.startsWith('data:image/')) {
    return null;
  }
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const safeSection = sectionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const thumbPath = `angel-class/${safeSection}/thumbs/thumb-${fileId}.jpg`;
    const thumbRef = ref(storage, thumbPath);
    const task = uploadBytesResumable(thumbRef, blob, { contentType: 'image/jpeg' });
    await task;
    return await getDownloadURL(thumbRef);
  } catch (err: any) {
    console.warn('Firebase thumbnail upload notice:', err?.message);
    return null;
  }
}

export async function saveCurriculumItemToFirestore(
  sectionId: string,
  item: Record<string, any>
): Promise<boolean> {
  if (!auth.currentUser) return false;

  const safeSection = sectionId.replace(/[^a-zA-Z0-9_-]/g, '');
  const rawId = String(item.id || `item-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const itemPath = `curriculum/${safeSection}/items/${rawId}`;

  const docPayload: Record<string, any> = {
    id: rawId,
    sectionId: safeSection,
    title: String(item.title || item.name || 'File').slice(0, 250),
    url: String(item.url || item.firebaseUrl || item.localUrl || '').slice(0, 2000),
    authorId: auth.currentUser.uid,
    status: item.status === 'pending_approval' ? 'pending_approval' : 'approved',
    createdAt: String(item.createdAt || item.uploadedAt || new Date().toISOString()).slice(0, 50)
  };

  if (item.name) docPayload.name = String(item.name).slice(0, 250);
  if (item.description) docPayload.description = String(item.description).slice(0, 2000);
  if (item.downloadUrl) docPayload.downloadUrl = String(item.downloadUrl).slice(0, 2000);
  if (item.firebaseUrl) docPayload.firebaseUrl = String(item.firebaseUrl).slice(0, 2000);
  if (item.localUrl) docPayload.localUrl = String(item.localUrl).slice(0, 1000);
  if (item.storagePath) docPayload.storagePath = String(item.storagePath).slice(0, 500);
  if (item.thumbnail && !String(item.thumbnail).startsWith('data:')) {
    docPayload.thumbnail = String(item.thumbnail).slice(0, 2000);
  }
  if (item.mimeType) docPayload.mimeType = String(item.mimeType).slice(0, 150);
  if (item.type) docPayload.type = String(item.type).slice(0, 150);
  if (typeof item.size === 'number' && Number.isFinite(item.size)) docPayload.size = item.size;
  if (item.duration) docPayload.duration = String(item.duration).slice(0, 50);
  if (item.audioUrl) docPayload.audioUrl = String(item.audioUrl).slice(0, 2000);
  if (item.uploadedBy) docPayload.uploadedBy = String(item.uploadedBy).slice(0, 200);
  if (item.uploadedByName) docPayload.uploadedByName = String(item.uploadedByName).slice(0, 150);
  if (item.date) docPayload.date = String(item.date).slice(0, 50);

  if (!docPayload.url) return false;

  try {
    await setDoc(doc(db, 'curriculum', safeSection, 'items', rawId), docPayload);
    return true;
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.CREATE, itemPath);
    } catch {
      // Structured Firestore error already logged cleanly
    }
    return false;
  }
}

export async function listCurriculumItemsFromFirestore(
  sectionId: string,
  isAdmin: boolean
): Promise<any[]> {
  if (!auth.currentUser) return [];

  const safeSection = sectionId.replace(/[^a-zA-Z0-9_-]/g, '');
  const listPath = `curriculum/${safeSection}/items`;
  try {
    const colRef = collection(db, 'curriculum', safeSection, 'items');
    const q = isAdmin ? query(colRef) : query(colRef, where('status', '==', 'approved'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.LIST, listPath);
    } catch {
      // Logged structured error cleanly
    }
    return [];
  }
}

export interface FirebaseDeleteResult {
  success: boolean;
  error?: string;
}

function tryBuildStorageRef(target: string) {
  if (!target) return null;
  if (!target.startsWith('http') || target.includes('firebasestorage.googleapis.com') || target.startsWith('gs://')) {
    try {
      return ref(storage, target);
    } catch {
      return null;
    }
  }
  return null;
}

export async function deleteCurriculumItemFromFirebase(
  sectionId: string,
  itemId: string,
  storagePath?: string,
  firebaseUrl?: string,
  thumbnailUrl?: string
): Promise<FirebaseDeleteResult> {
  if (!auth.currentUser) {
    return { success: true };
  }

  const safeSection = sectionId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeId = itemId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeSection || !safeId) {
    return { success: true };
  }

  const storageTargets = [storagePath, firebaseUrl, thumbnailUrl].filter(
    (t): t is string => typeof t === 'string' && t.trim().length > 0
  );
  for (const target of storageTargets) {
    const storageRef = tryBuildStorageRef(target);
    if (!storageRef) continue;
    try {
      await deleteObject(storageRef);
    } catch (err: any) {
      if (err?.code !== 'storage/object-not-found') {
        console.warn('Firebase Storage delete notice:', err?.code || err?.message);
      }
    }
  }

  try {
    await deleteDoc(doc(db, 'curriculum', safeSection, 'items', safeId));
    return { success: true };
  } catch (err: any) {
    try {
      handleFirestoreError(err, OperationType.DELETE, `curriculum/${safeSection}/items/${safeId}`);
    } catch {
      // Logged structured error cleanly
    }
    return {
      success: false,
      error: err?.message || 'Permission denied while deleting record from cloud database.'
    };
  }
}

export async function deleteCurriculumSectionFromFirebase(sectionId: string): Promise<FirebaseDeleteResult> {
  if (!auth.currentUser) {
    return { success: true };
  }

  const safeSection = sectionId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeSection) {
    return { success: true };
  }

  try {
    const colRef = collection(db, 'curriculum', safeSection, 'items');
    const snap = await getDocs(colRef);
    for (const d of snap.docs) {
      const data = d.data();
      const res = await deleteCurriculumItemFromFirebase(
        safeSection,
        d.id,
        data?.storagePath,
        data?.firebaseUrl,
        data?.thumbnail
      );
      if (!res.success) {
        return res;
      }
    }
    try {
      await deleteDoc(doc(db, 'curriculum', safeSection));
    } catch {
      // Section metadata document may not exist in Firestore; ignore
    }
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to clean up folder records in cloud database.'
    };
  }
}
