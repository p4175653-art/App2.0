export interface VideoMetadataResult {
  thumbnailDataUrl?: string;
  duration?: string;
}

export interface AudioMetadataResult {
  duration?: string;
}

export function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00';
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const mins = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function parseDurationToSeconds(dur?: string): number {
  if (!dur || typeof dur !== 'string') return 0;
  const trimmed = dur.trim();
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(trimmed)) return 0;
  const parts = trimmed.split(':').map(Number);
  if (parts.some((n) => isNaN(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export function isVideoFile(file: { name?: string; type?: string }): boolean {
  const mime = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return (
    mime.startsWith('video/') ||
    /\.(mp4|webm|mov|m4v|3gp|mkv)$/i.test(name)
  );
}

export function isAudioFile(file: { name?: string; type?: string }): boolean {
  const mime = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return (
    mime.startsWith('audio/') ||
    /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name)
  );
}

export function extractYouTubeVideoId(rawUrl?: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
      if (parsed.pathname.startsWith('/embed/')) {
        return parsed.pathname.split('/embed/')[1]?.split(/[?&/]/)[0] || null;
      }
      if (parsed.pathname.startsWith('/shorts/')) {
        return parsed.pathname.split('/shorts/')[1]?.split(/[?&/]/)[0] || null;
      }
      if (parsed.pathname.startsWith('/live/')) {
        return parsed.pathname.split('/live/')[1]?.split(/[?&/]/)[0] || null;
      }
      return parsed.searchParams.get('v');
    }
    if (host.includes('youtu.be')) {
      return parsed.pathname.replace(/^\//, '').split(/[?&/]/)[0] || null;
    }
  } catch {
    if (rawUrl.includes('youtu.be/')) {
      return rawUrl.split('youtu.be/')[1]?.split(/[?&/]/)[0] || null;
    }
    if (rawUrl.includes('watch?v=')) {
      return rawUrl.split('watch?v=')[1]?.split(/[?&/]/)[0] || null;
    }
  }
  return null;
}

export function getYouTubeThumbnailUrl(rawUrl?: string): string | null {
  const id = extractYouTubeVideoId(rawUrl);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

export function extractAudioMetadata(file: File): Promise<AudioMetadataResult> {
  if (!isAudioFile(file)) {
    return Promise.resolve({});
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    let settled = false;

    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.ondurationchange = null;
      audio.onerror = null;
      try {
        audio.removeAttribute('src');
        audio.load();
      } catch {}
      URL.revokeObjectURL(objectUrl);
    };

    const finish = (result: AudioMetadataResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      const dur = Number.isFinite(audio.duration) && audio.duration > 0
        ? formatDurationSeconds(audio.duration)
        : undefined;
      finish({ duration: dur });
    }, 4000);

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finish({ duration: formatDurationSeconds(audio.duration) });
      }
    };
    audio.ondurationchange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finish({ duration: formatDurationSeconds(audio.duration) });
      }
    };
    audio.onerror = () => finish({});
    audio.src = objectUrl;
  });
}

export function extractVideoMetadata(file: File): Promise<VideoMetadataResult> {
  if (!isVideoFile(file)) {
    return Promise.resolve({});
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        // ignore cleanup errors
      }
      URL.revokeObjectURL(objectUrl);
    };

    const finish = (result: VideoMetadataResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    };

    const captureFrame = (): string | undefined => {
      try {
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 360;
        if (vw === 0 || vh === 0) return undefined;
        const maxWidth = 640;
        const scale = vw > maxWidth ? maxWidth / vw : 1;
        const width = Math.max(1, Math.round(vw * scale));
        const height = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;
        ctx.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
        return dataUrl && dataUrl.startsWith('data:image/') ? dataUrl : undefined;
      } catch {
        return undefined;
      }
    };

    const timeoutId = setTimeout(() => {
      const durationStr = Number.isFinite(video.duration) && video.duration > 0
        ? formatDurationSeconds(video.duration)
        : undefined;
      const thumb = captureFrame();
      finish({ thumbnailDataUrl: thumb, duration: durationStr });
    }, 5000);

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    video.onloadedmetadata = () => {
      const dur = video.duration;
      const targetTime = Number.isFinite(dur) && dur > 0.2
        ? Math.min(1.0, Math.max(0.1, dur * 0.15))
        : 0;
      try {
        if (targetTime > 0) {
          video.currentTime = targetTime;
        }
      } catch {
        // Ignore seek error, loadeddata will still capture frame 0
      }
    };

    video.onseeked = () => {
      const durationStr = Number.isFinite(video.duration) && video.duration > 0
        ? formatDurationSeconds(video.duration)
        : undefined;
      const thumb = captureFrame();
      if (thumb) {
        finish({ thumbnailDataUrl: thumb, duration: durationStr });
      }
    };

    video.onloadeddata = () => {
      // Fallback if onseeked does not fire (e.g. seek target was 0)
      setTimeout(() => {
        if (!settled) {
          const durationStr = Number.isFinite(video.duration) && video.duration > 0
            ? formatDurationSeconds(video.duration)
            : undefined;
          const thumb = captureFrame();
          if (thumb || durationStr) {
            finish({ thumbnailDataUrl: thumb, duration: durationStr });
          }
        }
      }, 300);
    };

    video.onerror = () => {
      finish({});
    };

    video.src = objectUrl;
  });
}
