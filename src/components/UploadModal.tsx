import React, { useState, useRef } from 'react';
import { Upload, X, FileText, CheckCircle2, AlertCircle, Folder, Plus, Loader2, Film, Music, Pause, Play, RotateCcw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useContent } from '../context/ContentContext';
import { extractAudioMetadata, extractVideoMetadata, isAudioFile, isVideoFile, VideoMetadataResult } from '../utils/videoThumbnail';
import {
  uploadThumbnailDataUrlToFirebase,
  saveCurriculumItemToFirestore
} from '../utils/firebaseMedia';
import {
  uploadFileResumable,
  getSavedResumeSession,
  formatBytesReadable,
  ResumableUploadProgress,
  ResumableUploadController
} from '../utils/resumableUpload';

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus',
  '.mp4', '.webm', '.mov', '.m4v', '.3gp', '.mkv',
  '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.zip'
]);

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultSectionId?: string | null;
  onUploadSuccess?: () => void;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  onClose,
  defaultSectionId,
  onUploadSuccess
}) => {
  const { token, checkSession } = useAuth();
  const { sections, notifyContentChanged } = useContent();
  const uploadableSections = sections;

  const resolveInitialSection = (secId?: string | null) => {
    if (secId && uploadableSections.some((s) => s.id === secId)) {
      return secId;
    }
    return uploadableSections[0]?.id || 'videos';
  };

  const [targetSection, setTargetSection] = useState<string>(
    resolveInitialSection(defaultSectionId)
  );
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [videoMetaMap, setVideoMetaMap] = useState<Record<string, VideoMetadataResult>>({});
  const [uploading, setUploading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [fileProgressMap, setFileProgressMap] = useState<Record<string, ResumableUploadProgress>>({});
  const [completedKeys, setCompletedKeys] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState<number>(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeControllerRef = useRef<ResumableUploadController | null>(null);
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;

  const fileKey = (file: File) => `${file.name}-${file.size}-${file.lastModified}`;

  // Sync defaultSectionId when modal opens or section changes
  React.useEffect(() => {
    if (isOpen) {
      setTargetSection(resolveInitialSection(defaultSectionId));
      setError(null);
      setSuccessCount(0);
      setIsPaused(false);
    }
  }, [defaultSectionId, isOpen]);

  if (!isOpen) return null;

  const getExtension = (filename: string) => {
    const idx = filename.lastIndexOf('.');
    return idx !== -1 ? filename.slice(idx).toLowerCase() : '';
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const rawFiles = Array.from(e.target.files);
      e.target.value = '';

      const validFiles: File[] = [];
      const rejectedMessages: string[] = [];

      for (const file of rawFiles) {
        const ext = getExtension(file.name);
        if (!ext || !ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
          rejectedMessages.push(`"${file.name}" (${ext || 'unknown type'}) is not a supported file format.`);
          continue;
        }
        if (file.size === 0) {
          rejectedMessages.push(`"${file.name}" is empty (0 bytes).`);
          continue;
        }
        validFiles.push(file);
      }

      if (validFiles.length > 0) {
        setSelectedFiles((prev) => [...prev, ...validFiles]);
      }
      setError(rejectedMessages.length > 0 ? rejectedMessages[0] : null);

      // Automatically extract video thumbnails / duration and audio duration
      for (const file of validFiles) {
        const key = fileKey(file);
        if (isVideoFile(file)) {
          extractVideoMetadata(file).then((meta) => {
            if (meta.thumbnailDataUrl || meta.duration) {
              setVideoMetaMap((prev) => ({ ...prev, [key]: meta }));
            }
          });
        } else if (isAudioFile(file)) {
          extractAudioMetadata(file).then((meta) => {
            if (meta.duration) {
              setVideoMetaMap((prev) => ({ ...prev, [key]: { duration: meta.duration } }));
            }
          });
        }
      }
    }
  };

  const removeFile = (index: number) => {
    const file = selectedFiles[index];
    if (file) {
      const key = fileKey(file);
      setVideoMetaMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setFileProgressMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleTogglePauseResume = () => {
    const ctrl = activeControllerRef.current;
    if (!ctrl) return;
    if (ctrl.isPaused()) {
      setIsPaused(false);
      ctrl.resume();
    } else {
      setIsPaused(true);
      ctrl.pause();
    }
  };

  const handleCancelActiveUpload = () => {
    const ctrl = activeControllerRef.current;
    if (ctrl) {
      setIsPaused(false);
      ctrl.cancel();
    }
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      setError('Please choose at least one file to upload.');
      return;
    }

    const initialToken = tokenRef.current || localStorage.getItem('angel_class_token');
    if (!initialToken) {
      setError('Please log in to upload files.');
      return;
    }

    setUploading(true);
    setIsPaused(false);
    setError(null);
    setCompletedKeys({});
    let completed = 0;

    for (const file of selectedFiles) {
      const key = fileKey(file);
      try {
        // Extract video/audio metadata if not yet complete
        let meta = videoMetaMap[key];
        if (isVideoFile(file) && !meta?.thumbnailDataUrl) {
          meta = await extractVideoMetadata(file);
          if (meta.thumbnailDataUrl || meta.duration) {
            setVideoMetaMap((prev) => ({ ...prev, [key]: meta }));
          }
        } else if (isAudioFile(file) && !meta?.duration) {
          const audioMeta = await extractAudioMetadata(file);
          if (audioMeta.duration) {
            meta = { duration: audioMeta.duration };
            setVideoMetaMap((prev) => ({ ...prev, [key]: meta }));
          }
        }

        const result = await uploadFileResumable({
          file,
          sectionId: targetSection,
          getAuthToken: () => localStorage.getItem('angel_class_token') || tokenRef.current || '',
          refreshAuthToken: checkSession,
          duration: meta?.duration,
          thumbnailDataUrl: meta?.thumbnailDataUrl,
          onControllerReady: (ctrl) => {
            activeControllerRef.current = ctrl;
          },
          onProgress: (progress) => {
            setFileProgressMap((prev) => ({ ...prev, [key]: progress }));
            setIsPaused(progress.phase === 'paused');
          }
        });

        activeControllerRef.current = null;
        let savedItem = result?.item || null;

        // Upload small extracted video thumbnail & sync item record to Firestore if signed in to Firebase
        if (savedItem) {
          if (meta?.thumbnailDataUrl) {
            const fbThumbUrl = await uploadThumbnailDataUrlToFirebase(
              meta.thumbnailDataUrl,
              targetSection,
              savedItem.id
            );
            if (fbThumbUrl) {
              savedItem = { ...savedItem, thumbnail: fbThumbUrl };
            }
          }
          await saveCurriculumItemToFirestore(targetSection, savedItem);
        }

        setCompletedKeys((prev) => ({ ...prev, [key]: true }));
        completed++;
      } catch (err: any) {
        activeControllerRef.current = null;
        setIsPaused(false);
        setError(err?.message === 'Upload cancelled.' ? 'Upload cancelled.' : (err?.message || `Failed to upload ${file.name}`));
        setUploading(false);
        return;
      }
    }

    setSuccessCount(completed);
    setUploading(false);
    setIsPaused(false);
    setSelectedFiles([]);
    setVideoMetaMap({});
    await notifyContentChanged();
    if (onUploadSuccess) onUploadSuccess();

    // Auto-close after brief delay
    setTimeout(() => {
      onClose();
      setSuccessCount(0);
      setFileProgressMap({});
      setCompletedKeys({});
    }, 900);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-2xl bg-white border border-stone-200 shadow-2xl p-6 relative flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-stone-200">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#0F382A] text-amber-300 flex items-center justify-center shadow-sm">
              <Upload className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-serif-spiritual text-lg font-bold text-[#0F382A]">
                Upload Files
              </h3>
              <p className="text-xs text-stone-500">
                Chunked &amp; resumable upload to persistent storage
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={uploading}
            className="text-stone-400 hover:text-stone-700 p-1.5 rounded-lg hover:bg-stone-100 transition disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Alerts */}
        {error && (
          <div className="mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successCount > 0 && (
          <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
            <span>
              {successCount} file{successCount > 1 ? 's' : ''} uploaded and verified successfully!
            </span>
          </div>
        )}

        <div className="mt-4 space-y-4 flex-1 overflow-y-auto">
          {/* Destination Folder Selector */}
          <div>
            <label className="block text-xs font-semibold text-stone-700 mb-1 flex items-center gap-1.5">
              <Folder className="w-3.5 h-3.5 text-emerald-800" />
              <span>Destination Folder</span>
            </label>
            <select
              value={targetSection}
              onChange={(e) => setTargetSection(e.target.value)}
              disabled={uploading}
              className="w-full px-3 py-2 text-xs font-medium rounded-xl border border-stone-300 bg-white focus:outline-none focus:border-emerald-700"
            >
              {uploadableSections.map((sec) => (
                <option key={sec.id} value={sec.id}>
                  {sec.title}
                </option>
              ))}
            </select>
          </div>

          {/* Hidden File Input (broad accept ensures seamless selection on Android and Windows) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="*/*"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Device File Picker Dropzone */}
          <div
            onClick={() => !uploading && fileInputRef.current?.click()}
            className={`border-2 border-dashed border-stone-300 rounded-2xl p-6 text-center bg-stone-50/70 transition ${
              uploading ? 'opacity-60 cursor-not-allowed' : 'hover:border-emerald-700 cursor-pointer hover:bg-stone-50'
            }`}
          >
            <div className="w-12 h-12 rounded-2xl bg-emerald-900/10 text-emerald-800 flex items-center justify-center mx-auto mb-2">
              <Upload className="w-6 h-6" />
            </div>
            <p className="text-xs font-semibold text-stone-800 mb-1">
              Click to browse your device files
            </p>
            <p className="text-[11px] text-stone-500">
              Large Videos, Audio, PDFs, PPTs, Images &amp; Documents (resumable, any size)
            </p>
          </div>

          {/* Selected File Queue */}
          {selectedFiles.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-stone-700">
                  Selected Files ({selectedFiles.length})
                </span>
                {!uploading && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-emerald-800 hover:text-emerald-900 font-semibold flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add More
                  </button>
                )}
              </div>

              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {selectedFiles.map((file, idx) => {
                  const key = fileKey(file);
                  const meta = videoMetaMap[key];
                  const isVid = isVideoFile(file);
                  const isAud = isAudioFile(file);
                  const prog = fileProgressMap[key];
                  const isDone = completedKeys[key] || prog?.phase === 'completed';
                  const hasSavedSession = !uploading && !isDone && Boolean(getSavedResumeSession(targetSection, file));

                  return (
                    <div
                      key={key + '-' + idx}
                      className="p-2.5 rounded-xl border border-stone-200 bg-white space-y-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 truncate flex-1 mr-1">
                          {meta?.thumbnailDataUrl ? (
                            <img
                              src={meta.thumbnailDataUrl}
                              alt={file.name}
                              className="w-12 h-8 rounded-lg object-cover border border-stone-200 flex-shrink-0 bg-stone-900"
                            />
                          ) : isVid ? (
                            <div className="w-12 h-8 rounded-lg bg-stone-900 text-amber-300 flex items-center justify-center flex-shrink-0">
                              <Film className="w-4 h-4" />
                            </div>
                          ) : isAud ? (
                            <div className="w-10 h-8 rounded-lg bg-emerald-900 text-amber-300 flex items-center justify-center flex-shrink-0">
                              <Music className="w-4 h-4" />
                            </div>
                          ) : (
                            <FileText className="w-4 h-4 text-emerald-800 flex-shrink-0" />
                          )}
                          <div className="truncate flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="truncate font-medium text-stone-800">{file.name}</p>
                              {hasSavedSession && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[9px] font-bold flex-shrink-0">
                                  <RotateCcw className="w-2.5 h-2.5" /> Resume
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-stone-400">
                              {formatBytesReadable(file.size)}
                              {meta?.duration ? ` • ${meta.duration}` : ''}
                            </p>
                          </div>
                        </div>

                        {uploading || prog ? (
                          <span className="text-[11px] font-mono text-emerald-800 font-bold flex-shrink-0">
                            {isDone ? '100%' : `${prog?.percentage ?? 0}%`}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => removeFile(idx)}
                            className="text-stone-400 hover:text-rose-600 p-1"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {(prog || isDone) && (
                        <div className="space-y-1">
                          <div className="w-full h-1.5 bg-stone-200 rounded-full overflow-hidden">
                            <div
                              className={`h-1.5 rounded-full transition-all duration-200 ${
                                prog?.phase === 'waiting_network' || prog?.phase === 'paused'
                                  ? 'bg-amber-500'
                                  : isDone
                                    ? 'bg-emerald-600'
                                    : 'bg-[#0F382A]'
                              }`}
                              style={{ width: `${isDone ? 100 : (prog?.percentage ?? 0)}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-stone-500">
                            <span className="truncate pr-2">
                              {prog?.statusText || 'Uploaded'}
                            </span>
                            <span className="font-mono flex-shrink-0">
                              {formatBytesReadable(prog?.uploadedBytes ?? file.size)} / {formatBytesReadable(file.size)}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer Buttons */}
        <div className="pt-4 border-t border-stone-200 flex items-center justify-end gap-2.5 mt-4 flex-wrap">
          {uploading ? (
            <>
              <button
                type="button"
                onClick={handleTogglePauseResume}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber-100 text-amber-950 hover:bg-amber-200 transition flex items-center gap-1.5"
              >
                {isPaused ? (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Resume</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    <span>Pause</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleCancelActiveUpload}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 transition"
              >
                Cancel Upload
              </button>
              <div className="px-4 py-2 rounded-xl text-xs font-bold bg-[#0F382A] text-amber-200 flex items-center gap-2 opacity-90">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{isPaused ? 'Paused' : 'Uploading...'}</span>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-stone-600 hover:bg-stone-100 transition"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleUpload}
                disabled={selectedFiles.length === 0}
                className="px-5 py-2 rounded-xl text-xs font-bold bg-[#0F382A] text-amber-200 hover:bg-[#164E3D] shadow-md transition disabled:opacity-40 disabled:pointer-events-none flex items-center gap-2"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Start Upload</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
