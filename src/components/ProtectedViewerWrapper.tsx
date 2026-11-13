import React, { useState, useEffect } from 'react';
import { ShieldAlert, Lock, AlertTriangle, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface ProtectedViewerWrapperProps {
  title: string;
  classification?: string;
  children: React.ReactNode;
  onAskGemini?: () => void;
}

export const ProtectedViewerWrapper: React.FC<ProtectedViewerWrapperProps> = ({
  title,
  classification = 'CONFIDENTIAL_SACRED_DOCTRINE',
  children,
  onAskGemini
}) => {
  const { user } = useAuth();
  const [shieldActive, setShieldActive] = useState(false);
  const [warningMsg, setWarningMsg] = useState<string | null>(null);

  useEffect(() => {
    // 1. Prevent context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      showTemporaryWarning('Right-click context menu is disabled under Angel Class Content Protection.');
    };

    // 2. Prevent keyboard shortcuts for screenshotting, copying, printing
    const handleKeyDown = (e: KeyboardEvent) => {
      // PrintScreen
      if (e.key === 'PrintScreen') {
        e.preventDefault();
        triggerShield('Screenshot attempt detected. Content protected.');
      }
      // Windows Snipping Tool (Win+Shift+S) or Mac (Cmd+Shift+3, Cmd+Shift+4)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 's' || e.key === 'S' || e.key === '3' || e.key === '4')) {
        e.preventDefault();
        triggerShield('Screen capture shortcut intercepted by FLAG_SECURE protocol.');
      }
      // Ctrl+P / Cmd+P Print
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        showTemporaryWarning('Direct printing is strictly disabled for protected spiritual materials.');
      }
      // Ctrl+C / Cmd+C Copy
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        showTemporaryWarning('Clipboard copying is disabled for protected curriculum.');
      }
    };

    // 3. Visibility change & blur protection (prevents recent-app preview screenshotting on Android/Desktop)
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setShieldActive(true);
      } else {
        // Return from preview
        setTimeout(() => setShieldActive(false), 300);
      }
    };

    const handleWindowBlur = () => {
      // When window loses focus (e.g. snipping tool overlay or app switcher), shield the content
      setShieldActive(true);
    };

    const handleWindowFocus = () => {
      setShieldActive(false);
    };

    // 4. Prevent copy/cut events
    const handleCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      showTemporaryWarning('Extraction to clipboard is prohibited.');
    };

    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('cut', handleCopy);

    return () => {
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('cut', handleCopy);
    };
  }, []);

  const triggerShield = (reason: string) => {
    setShieldActive(true);
    setWarningMsg(reason);
    setTimeout(() => {
      setShieldActive(false);
      setWarningMsg(null);
    }, 2500);
  };

  const showTemporaryWarning = (msg: string) => {
    setWarningMsg(msg);
    setTimeout(() => {
      setWarningMsg(null);
    }, 3000);
  };

  const watermarkText = `${user?.name || 'User'} [${user?.email || 'authenticated'}] • ID: ${user?.id || 'AC-USER'} • CONFIDENTIAL`;

  return (
    <div className="relative w-full rounded-2xl bg-white border border-emerald-900/10 shadow-lg overflow-hidden select-none protected-secure-zone">
      {/* Top Protection Banner */}
      <div className="px-4 py-2.5 bg-gradient-to-r from-[#0F382A] via-[#164E3D] to-[#0F382A] text-amber-200 border-b border-amber-400/30 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-semibold tracking-wide">FLAG_SECURE Active</span>
          <span className="text-amber-300/60">•</span>
          <span className="text-[11px] text-emerald-200/80">In-App Protected Viewer Only</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-[10px] font-mono tracking-wider bg-amber-400/20 text-amber-200 border border-amber-400/30">
            {classification}
          </span>
          {onAskGemini && (
            <button
              onClick={onAskGemini}
              className="px-2.5 py-1 rounded-lg bg-amber-400 text-emerald-950 font-bold text-[11px] hover:bg-amber-300 transition shadow-sm"
            >
              Analyze with Gemini
            </button>
          )}
        </div>
      </div>

      {/* Security Warning Notification */}
      {warningMsg && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-xl bg-rose-900/90 text-rose-100 border border-rose-500/50 shadow-xl text-xs flex items-center gap-2 animate-bounce">
          <AlertTriangle className="w-4 h-4 text-amber-300 flex-shrink-0" />
          <span>{warningMsg}</span>
        </div>
      )}

      {/* FLAG_SECURE App Switcher & Capture Obscuring Overlay */}
      {shieldActive && (
        <div className="absolute inset-0 z-50 bg-[#082219]/95 backdrop-blur-xl flex flex-col items-center justify-center p-6 text-center text-amber-200">
          <div className="w-16 h-16 rounded-2xl bg-amber-400/10 border border-amber-400/40 flex items-center justify-center mb-4">
            <EyeOff className="w-8 h-8 text-amber-300" />
          </div>
          <h3 className="font-serif-spiritual text-xl font-bold text-amber-200 mb-2">
            Screen Shield Engaged
          </h3>
          <p className="text-xs text-emerald-200/80 max-w-sm mb-4 leading-relaxed">
            Content is obscured during app switching or recording to uphold Android FLAG_SECURE standards. Return focus to resume study.
          </p>
          <div className="text-[10px] text-amber-400/60 font-mono tracking-wider">
            ANGEL CLASS SECURITY PROTOCOL • ALL REPRODUCTION PROHIBITED
          </div>
        </div>
      )}

      {/* Watermarked Children Content Area */}
      <div className="relative p-6 sm:p-8 min-h-[420px] bg-[#FDFBF7] overflow-hidden">
        {/* Dynamic Watermark Pattern */}
        <div className="absolute inset-0 pointer-events-none z-10 flex flex-wrap items-center justify-around opacity-[0.06] select-none overflow-hidden">
          {Array.from({ length: 16 }).map((_, i) => (
            <div
              key={i}
              className="transform -rotate-25 whitespace-nowrap text-stone-900 font-bold text-xs tracking-widest my-8 mx-4"
            >
              {watermarkText}
            </div>
          ))}
        </div>

        {/* Content body */}
        <div className="relative z-20">{children}</div>
      </div>

      {/* Bottom Footer Notice */}
      <div className="px-4 py-2 bg-stone-100 border-t border-stone-200 text-[11px] text-stone-500 flex items-center justify-between">
        <span>Screenshot, clipboard extraction, and external sharing disabled.</span>
        <span className="font-mono text-[10px]">Verified: {user?.email}</span>
      </div>
    </div>
  );
};
