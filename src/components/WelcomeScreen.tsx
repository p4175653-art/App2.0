import React, { useState, useEffect } from 'react';
import { Mail, Lock, Eye, EyeOff, User, AlertCircle, CheckCircle2, ArrowRight, RefreshCw, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useContent } from '../context/ContentContext';

type ScreenMode = 'login' | 'signup' | 'forgot_password';

export const WelcomeScreen: React.FC = () => {
  const { login, loginWithGoogle, register, sendPasswordReset } = useAuth();
  const { settings } = useContent();
  const appName = settings?.appName || 'Angel Class';
  const primaryColor = !settings?.primaryColor || settings.primaryColor === '#0F382A' ? '#0B1F3A' : settings.primaryColor;
  const accentColor = settings?.accentColor || '#D4AF37';

  const [mode, setMode] = useState<ScreenMode>('login');

  // Form Fields
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Status
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Check URL routes (e.g. /admin redirect)
  useEffect(() => {
    const path = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();
    if (path === '/admin' || hash === '#admin') {
      setError('Please log in with administrator credentials to access the Admin Control Center.');
    }
  }, []);

  const clearMessages = () => {
    setError(null);
    setSuccessMsg(null);
  };

  const switchToLogin = () => {
    clearMessages();
    setMode('login');
  };

  const switchToSignUp = () => {
    clearMessages();
    setMode('signup');
  };

  const switchToForgotPassword = () => {
    clearMessages();
    setMode('forgot_password');
  };

  // Handle Login Submit
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();

    if (!identifier.trim() || !password) {
      setError('Please enter your email or phone number and password.');
      return;
    }

    setLoading(true);
    try {
      const res = await login(identifier.trim(), password);
      if (!res.success) {
        setError(res.error || 'Login failed. Please check your credentials.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle Sign Up Submit
  const handleSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();

    if (!name.trim()) {
      setError('Please enter your full name.');
      return;
    }
    if (!identifier.trim()) {
      setError('Please enter your email or phone number.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match. Please verify.');
      return;
    }

    setLoading(true);
    try {
      const res = await register(name.trim(), identifier.trim(), password);
      if (!res.success) {
        setError(res.error || 'Account creation failed.');
      } else {
        setSuccessMsg('Account created successfully! Welcome to Angel Class.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle Google Authentication (Login or Sign Up)
  const handleGoogleAuth = async () => {
    clearMessages();
    setLoading(true);
    try {
      const res = await loginWithGoogle();
      if (!res.success && res.error) {
        setError(res.error);
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle Forgot Password Submit
  const handleForgotPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();

    if (!identifier.trim()) {
      setError('Please enter your registered email address.');
      return;
    }

    setLoading(true);
    try {
      const res = await sendPasswordReset(identifier.trim());
      if (res.success) {
        setSuccessMsg(`If an account exists with "${identifier.trim()}", password reset instructions have been dispatched.`);
      } else {
        setError(res.error || 'Failed to dispatch password reset.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen relative flex flex-col justify-between bg-[#F9F8F4] text-[#0B1F3A] selection:bg-amber-100">
      {/* Header */}
      <header className="relative z-10 w-full max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl overflow-hidden border border-amber-400/40 shadow-sm p-1 flex items-center justify-center"
            style={{ backgroundColor: primaryColor }}
          >
            <img src="/logo.svg" alt={appName} className="w-full h-full object-contain" />
          </div>
          <span
            className="font-serif-spiritual text-base sm:text-lg font-bold tracking-widest uppercase block leading-none"
            style={{ color: primaryColor }}
          >
            {appName === 'Angel Class' ? 'ANGLE CLASS' : appName}
          </span>
        </div>
      </header>

      {/* Main Authentication Container */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 py-8 max-w-md w-full mx-auto">
        {/* Card Container */}
        <div className="w-full bg-white rounded-2xl border border-stone-200 shadow-xl p-6 sm:p-8">
          {/* Card Header with Logo */}
          <div className="text-center mb-6">
            <div
              className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center border border-amber-400/40 shadow-sm"
              style={{ backgroundColor: primaryColor }}
            >
              {mode === 'forgot_password' ? (
                <KeyRound className="w-6 h-6 text-amber-300" />
              ) : (
                <img src="/logo.svg" alt={appName} className="w-7 h-7 object-contain" />
              )}
            </div>
            <h1 className="font-serif-spiritual text-2xl font-bold" style={{ color: primaryColor }}>
              {mode === 'login'
                ? 'Login'
                : mode === 'signup'
                ? 'Sign Up'
                : 'Reset Password'}
            </h1>
            <p className="text-xs text-stone-500 mt-1">
              {mode === 'login'
                ? `Sign in to access your ${appName} dashboard.`
                : mode === 'signup'
                ? `Create your ${appName} account to get started.`
                : 'Enter your email or phone number to recover access.'}
            </p>
          </div>

          {/* Feedback Messages */}
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2 animate-fade-in">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-start gap-2 animate-fade-in">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* 1. LOGIN SCREEN */}
          {mode === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              {/* Email or Phone Number */}
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Email or phone number
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="name@example.com or +1 555-0199"
                    className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:border-[#0B1F3A] focus:ring-1 focus:ring-[#0B1F3A]"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-stone-700">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={switchToForgotPassword}
                    className="text-[11px] text-amber-800 hover:text-amber-900 font-semibold"
                  >
                    Forgot Password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-10 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:border-[#0B1F3A] focus:ring-1 focus:ring-[#0B1F3A]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-3 text-stone-400 hover:text-stone-600"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Login Button */}
              <button
                type="submit"
                disabled={loading}
                style={{ backgroundColor: primaryColor }}
                className="w-full py-3 rounded-xl text-amber-200 font-bold text-sm tracking-wide shadow-md hover:opacity-95 active:scale-[0.99] transition flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 animate-spin text-current" />
                ) : (
                  <>
                    <span>Login</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              {/* Divider */}
              <div className="relative flex items-center justify-center my-3">
                <span className="w-full border-t border-stone-200" />
                <span className="absolute px-2 bg-white text-[11px] text-stone-400 uppercase tracking-wider">
                  or
                </span>
              </div>

              {/* Continue with Google */}
              <button
                type="button"
                onClick={handleGoogleAuth}
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-xl bg-white border border-stone-300 text-stone-700 font-semibold text-xs shadow-sm hover:bg-stone-50 active:scale-[0.99] transition flex items-center justify-center gap-2.5"
              >
                <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                <span>Continue with Google</span>
              </button>

              {/* Link to Sign Up */}
              <div className="text-center pt-2 text-xs text-stone-600">
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={switchToSignUp}
                  className="font-bold text-[#0B1F3A] hover:underline"
                >
                  Sign Up
                </button>
              </div>
            </form>
          )}

          {/* 2. SIGN UP SCREEN */}
          {mode === 'signup' && (
            <form onSubmit={handleSignUpSubmit} className="space-y-3.5">
              {/* Full Name */}
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Full name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="John Doe"
                    className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:border-[#0B1F3A] focus:ring-1 focus:ring-[#0B1F3A]"
                  />
                </div>
              </div>

              {/* Email or Phone Number */}
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Email or phone number
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="name@example.com or +1 555-0199"
                    className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:border-[#0B1F3A] focus:ring-1 focus:ring-[#0B1F3A]"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="w-full pl-9 pr-10 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:border-[#0B1F3A] focus:ring-1 focus:ring-[#0B1F3A]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-3 text-stone-400 hover:text-stone-600"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm Password */}
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Confirm password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your password"
                    className="w-full pl-9 pr-10 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:border-[#0B1F3A] focus:ring-1 focus:ring-[#0B1F3A]"
                  />
                </div>
              </div>

              {/* Create Account Button */}
              <button
                type="submit"
                disabled={loading}
                style={{ backgroundColor: accentColor, color: '#0B1F3A' }}
                className="w-full py-3 rounded-xl font-bold text-sm tracking-wide shadow-md hover:brightness-105 active:scale-[0.99] transition flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 animate-spin text-current" />
                ) : (
                  <>
                    <span>Create Account</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              {/* Divider */}
              <div className="relative flex items-center justify-center my-3">
                <span className="w-full border-t border-stone-200" />
                <span className="absolute px-2 bg-white text-[11px] text-stone-400 uppercase tracking-wider">
                  or
                </span>
              </div>

              {/* Google Sign Up */}
              <button
                type="button"
                onClick={handleGoogleAuth}
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-xl bg-white border border-stone-300 text-stone-700 font-semibold text-xs shadow-sm hover:bg-stone-50 active:scale-[0.99] transition flex items-center justify-center gap-2.5"
              >
                <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                <span>Google Sign Up</span>
              </button>

              {/* Link to Login */}
              <div className="text-center pt-2 text-xs text-stone-600">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={switchToLogin}
                  className="font-bold text-[#0B1F3A] hover:underline"
                >
                  Log In
                </button>
              </div>
            </form>
          )}

          {/* 3. FORGOT PASSWORD SCREEN */}
          {mode === 'forgot_password' && (
            <form onSubmit={handleForgotPasswordSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Registered Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-stone-300 focus:outline-none focus:border-[#0B1F3A] focus:ring-1 focus:ring-[#0B1F3A]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                style={{ backgroundColor: primaryColor }}
                className="w-full py-3 rounded-xl text-amber-200 font-bold text-sm tracking-wide shadow-md hover:opacity-95 transition flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>

              <div className="text-center pt-2 text-xs text-stone-600">
                Remember your password?{' '}
                <button
                  type="button"
                  onClick={switchToLogin}
                  className="font-bold text-[#0B1F3A] hover:underline"
                >
                  Back to Login
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Quick Testing Credentials Assist */}
        <div className="mt-6 w-full max-w-md p-3 rounded-xl bg-stone-100/90 border border-stone-200 text-[11px] text-stone-600 flex flex-wrap items-center justify-between gap-2 shadow-xs">
          <div>
            <strong>Quick Login Credentials:</strong>
            <div className="text-[10px] text-stone-500 mt-0.5">
              Admin: <code className="text-[#0B1F3A] font-semibold">p4175653@gmail.com</code> • User: <code className="text-[#0B1F3A] font-semibold">student@angelclass.org</code>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 ml-auto">
            <button
              type="button"
              onClick={() => {
                switchToLogin();
                setIdentifier('p4175653@gmail.com');
                setPassword('AngelAdmin2026!');
              }}
              className="px-2 py-0.5 rounded bg-[#0B1F3A] text-amber-200 font-semibold text-[10px] hover:bg-[#153560] transition"
            >
              Fill Admin
            </button>
            <button
              type="button"
              onClick={() => {
                switchToLogin();
                setIdentifier('student@angelclass.org');
                setPassword('AngelUser2026!');
              }}
              className="px-2 py-0.5 rounded bg-stone-200 hover:bg-stone-300 text-stone-800 font-medium text-[10px] transition"
            >
              Fill User
            </button>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 w-full max-w-5xl mx-auto px-6 py-4 text-center text-xs text-stone-500 border-t border-stone-200/60">
        <p>{appName} &copy; 2026. Secure Authentication & Authorization.</p>
      </footer>
    </div>
  );
};
