import React, { createContext, useContext, useState, useEffect } from 'react';
import { User, UserRole } from '../types';
import { 
  auth, 
  db, 
  googleProvider,
  signInWithPopup, 
  signOut as fbSignOut, 
  onAuthStateChanged, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  updateProfile,
  FirebaseUser
} from '../firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  firebaseUser: FirebaseUser | null;
  login: (identifier: string, password: string, requiredRole?: UserRole) => Promise<{ success: boolean; error?: string }>;
  loginWithGoogle: () => Promise<{ success: boolean; error?: string }>;
  register: (name: string, identifier: string, password: string) => Promise<{ success: boolean; error?: string }>;
  sendVerificationEmail: () => Promise<{ success: boolean; error?: string }>;
  sendPasswordReset: (identifier: string) => Promise<{ success: boolean; error?: string }>;
  reloadUser: () => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_KEY_TOKEN = 'angel_class_token';
const STORAGE_KEY_USER = 'angel_class_user';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_USER);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEY_TOKEN);
  });

  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Synchronize Firebase Auth state with Firestore and backend session
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        try {
          const uid = fbUser.uid;
          const email = fbUser.email || '';
          const name = fbUser.displayName || 'User';
          const isDesignatedAdmin = email.toLowerCase() === 'p4175653@gmail.com' || email.toLowerCase() === 'admin@angelclass.org';
          let role: UserRole = isDesignatedAdmin ? 'admin' : 'user';

          // Query Firestore profile
          try {
            const userDocRef = doc(db, 'users', uid);
            const userSnap = await getDoc(userDocRef);
            if (userSnap.exists()) {
              const data = userSnap.data();
              role = data.role === 'admin' ? 'admin' : role;
            }
          } catch (fsErr) {
            console.warn('Firestore user fetch notice:', fsErr);
          }

          // Sync with backend to ensure signed HMAC session token
          try {
            const syncRes = await fetch('/api/auth/firebase-sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                uid,
                email,
                name,
                phoneNumber: fbUser.phoneNumber || undefined,
                emailVerified: fbUser.emailVerified
              })
            });

            if (syncRes.ok) {
              const syncData = await syncRes.json();
              if (syncData.token) {
                setToken(syncData.token);
                localStorage.setItem(STORAGE_KEY_TOKEN, syncData.token);
              }
              const syncedUser: User = {
                ...syncData.user,
                emailVerified: fbUser.emailVerified
              };
              setUser(syncedUser);
              localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(syncedUser));
              setIsLoading(false);
              return;
            }
          } catch (syncErr) {
            console.warn('Backend sync notice:', syncErr);
          }

          // Fallback if backend sync had network issue
          const fallbackUser: User = {
            id: uid,
            email,
            name,
            phoneNumber: fbUser.phoneNumber || undefined,
            emailVerified: fbUser.emailVerified,
            role,
            status: 'active',
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString(),
            lastLoginAt: new Date().toISOString()
          };

          setUser(fallbackUser);
          localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(fallbackUser));
        } catch (err) {
          console.warn('Firebase state sync notice:', err);
        }
      }
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const syncFirebaseUserWithBackend = async (fbUser: FirebaseUser): Promise<boolean> => {
    try {
      const syncRes = await fetch('/api/auth/firebase-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: fbUser.uid,
          email: fbUser.email || '',
          name: fbUser.displayName || 'User',
          phoneNumber: fbUser.phoneNumber || undefined,
          emailVerified: fbUser.emailVerified
        })
      });

      if (syncRes.ok) {
        const syncData = await syncRes.json();
        if (syncData.token) {
          setToken(syncData.token);
          localStorage.setItem(STORAGE_KEY_TOKEN, syncData.token);
        }
        const syncedUser: User = {
          ...syncData.user,
          emailVerified: fbUser.emailVerified
        };
        setUser(syncedUser);
        localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(syncedUser));
        return true;
      }
    } catch (err) {
      console.warn('Backend token sync notice:', err);
    }
    return false;
  };

  // Validate backend session on app launch and keep HMAC media/API token fresh
  const checkSession = async (): Promise<boolean> => {
    const currentToken = localStorage.getItem(STORAGE_KEY_TOKEN);

    if (auth.currentUser) {
      if (!currentToken) {
        const synced = await syncFirebaseUserWithBackend(auth.currentUser);
        setIsLoading(false);
        return synced || !!user;
      }

      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${currentToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          setToken(currentToken);
          const refreshedUser: User = {
            ...data.user,
            emailVerified: auth.currentUser.emailVerified
          };
          setUser(refreshedUser);
          localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(refreshedUser));
          setIsLoading(false);
          return true;
        }
        // Token expired or invalid on server; immediately re-sync fresh backend token
        const resynced = await syncFirebaseUserWithBackend(auth.currentUser);
        setIsLoading(false);
        return resynced;
      } catch {
        setIsLoading(false);
        return !!user;
      }
    }

    if (!currentToken) {
      setUser(null);
      setToken(null);
      setIsLoading(false);
      return false;
    }

    try {
      const res = await fetch('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${currentToken}`
        }
      });

      if (!res.ok) {
        localStorage.removeItem(STORAGE_KEY_TOKEN);
        localStorage.removeItem(STORAGE_KEY_USER);
        setUser(null);
        setToken(null);
        setIsLoading(false);
        return false;
      }

      const data = await res.json();
      setToken(currentToken);
      setUser(data.user);
      localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(data.user));
      setIsLoading(false);
      return true;
    } catch {
      if (!navigator.onLine) {
        setIsLoading(false);
        return !!user;
      }
      localStorage.removeItem(STORAGE_KEY_TOKEN);
      localStorage.removeItem(STORAGE_KEY_USER);
      setUser(null);
      setToken(null);
      setIsLoading(false);
      return false;
    }
  };

  useEffect(() => {
    checkSession();

    const handleFocus = () => {
      checkSession();
    };
    window.addEventListener('focus', handleFocus);

    const interval = setInterval(() => {
      checkSession();
    }, 5 * 60 * 1000);

    return () => {
      window.removeEventListener('focus', handleFocus);
      clearInterval(interval);
    };
  }, []);

  // Reload current Firebase user state (e.g. after verifying email)
  const reloadUser = async () => {
    if (auth.currentUser) {
      await auth.currentUser.reload();
      const updated = auth.currentUser;
      setFirebaseUser(updated);
      if (user) {
        const refreshed = { ...user, emailVerified: updated.emailVerified };
        setUser(refreshed);
        localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(refreshed));
      }
    }
  };

  // Google Sign-In with Firebase Auth
  const loginWithGoogle = async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const fbUser = result.user;
      const uid = fbUser.uid;
      const email = fbUser.email || '';
      const name = fbUser.displayName || 'User';
      const isDesignatedAdmin = email.toLowerCase() === 'p4175653@gmail.com' || email.toLowerCase() === 'admin@angelclass.org';

      let role: UserRole = isDesignatedAdmin ? 'admin' : 'user';

      try {
        const userDocRef = doc(db, 'users', uid);
        const userSnap = await getDoc(userDocRef);

        if (userSnap.exists()) {
          const existingData = userSnap.data();
          role = existingData.role === 'admin' ? 'admin' : role;
          await setDoc(userDocRef, {
            ...existingData,
            lastLoginAt: new Date().toISOString()
          }, { merge: true });
        } else {
          await setDoc(userDocRef, {
            uid,
            name,
            email,
            role,
            status: 'active',
            createdAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString()
          });
        }

        if (role === 'admin') {
          await setDoc(doc(db, 'admins', uid), {
            uid,
            email,
            grantedAt: new Date().toISOString(),
            grantedBy: 'system'
          }, { merge: true });
        }
      } catch (fsErr) {
        console.warn('Firestore profile sync notice:', fsErr);
      }

      // Synchronize with backend to acquire signed HMAC-SHA256 session token
      const syncRes = await fetch('/api/auth/firebase-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid,
          email,
          name,
          emailVerified: fbUser.emailVerified
        })
      });

      if (syncRes.ok) {
        const syncData = await syncRes.json();
        setToken(syncData.token);
        localStorage.setItem(STORAGE_KEY_TOKEN, syncData.token);
        const fullUser: User = {
          ...syncData.user,
          emailVerified: fbUser.emailVerified
        };
        setUser(fullUser);
        localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(fullUser));
      } else {
        const appUser: User = {
          id: uid,
          email,
          name,
          role,
          status: 'active',
          emailVerified: fbUser.emailVerified,
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
          lastLoginAt: new Date().toISOString()
        };
        setUser(appUser);
        localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(appUser));
      }

      return { success: true };
    } catch (err: any) {
      console.error('Firebase Google sign-in failed:', err);
      return { success: false, error: err.message || 'Google authentication failed.' };
    }
  };

  // Dispatch Email Verification link
  const sendVerificationEmail = async (): Promise<{ success: boolean; error?: string }> => {
    if (!auth.currentUser) {
      return { success: false, error: 'No authenticated Firebase user found.' };
    }
    try {
      await sendEmailVerification(auth.currentUser);
      return { success: true };
    } catch (err: any) {
      console.error('Send verification email error:', err);
      let errorMsg = 'Failed to dispatch verification email.';
      if (err.code === 'auth/too-many-requests') {
        errorMsg = 'Too many requests. Please wait a few minutes before resending.';
      }
      return { success: false, error: errorMsg };
    }
  };

  // Dispatch Password Reset link
  const sendPasswordReset = async (identifier: string): Promise<{ success: boolean; error?: string }> => {
    const cleanId = identifier.trim().toLowerCase();
    try {
      let fbSuccess = false;
      if (cleanId.includes('@')) {
        try {
          await sendPasswordResetEmail(auth, cleanId);
          fbSuccess = true;
        } catch (fbErr: any) {
          console.info('Firebase password reset notice:', fbErr?.message);
        }
      }

      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanId })
      });

      return { 
        success: true, 
        error: fbSuccess ? undefined : 'Password recovery instructions have been recorded and dispatched.' 
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to dispatch password reset.' };
    }
  };

  // Login with Email or Phone Number + Password
  const login = async (identifier: string, password: string, requiredRole?: UserRole): Promise<{ success: boolean; error?: string }> => {
    const cleanId = identifier.trim();
    const isEmail = cleanId.includes('@');

    // 1. If it's an email, attempt Firebase Authentication first
    if (isEmail) {
      try {
        const cleanEmail = cleanId.toLowerCase();
        const fbCred = await signInWithEmailAndPassword(auth, cleanEmail, password);
        const fbUser = fbCred.user;
        const isDesignatedAdmin = cleanEmail === 'p4175653@gmail.com' || cleanEmail === 'admin@angelclass.org';
        let role: UserRole = isDesignatedAdmin ? 'admin' : 'user';

        // Read Firestore role
        try {
          const userDoc = await getDoc(doc(db, 'users', fbUser.uid));
          if (userDoc.exists()) {
            role = userDoc.data().role === 'admin' ? 'admin' : role;
          }
        } catch {}

        if (requiredRole && role !== requiredRole) {
          await fbSignOut(auth);
          return {
            success: false,
            error: requiredRole === 'admin'
              ? 'Access denied: Administrator credentials required.'
              : 'Please log in via the standard login screen.'
          };
        }

        // Sync backend session
        const syncRes = await fetch('/api/auth/firebase-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid: fbUser.uid,
            email: fbUser.email,
            name: fbUser.displayName || 'User',
            emailVerified: fbUser.emailVerified
          })
        });

        if (syncRes.ok) {
          const syncData = await syncRes.json();
          setToken(syncData.token);
          localStorage.setItem(STORAGE_KEY_TOKEN, syncData.token);
          const fullUser: User = {
            ...syncData.user,
            emailVerified: fbUser.emailVerified
          };
          setUser(fullUser);
          localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(fullUser));
          return { success: true };
        }
      } catch (fbErr: any) {
        console.info('Firebase login fallback to backend store:', fbErr?.code || fbErr?.message);
      }
    }

    // 2. Authenticate against backend database (supports email, phone numbers, and pre-seeded accounts)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: cleanId, password, requiredRole })
      });

      const data = await res.json();

      if (!res.ok) {
        return { success: false, error: data.error || 'Authentication failed. Please verify credentials.' };
      }

      setToken(data.token);
      setUser(data.user);
      localStorage.setItem(STORAGE_KEY_TOKEN, data.token);
      localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(data.user));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: 'Network error or service unavailable: ' + err.message };
    }
  };

  // Sign Up with Name, Email or Phone Number, and Password
  const register = async (name: string, identifier: string, password: string): Promise<{ success: boolean; error?: string }> => {
    const cleanId = identifier.trim();
    const cleanName = name.trim();
    const isEmail = cleanId.includes('@');

    try {
      let fbUser: FirebaseUser | null = null;

      // If it's an email, also register in Firebase Auth
      if (isEmail) {
        const cleanEmail = cleanId.toLowerCase();
        try {
          const userCred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
          fbUser = userCred.user;
          await updateProfile(fbUser, { displayName: cleanName });

          try {
            await sendEmailVerification(fbUser);
          } catch (evErr) {
            console.warn('Initial verification email notice:', evErr);
          }

          try {
            await setDoc(doc(db, 'users', fbUser.uid), {
              uid: fbUser.uid,
              name: cleanName,
              email: cleanEmail,
              role: 'user',
              status: 'active',
              createdAt: new Date().toISOString(),
              lastLoginAt: new Date().toISOString()
            });
          } catch (fsErr) {
            console.warn('Firestore initial registration write notice:', fsErr);
          }
        } catch (fbCreateErr: any) {
          if (fbCreateErr.code === 'auth/email-already-in-use') {
            return { success: false, error: 'An account with this email address already exists. Please log in.' };
          } else if (fbCreateErr.code === 'auth/weak-password') {
            return { success: false, error: 'Password must be at least 6 characters long.' };
          }
          console.warn('Firebase registration notice:', fbCreateErr.message);
        }
      }

      // Record in backend database for server-side verification and session creation
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, identifier: cleanId, password })
      });

      const data = await res.json();

      if (!res.ok) {
        if (fbUser) {
          const syncRes = await fetch('/api/auth/firebase-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uid: fbUser.uid,
              name: cleanName,
              email: cleanId.toLowerCase(),
              emailVerified: fbUser.emailVerified
            })
          });
          if (syncRes.ok) {
            const syncData = await syncRes.json();
            setToken(syncData.token);
            setUser(syncData.user);
            localStorage.setItem(STORAGE_KEY_TOKEN, syncData.token);
            localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(syncData.user));
            return { success: true };
          }
        }
        return { success: false, error: data.error || 'Registration failed.' };
      }

      setToken(data.token);
      setUser(data.user);
      localStorage.setItem(STORAGE_KEY_TOKEN, data.token);
      localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(data.user));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: 'Registration failed: ' + err.message };
    }
  };

  // Secure Logout
  const logout = async () => {
    try {
      await fbSignOut(auth);
    } catch (err) {
      console.warn('Firebase signout notice:', err);
    }

    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (err) {
        console.warn('Logout notification notice:', err);
      }
    }

    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_USER);
    setToken(null);
    setUser(null);
    setFirebaseUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        firebaseUser,
        login,
        loginWithGoogle,
        register,
        sendVerificationEmail,
        sendPasswordReset,
        reloadUser,
        logout,
        checkSession
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
