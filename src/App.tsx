import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ContentProvider, useContent } from './context/ContentContext';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Navbar } from './components/Navbar';
import { Dashboard } from './components/Dashboard';
import { AdminDashboard } from './components/AdminDashboard';
import { GeminiAssistantModal } from './components/GeminiAssistantModal';
import { useOnlineStatus } from './hooks/usePWAInstall';
import { ShieldAlert, X, MailCheck, AlertTriangle } from 'lucide-react';

const MainApp: React.FC = () => {
  const { user, isLoading, sendVerificationEmail, reloadUser } = useAuth();
  const { settings } = useContent();
  const isOnline = useOnlineStatus();

  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [isGeminiOpen, setIsGeminiOpen] = useState(false);
  const [geminiContext, setGeminiContext] = useState<{ type: any; data: any } | undefined>(undefined);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);
  const [verifyingStatus, setVerifyingStatus] = useState(false);

  // Sync URL route with Admin Dashboard & enforce strict role-based access
  useEffect(() => {
    const checkRoute = () => {
      const path = window.location.pathname.toLowerCase();
      const hash = window.location.hash.toLowerCase();
      const isAdminRoute = path === '/admin' || hash === '#admin' || path.startsWith('/admin/');

      if (isAdminRoute) {
        if (!user) {
          // Not logged in: keep closed
          setIsAdminOpen(false);
        } else if (user.role === 'admin') {
          // Authorized Administrator
          setIsAdminOpen(true);
        } else {
          // FORBIDDEN: Normal user attempted direct URL access to /admin
          console.warn('[SECURITY VIOLATION] Normal user attempted direct access to /admin route.');
          setIsAdminOpen(false);
          window.history.replaceState(null, '', '/');
          setSecurityNotice(
            `Access Denied: Your account (${user.email}) does not have administrator privileges. Normal users are strictly forbidden from accessing the Admin Control Center.`
          );
        }
      } else {
        setIsAdminOpen(false);
      }
    };

    checkRoute();
    window.addEventListener('popstate', checkRoute);
    window.addEventListener('hashchange', checkRoute);
    return () => {
      window.removeEventListener('popstate', checkRoute);
      window.removeEventListener('hashchange', checkRoute);
    };
  }, [user]);

  const handleOpenAdmin = () => {
    if (user?.role === 'admin') {
      window.history.pushState(null, '', '/admin');
      setIsAdminOpen(true);
    } else {
      setSecurityNotice('Access Denied: Administrator role required to view the Admin Dashboard.');
    }
  };

  const handleCloseAdmin = () => {
    window.history.pushState(null, '', '/');
    setIsAdminOpen(false);
  };

  const openGeminiWithContext = (type: any, data: any) => {
    setGeminiContext({ type, data });
    setIsGeminiOpen(true);
  };

  const openGeneralGemini = () => {
    setGeminiContext(undefined);
    setIsGeminiOpen(true);
  };

  const appName = settings?.appName || 'Angel Class';
  const primaryColor = !settings?.primaryColor || settings.primaryColor === '#0F382A' ? '#0B1F3A' : settings.primaryColor;
  const backgroundColor = !settings?.backgroundColor || settings.backgroundColor === '#FDFBF7' ? '#F9F8F4' : settings.backgroundColor;

  // Splash Loading
  if (isLoading) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center p-6 text-center"
        style={{ backgroundColor }}
      >
        <div
          className="w-24 h-24 rounded-3xl border-2 border-amber-400/50 p-2 shadow-2xl flex items-center justify-center mb-6 animate-pulse"
          style={{ backgroundColor: primaryColor }}
        >
          <img src="/logo.svg" alt={appName} className="w-full h-full object-contain" />
        </div>
        <h2
          className="font-serif-spiritual text-2xl font-bold tracking-wider uppercase"
          style={{ color: primaryColor }}
        >
          {appName}
        </h2>
        <p className="text-xs text-stone-500 mt-2 font-mono">
          Verifying security credentials & session state...
        </p>
      </div>
    );
  }

  // Not logged in -> Show Welcome Screen
  if (!user) {
    return <WelcomeScreen />;
  }

  return (
    <div
      className="min-h-screen text-[#0B1F3A] flex flex-col justify-between selection:bg-amber-200 selection:text-[#0B1F3A]"
      style={{ backgroundColor }}
    >
      {/* Top Navbar */}
      <Navbar
        onOpenAdmin={handleOpenAdmin}
        onOpenGemini={openGeneralGemini}
      />

      {/* Email Verification Banner */}
      {user && user.email && user.emailVerified === false && !user.phoneNumber && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-3 w-full animate-fade-in">
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs flex flex-wrap items-center justify-between gap-2 shadow-sm">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                Your email <strong>{user.email}</strong> is unverified. Please confirm your email to ensure full account recovery and notifications.
              </span>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              {verificationSent ? (
                <span className="flex items-center gap-1 text-emerald-800 font-semibold">
                  <MailCheck className="w-3.5 h-3.5" /> Link Dispatched!
                </span>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    const res = await sendVerificationEmail();
                    if (res.success) setVerificationSent(true);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-amber-200 hover:bg-amber-300 text-amber-950 font-semibold transition"
                >
                  Resend Verification Email
                </button>
              )}
              <button
                type="button"
                disabled={verifyingStatus}
                onClick={async () => {
                  setVerifyingStatus(true);
                  await reloadUser();
                  setVerifyingStatus(false);
                }}
                className="px-2.5 py-1 rounded-lg bg-white border border-amber-300 hover:bg-stone-50 text-stone-700 font-medium transition disabled:opacity-50"
              >
                {verifyingStatus ? 'Checking...' : 'Check Status'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Security Notice Banner for Forbidden Direct URL Access */}
      {securityNotice && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-4 w-full animate-fade-in">
          <div className="p-4 rounded-2xl bg-rose-900 border border-rose-500/60 text-white shadow-xl flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-rose-950/80 border border-rose-500 text-rose-300 shrink-0">
                <ShieldAlert className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-rose-100 flex items-center gap-1.5">
                  Security Warning: Unauthorized Route Access Blocked
                </h4>
                <p className="text-xs text-rose-200/90 mt-1 leading-relaxed">
                  {securityNotice}
                </p>
              </div>
            </div>
            <button
              onClick={() => setSecurityNotice(null)}
              className="text-rose-300 hover:text-white p-1 rounded-lg transition"
              title="Dismiss warning"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <Dashboard
          onOpenGemini={openGeneralGemini}
          onOpenGeminiWithContext={openGeminiWithContext}
          onOpenAdminPortal={handleOpenAdmin}
        />
      </main>

      {/* Global Offline Status Indicator Toast */}
      {!isOnline && (
        <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white shadow-xl animate-bounce">
          <span className="h-2 w-2 rounded-full bg-white animate-ping" />
          <span>Offline Mode Active • Using Cached Curriculum</span>
        </div>
      )}

      {/* Floating Gemini AI Quick Launch Button */}
      <button
        onClick={openGeneralGemini}
        className="fixed bottom-6 right-6 z-40 p-3.5 rounded-full bg-gradient-to-r from-amber-500 to-amber-600 text-[#0B1F3A] shadow-2xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center border-2 border-amber-300"
        title="Consult Gemini Learning Mentor"
      >
        <span className="text-lg">✦</span>
      </button>

      {/* Admin Dashboard Modal (Only rendered when user.role is strictly admin) */}
      {isAdminOpen && user.role === 'admin' && (
        <AdminDashboard onClose={handleCloseAdmin} />
      )}

      {/* Gemini AI Assistant Modal */}
      <GeminiAssistantModal
        isOpen={isGeminiOpen}
        onClose={() => setIsGeminiOpen(false)}
        initialContext={geminiContext}
      />

      {/* Footer */}
      <footer className="w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 text-center text-xs text-stone-500 border-t border-stone-200/80">
        <p>
          {appName} &copy; 2026 • Dedicated to Sacred Spiritual Wisdom and Fellowship.
        </p>
      </footer>
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <ContentProvider>
        <MainApp />
      </ContentProvider>
    </AuthProvider>
  );
}
