import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2, VolumeX, Loader2, RotateCw, Music } from 'lucide-react';
import { formatDurationSeconds, parseDurationToSeconds } from '../utils/videoThumbnail';

interface AudioPlayerProps {
  src: string;
  title?: string;
  fallbackDuration?: string;
  onRefreshSession?: () => Promise<boolean>;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  src,
  title,
  fallbackDuration,
  onRefreshSession
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(() => parseDurationToSeconds(fallbackDuration));
  const [isMuted, setIsMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(parseDurationToSeconds(fallbackDuration));
    setIsLoading(true);
    setErrorMsg(null);
  }, [src, fallbackDuration, retryCount]);

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setIsLoading(false);
    setErrorMsg(null);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    } else if (audio.duration === Infinity) {
      // Handle VBR MP3 / chunked audio streams that report Infinity until seeked
      const fixInfinity = () => {
        if (!audioRef.current) return;
        audioRef.current.removeEventListener('timeupdate', fixInfinity);
        if (Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
          setDuration(audioRef.current.duration);
        }
        audioRef.current.currentTime = 0;
      };
      audio.addEventListener('timeupdate', fixInfinity);
      try {
        audio.currentTime = 1e101;
      } catch {
        audio.removeEventListener('timeupdate', fixInfinity);
      }
    }
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      try {
        setErrorMsg(null);
        await audio.play();
        setIsPlaying(true);
      } catch (err: any) {
        setIsPlaying(false);
        setErrorMsg(err?.message || 'Unable to start audio playback.');
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = parseFloat(e.target.value);
    const audio = audioRef.current;
    if (!audio || isNaN(targetTime)) return;
    audio.currentTime = targetTime;
    setCurrentTime(targetTime);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div className="p-4 rounded-2xl bg-gradient-to-br from-[#0F382A] to-[#164E3D] text-amber-100 border border-amber-400/30 shadow-md space-y-3">
      <audio
        key={`${src}-${retryCount}`}
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadStart={() => setIsLoading(true)}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={() => {
          const d = audioRef.current?.duration;
          if (d && Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onCanPlay={() => {
          setIsLoading(false);
          setErrorMsg(null);
        }}
        onTimeUpdate={() => {
          const audio = audioRef.current;
          if (!audio) return;
          setCurrentTime(audio.currentTime || 0);
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setDuration(audio.duration);
          }
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
        onError={() => {
          setIsLoading(false);
          setIsPlaying(false);
          setErrorMsg('Unable to load audio stream. Check connection or tap Retry.');
        }}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center shrink-0">
            <Music className="w-4 h-4 text-amber-300" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-200 truncate">
              {title || 'Audio Track'}
            </p>
            <p className="text-[10px] text-emerald-200/80 font-mono">
              {formatDurationSeconds(currentTime)} / {duration > 0 ? formatDurationSeconds(duration) : (fallbackDuration && /^\d/.test(fallbackDuration) ? fallbackDuration : '0:00')}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={toggleMute}
          className="p-2 rounded-lg bg-emerald-950/60 hover:bg-emerald-950 text-amber-200 transition"
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="w-10 h-10 rounded-full bg-amber-400 hover:bg-amber-300 text-emerald-950 flex items-center justify-center shadow transition shrink-0"
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isLoading && !duration ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isPlaying ? (
            <Pause className="w-4 h-4 fill-current" />
          ) : (
            <Play className="w-4 h-4 fill-current ml-0.5" />
          )}
        </button>

        <div className="flex-1 flex flex-col gap-1">
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 100}
            step={0.1}
            value={duration > 0 ? Math.min(currentTime, duration) : 0}
            disabled={duration <= 0}
            onChange={handleSeek}
            aria-label="Seek audio position"
            className="w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-amber-400 bg-emerald-950/80"
            style={{
              background: `linear-gradient(to right, #fbbf24 ${progressPct}%, rgba(2, 44, 34, 0.8) ${progressPct}%)`
            }}
          />
          <div className="flex items-center justify-between text-[10px] font-mono text-emerald-200/80">
            <span>{formatDurationSeconds(currentTime)}</span>
            <span>{duration > 0 ? formatDurationSeconds(duration) : (fallbackDuration && /^\d/.test(fallbackDuration) ? fallbackDuration : '0:00')}</span>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="p-2.5 rounded-xl bg-rose-950/80 border border-rose-500/40 text-rose-100 text-xs flex flex-wrap items-center justify-between gap-2">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={async () => {
              if (onRefreshSession) await onRefreshSession();
              setRetryCount((c) => c + 1);
            }}
            className="px-2.5 py-1 rounded-lg bg-amber-400 text-emerald-950 font-bold inline-flex items-center gap-1 hover:bg-amber-300"
          >
            <RotateCw className="w-3 h-3" />
            <span>Retry</span>
          </button>
        </div>
      )}
    </div>
  );
};
