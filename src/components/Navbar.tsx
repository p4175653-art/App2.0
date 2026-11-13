import React from 'react';
import { Shield, Sparkles, LogOut, Wifi, WifiOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useContent } from '../context/ContentContext';
import { useOnlineStatus } from '../hooks/usePWAInstall';

interface NavbarProps {
  onOpenAdmin: () => void;
  onOpenGemini: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenAdmin, onOpenGemini }) => {
  const { user, logout } = useAuth();
  const { settings } = useContent();
  const isOnline = useOnlineStatus();

  const appName = settings?.appName || 'Angel Class';
  const displayBrand = appName === 'Angel Class' ? 'ANGLE CLASS' : appName;
  const subtitle = settings?.subtitle || 'Spiritual Education & Discipleship';
  const primaryColor = !settings?.primaryColor || settings.primaryColor === '#0F382A' ? '#0B1F3A' : settings.primaryColor;
  const accentColor = settings?.accentColor || '#D4AF37';
  const roleLabel = user?.role === 'admin' ? 'ADMIN' : 'USER';

  return (
    <header
      className="sticky top-0 z-40 text-[#FDFBF7] border-b shadow-md"
      style={{ backgroundColor: primaryColor, borderColor: `${accentColor}4D` }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl overflow-hidden border border-amber-400/50 bg-[#08172E] p-1 flex items-center justify-center shadow-inner">
            <img src="/logo.svg" alt={appName} className="w-full h-full object-contain" />
          </div>
          <div>
            <span
              className="font-serif-spiritual text-base sm:text-lg font-bold tracking-widest uppercase block leading-tight"
              style={{ color: accentColor }}
            >
              {displayBrand}
            </span>
            <p className="text-[10px] text-slate-300/80 hidden sm:block">
              {subtitle}
            </p>
          </div>
        </div>

        {/* Right Tools & Profile */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Online / Offline status */}
          <div
            className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
              isOnline
                ? 'bg-[#08172E]/70 border-slate-600/60 text-slate-200'
                : 'bg-amber-950/70 border-amber-500/60 text-amber-200 animate-pulse'
            }`}
            title={isOnline ? `Connected to ${appName} Cloud` : 'Offline mode active - using cached content'}
          >
            {isOnline ? <Wifi className="w-3.5 h-3.5 text-amber-300" /> : <WifiOff className="w-3.5 h-3.5 text-amber-400" />}
            <span>{isOnline ? 'Connected' : 'Offline Mode'}</span>
          </div>

          {/* Gemini AI Trigger */}
          <button
            onClick={onOpenGemini}
            className="px-3 py-1.5 rounded-full text-[#0B1F3A] font-bold text-xs tracking-wide shadow hover:brightness-110 active:scale-95 transition flex items-center gap-1.5"
            style={{ backgroundColor: accentColor }}
            title="Private Gemini Spiritual Assistant"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#0B1F3A]" />
            <span className="hidden sm:inline">AI Mentor</span>
          </button>

          {/* Admin Portal Toggle (Only visible if role is admin) */}
          {user?.role === 'admin' && (
            <button
              onClick={onOpenAdmin}
              className="px-3 py-1.5 rounded-full bg-amber-400/15 hover:bg-amber-400/25 text-amber-200 border border-amber-400/50 text-xs font-semibold flex items-center gap-1.5 transition"
              title="Administrator Control Center"
            >
              <Shield className="w-3.5 h-3.5 text-amber-300" />
              <span className="hidden sm:inline">Admin Console</span>
            </button>
          )}

          {/* User Profile & Logout */}
          <div className="flex items-center gap-2 pl-2 border-l border-slate-600/50">
            <div className="text-right hidden lg:block">
              <p className="text-xs font-semibold text-amber-100 line-clamp-1">{user?.name}</p>
              <p className="text-[10px] text-amber-200/80 font-mono font-bold">
                {roleLabel}
              </p>
            </div>

            <button
              onClick={() => logout()}
              className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-white/10 transition"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
