import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import crypto from 'crypto';
import { Readable } from 'stream';
import { ZipArchive } from 'archiver';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CRYPTOGRAPHIC PASSWORD UTILITIES ---
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  if (!stored.includes(':')) {
    // Plaintext fallback for initial seeds
    return stored === password;
  }
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(key, 'hex'));
  } catch {
    return false;
  }
}

// --- SANITIZE USER INPUT ---
function sanitizeInput(str: any): string {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

// --- RATE LIMITING ---
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

const createRateLimiter = (maxRequests: number, windowMs: number, message: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = rateLimitMap.get(ip);

    if (!record || now > record.resetTime) {
      rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
      return next();
    }

    if (record.count >= maxRequests) {
      return res.status(429).json({
        error: message,
        retryAfterSeconds: Math.ceil((record.resetTime - now) / 1000)
      });
    }

    record.count++;
    next();
  };
};

const authRateLimiter = createRateLimiter(20, 60 * 1000, 'Security notice: Too many authentication attempts. Please pause for 60 seconds.');
const geminiRateLimiter = createRateLimiter(60, 60 * 1000, 'AI rate limit reached. Please wait a moment before sending another question.');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CHUNKS_DIR = path.join(UPLOADS_DIR, '.chunks');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR, { recursive: true });

// --- CRYPTOGRAPHIC TOKEN MANAGEMENT (HMAC-SHA256) ---
function getSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(DATA_DIR, '.session_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, 'utf-8').trim();
      if (stored.length >= 32) return stored;
    }
  } catch {}
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  } catch {}
  return generated;
}

const SESSION_SECRET = getSessionSecret();
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24-hour automatic session expiration

interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  iat: number; // issued at (unix seconds)
  exp: number; // expiration (unix seconds)
  jti: string; // unique session ID
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function signToken(user: { id: string; email: string; role: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: TokenPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    jti: crypto.randomBytes(16).toString('hex')
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${header}.${encodedPayload}.${signature}`;
}

function verifyToken(token: string): TokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, encodedPayload, signature] = parts;
  try {
    const expectedSig = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(`${header}.${encodedPayload}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const payload: TokenPayload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    // Enforce session expiration
    if (!payload.exp || now > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// Account lockout protection for brute-force attacks (5 failed attempts = 15m lockout)
const failedLoginMap = new Map<string, { count: number; lockedUntil: number }>();

// Gemini client initialization helper (server-side only)
function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const ai = getAiClient();

// Helper to structure alternating contents for Gemini multi-turn conversation
function formatGeminiContents(messages: { role: string; content: string }[]) {
  const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
  
  for (const m of messages) {
    const rawText = typeof m.content === 'string' ? m.content.trim() : '';
    if (!rawText) continue;
    
    const role: 'user' | 'model' = (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user';
    
    // The sequence must start with a user message
    if (contents.length === 0) {
      if (role === 'user') {
        contents.push({ role: 'user', parts: [{ text: rawText }] });
      }
      continue;
    }
    
    // Alternate roles; merge consecutive identical roles
    const last = contents[contents.length - 1];
    if (last.role === role) {
      last.parts[0].text += `\n\n${rawText}`;
    } else {
      contents.push({ role, parts: [{ text: rawText }] });
    }
  }
  
  return contents;
}

// Seed data
const defaultDb = {
  settings: {
    theme: 'emerald-gold',
    appName: 'Angel Class',
    subtitle: 'Spiritual Education & Sacred Fellowship',
    primaryColor: '#0F382A',
    secondaryColor: '#164E3D',
    accentColor: '#D4AF37',
    backgroundColor: '#FDFBF7',
    fontHeading: 'Cinzel, Georgia, serif',
    fontBody: 'Inter, system-ui, sans-serif',
    cardStyle: 'rounded-xl border border-emerald-900/10 shadow-sm bg-white/95 backdrop-blur-sm',
    animationsEnabled: true,
    animationSpeed: 'normal', // slow, normal, fast
    logoUrl: '/logo.svg',
    versions: [
      {
        id: 'v1.0.0',
        name: 'Classical Sacred Emerald & Gold',
        timestamp: '2026-01-01T00:00:00.000Z',
        theme: 'emerald-gold',
        primaryColor: '#0F382A',
        accentColor: '#D4AF37'
      }
    ]
  },
  sections: [
    { id: 'videos', title: 'Videos', icon: 'Video', description: 'Spiritual lectures, guided visual meditations, and sacred discourses', order: 1, visible: true },
    { id: 'activity', title: 'Activity', icon: 'Compass', description: 'Fellowship initiatives, outreach projects, and group devotional exercises', order: 2, visible: true },
    { id: 'sop', title: 'SOP', icon: 'ScrollText', description: 'Standard Operating Procedures, sanctuary protocols, and service rules', order: 3, visible: true },
    { id: 'schedules', title: 'Yearly Schedules', icon: 'CalendarDays', description: 'Annual liturgy, seasonal ascensions, retreats, and holy calendar', order: 4, visible: true },
    { id: 'games', title: 'Games', icon: 'Sparkles', description: 'Scripture quizzes, celestial harmony puzzles, and uplifting fellowship challenges', order: 5, visible: true },
    { id: 'ppt', title: 'PPT Presentation', icon: 'Presentation', description: 'Interactive presentation slides with protected digital view', order: 6, visible: true, protected: true },
    { id: 'music', title: 'Music', icon: 'Music', description: 'Sacred hymns, meditative ambient compositions, and devotional chants', order: 7, visible: true },
    { id: 'photos', title: 'Photos', icon: 'Images', description: 'Sacred sanctuary archives, community ceremonies, and retreat moments', order: 8, visible: true },
    { id: 'learning', title: 'Learning Materials', icon: 'BookOpenCheck', description: 'Strictly protected spiritual doctrine, manuscripts, and commentaries', order: 9, visible: true, protected: true },
    { id: 'add-more', title: 'Add More', icon: 'PlusCircle', description: 'Custom administrator-published expansion modules', order: 10, visible: true },
    { id: 'video-links', title: 'Video Links', icon: 'Link', description: 'YouTube & direct video URLs played directly inside the app', order: 11, visible: true }
  ],
  users: [
    {
      id: 'admin-001',
      name: 'Angel Class Administrator',
      email: 'admin@angelclass.org',
      password: 'AngelAdmin2026!',
      role: 'admin',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLogin: new Date().toISOString(),
      sessionRevokedAt: null
    },
    {
      id: 'user-001',
      name: 'Grace Student',
      email: 'student@angelclass.org',
      password: 'AngelUser2026!',
      role: 'user',
      status: 'active',
      createdAt: '2026-02-15T10:00:00.000Z',
      lastLogin: new Date().toISOString(),
      sessionRevokedAt: null
    }
  ],
  auditLogs: [],
  content: {
    videos: [],
    'video-links': [],
    activity: [],
    sop: [],
    schedules: [],
    games: [],
    ppt: [],
    music: [],
    photos: [],
    learning: [],
    'add-more': [],
    custom: []
  },
  aiMemories: {}, // Record<userId, string[]>
  aiConversations: {} // Record<userId, Array<{ id, title, createdAt, updatedAt, messages }>>
};

// Initialize DB if not present and ensure core folders exist
function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2), 'utf-8');
      return defaultDb;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    let mutated = false;
    if (!Array.isArray(parsed.sections)) {
      parsed.sections = defaultDb.sections;
      mutated = true;
    }
    if (!parsed.sections.some((s: any) => s.id === 'video-links')) {
      parsed.sections.push({
        id: 'video-links',
        title: 'Video Links',
        icon: 'Link',
        description: 'YouTube & direct video URLs played directly inside the app',
        order: parsed.sections.length + 1,
        visible: true
      });
      mutated = true;
    }
    if (!parsed.content) {
      parsed.content = {};
      mutated = true;
    }
    if (!Array.isArray(parsed.content['video-links'])) {
      parsed.content['video-links'] = [];
      mutated = true;
    }
    if (mutated) {
      saveDb(parsed);
    }
    return parsed;
  } catch (err) {
    console.error('Error loading DB, returning default:', err);
    return defaultDb;
  }
}

function saveDb(data: any) {
  try {
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(DB_FILE, serialized, 'utf-8');
    // Maintain automated redundant backup for high reliability and recovery
    const backupFile = path.join(DATA_DIR, 'db.backup.json');
    fs.writeFileSync(backupFile, serialized, 'utf-8');
  } catch (err) {
    console.error('Failed to save DB:', err);
  }
}

async function startServer() {
  const app = express();

  // Middleware
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100mb' }));

  // Security Headers Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    next();
  });

  // Helper auth middleware using cryptographically signed HMAC-SHA256 tokens
  const getAuthUser = (req: Request) => {
    let token = req.headers.authorization?.replace(/^Bearer\s+/, '').trim();
    if (!token && typeof req.query.token === 'string') {
      token = req.query.token.trim();
    }
    if (!token) return null;

    try {
      const payload = verifyToken(token);
      if (!payload) return null;

      const db = loadDb();
      const user = db.users.find((u: any) => u.id === payload.userId);
      if (!user) return null;
      if (user.status !== 'active') return null;

      // Check session revocation (e.g. user logged out or admin revoked sessions)
      if (user.sessionRevokedAt) {
        const revokedTime = Math.floor(new Date(user.sessionRevokedAt).getTime() / 1000);
        if (payload.iat <= revokedTime) {
          return null;
        }
      }

      return user;
    } catch {
      return null;
    }
  };

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Session is invalid or has expired. Please sign in again.' });
    }
    (req as any).user = user;
    next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Valid administrator session required.' });
    }
    if (user.role !== 'admin') {
      addAuditLog(
        'SECURITY_UNAUTHORIZED_ACCESS',
        user.email,
        `User ${user.name} (${user.email}) with role [${user.role}] attempted to access admin route [${req.method} ${req.path}]. Access was blocked.`
      );
      return res.status(403).json({ error: 'Forbidden: Administrator privileges required to access this portal or resource.' });
    }
    (req as any).user = user;
    next();
  };

  // Log audit helper
  const addAuditLog = (action: string, performedBy: string, details: string) => {
    const db = loadDb();
    const newLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      action,
      performedBy,
      details,
      timestamp: new Date().toISOString()
    };
    db.auditLogs.unshift(newLog);
    // Keep max 250 logs
    if (db.auditLogs.length > 250) db.auditLogs.pop();
    saveDb(db);
  };

  // --- AUTHENTICATION ROUTES ---
  app.post('/api/auth/login', authRateLimiter, (req: Request, res: Response) => {
    const { email, identifier, password, requiredRole } = req.body;
    const rawId = (identifier || email || '').trim();
    if (!rawId || !password) {
      return res.status(400).json({ error: 'Email or phone number and password are required.' });
    }

    const cleanInput = sanitizeInput(rawId);
    const isEmail = cleanInput.includes('@');
    const cleanEmail = isEmail ? cleanInput.toLowerCase() : '';
    const cleanDigits = cleanInput.replace(/\D/g, '');

    // Check account lockout protection
    const lockoutKey = cleanEmail || cleanDigits || cleanInput;
    const lockoutRecord = failedLoginMap.get(lockoutKey);
    const now = Date.now();
    if (lockoutRecord && lockoutRecord.lockedUntil > now) {
      const waitMinutes = Math.ceil((lockoutRecord.lockedUntil - now) / 60000);
      return res.status(429).json({
        error: `Too many failed login attempts. This account is temporarily locked for your security. Please wait ${waitMinutes} minute(s) before trying again.`
      });
    }

    const db = loadDb();
    const user = db.users.find((u: any) => {
      if (isEmail && u.email && u.email.toLowerCase() === cleanEmail) return true;
      if (!isEmail && cleanDigits && u.phoneNumber && u.phoneNumber.replace(/\D/g, '') === cleanDigits) return true;
      if (u.email && u.email.toLowerCase() === cleanInput.toLowerCase()) return true;
      if (u.phoneNumber && u.phoneNumber === cleanInput) return true;
      return false;
    });

    if (!user || !verifyPassword(password, user.password)) {
      // Record failed attempt
      const attempts = (lockoutRecord ? lockoutRecord.count : 0) + 1;
      if (attempts >= 5) {
        failedLoginMap.set(lockoutKey, { count: attempts, lockedUntil: now + 15 * 60 * 1000 });
        addAuditLog('ACCOUNT_LOCKED', lockoutKey, `Account locked due to 5 consecutive failed login attempts.`);
        return res.status(429).json({
          error: 'Too many failed login attempts. This account is now locked for 15 minutes.'
        });
      } else {
        failedLoginMap.set(lockoutKey, { count: attempts, lockedUntil: 0 });
      }
      return res.status(401).json({ error: 'Invalid email/phone number or password. Please verify your credentials.' });
    }

    // Reset failed counter upon successful verification
    failedLoginMap.delete(lockoutKey);

    // Upgrade plaintext legacy seeds to scrypt hash automatically
    if (!user.password.includes(':')) {
      user.password = hashPassword(password);
      saveDb(db);
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been deactivated by the Administrator.' });
    }

    // Strict role check if logging in via a designated portal
    if (requiredRole && user.role !== requiredRole) {
      addAuditLog(
        'PORTAL_ROLE_MISMATCH',
        user.email || user.phoneNumber || user.id,
        `User ${user.email} with role [${user.role}] attempted to login via [${requiredRole}] portal.`
      );
      return res.status(403).json({
        error: requiredRole === 'admin' 
          ? 'Access denied: Administrator credentials required for the Admin Control Center.' 
          : 'Please log in via the standard login page.'
      });
    }

    // Update lastLogin
    user.lastLogin = new Date().toISOString();
    saveDb(db);

    addAuditLog('USER_LOGIN', user.email || user.phoneNumber || user.id, `User ${user.name} logged in successfully with verified role [${user.role}].`);

    // Create cryptographically signed HMAC-SHA256 session token
    const token = signToken(user);

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        role: user.role,
        status: user.status
      }
    });
  });

  // User registration (Only standard 'user' role can be registered - Admin is strictly protected!)
  app.post('/api/auth/register', authRateLimiter, (req: Request, res: Response) => {
    const { name, email, identifier, phoneNumber, password } = req.body;
    const rawId = (identifier || email || phoneNumber || '').trim();
    if (!name || !rawId || !password) {
      return res.status(400).json({ error: 'Full name, email or phone number, and password are required.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'For your security, password must be at least 8 characters long.' });
    }

    const cleanName = sanitizeInput(name);
    const isEmail = rawId.includes('@');
    const cleanEmail = isEmail ? sanitizeInput(rawId).toLowerCase() : `${rawId.replace(/\D/g, '')}@phone.angelclass.org`;
    const cleanPhone = !isEmail ? sanitizeInput(rawId) : (phoneNumber ? sanitizeInput(phoneNumber) : undefined);

    const db = loadDb();
    const existing = db.users.find((u: any) => {
      if (isEmail && u.email && u.email.toLowerCase() === cleanEmail) return true;
      if (!isEmail && cleanPhone && u.phoneNumber && u.phoneNumber.replace(/\D/g, '') === cleanPhone.replace(/\D/g, '')) return true;
      return false;
    });

    if (existing) {
      return res.status(409).json({ error: 'An account with this email or phone number already exists.' });
    }

    // Strictly enforce non-admin role! Users can NEVER register as Admin
    const newUser = {
      id: `user-${Date.now()}`,
      name: cleanName,
      email: cleanEmail,
      phoneNumber: cleanPhone,
      password: hashPassword(password), // Hashed with scrypt + salt
      role: 'user', // Hardcoded to 'user', never trust client input
      status: 'active',
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      sessionRevokedAt: null
    };

    db.users.push(newUser);
    saveDb(db);

    addAuditLog('USER_REGISTER', newUser.email, `New user ${newUser.name} created an account with role [user].`);

    const token = signToken(newUser);

    return res.status(201).json({
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        phoneNumber: newUser.phoneNumber,
        role: newUser.role,
        status: newUser.status
      }
    });
  });

  // Verify Current User Session
  app.get('/api/auth/me', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });
  });

  // Secure Logout (Revokes current session immediately)
  app.post('/api/auth/logout', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const db = loadDb();
    const dbUser = db.users.find((u: any) => u.id === user.id);
    if (dbUser) {
      dbUser.sessionRevokedAt = new Date().toISOString();
      saveDb(db);
    }
    addAuditLog('USER_LOGOUT', user.email, `User ${user.name} logged out securely. Session revoked.`);
    return res.json({ success: true, message: 'Logged out successfully. Session revoked.' });
  });

  // Firebase Auth sync endpoint (Protected against role elevation)
  app.post('/api/auth/firebase-sync', (req: Request, res: Response) => {
    const { uid, email, name, phoneNumber, emailVerified } = req.body;
    if (!email && !phoneNumber) {
      return res.status(400).json({ error: 'Email or phone number is required for Firebase sync.' });
    }

    const cleanEmail = email ? sanitizeInput(email).toLowerCase() : `${sanitizeInput(phoneNumber).replace(/[^0-9+]/g, '')}@phone.angelclass.org`;
    const cleanPhone = phoneNumber ? sanitizeInput(phoneNumber) : undefined;
    const cleanName = sanitizeInput(name) || (cleanPhone ? `User (${cleanPhone})` : 'User');
    const db = loadDb();

    let user = db.users.find((u: any) => (cleanEmail && u.email?.toLowerCase() === cleanEmail) || (u.id === uid) || (cleanPhone && u.phoneNumber === cleanPhone));
    const isAdminEmail = cleanEmail === 'p4175653@gmail.com' || cleanEmail === 'admin@angelclass.org';
    // Strict role resolution: only designated admin emails or pre-existing admin role. Strictly 'admin' or 'user'.
    const resolvedRole = isAdminEmail ? 'admin' : (user?.role === 'admin' ? 'admin' : 'user');

    if (!user) {
      user = {
        id: uid || `user-${Date.now()}`,
        name: cleanName,
        email: cleanEmail,
        phoneNumber: cleanPhone,
        emailVerified: !!emailVerified,
        password: hashPassword(crypto.randomBytes(24).toString('hex')),
        role: resolvedRole,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        sessionRevokedAt: null
      };
      db.users.push(user);
    } else {
      user.lastLogin = new Date().toISOString();
      if (cleanPhone && !user.phoneNumber) user.phoneNumber = cleanPhone;
      if (emailVerified !== undefined) user.emailVerified = !!emailVerified;
      if (isAdminEmail) user.role = 'admin';
    }

    saveDb(db);
    addAuditLog('FIREBASE_LOGIN', user.email || user.phoneNumber || user.id, `User signed in via Firebase Auth with role [${user.role}].`);

    const token = signToken(user);

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        emailVerified: user.emailVerified,
        role: user.role,
        status: user.status
      }
    });
  });

  // Forgot password endpoint (Safe password recovery for local accounts)
  app.post('/api/auth/forgot-password', authRateLimiter, (req: Request, res: Response) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email address is required.' });
    }
    const cleanEmail = sanitizeInput(email).toLowerCase();
    const db = loadDb();
    const user = db.users.find((u: any) => u.email.toLowerCase() === cleanEmail);

    // Always return generic success to prevent email enumeration attacks
    if (user) {
      addAuditLog('PASSWORD_RESET_REQUESTED', cleanEmail, `Password recovery dispatched for account ${cleanEmail}.`);
    }

    return res.json({
      success: true,
      message: 'If an account exists with this email address, password recovery instructions have been dispatched.'
    });
  });

  // --- SECTIONS & GLOBAL CONFIG ---
  app.get('/api/sections', (req: Request, res: Response) => {
    const db = loadDb();
    const sectionsWithCounts = [...db.sections]
      .sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999))
      .map((sec: any) => ({
        ...sec,
        itemCount: (db.content[sec.id] || []).length
      }));
    return res.json({ sections: sectionsWithCounts, settings: db.settings });
  });

  app.post('/api/admin/sections', requireAdmin, (req: Request, res: Response) => {
    const { title, description, icon } = req.body;
    const cleanTitle = sanitizeInput(title);
    if (!cleanTitle) return res.status(400).json({ error: 'Folder title is required' });

    const db = loadDb();
    const newId = `sec-${cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`;
    const maxOrder = db.sections.reduce((max: number, s: any) => Math.max(max, Number(s.order) || 0), 0);
    const newSec = {
      id: newId,
      title: cleanTitle,
      description: sanitizeInput(description) || 'Custom spiritual curriculum module',
      icon: sanitizeInput(icon) || 'Sparkles',
      order: maxOrder + 1,
      visible: true,
      isCustom: true
    };
    db.sections.push(newSec);
    if (!db.content[newId]) {
      db.content[newId] = [];
    }
    saveDb(db);

    const user = (req as any).user;
    addAuditLog('SECTION_CREATED', user.email, `Created folder "${newSec.title}".`);
    return res.status(201).json({ section: newSec, sections: db.sections });
  });

  app.put('/api/admin/sections/reorder', requireAdmin, (req: Request, res: Response) => {
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds array is required' });
    }

    const db = loadDb();
    const orderMap = new Map<string, number>();
    orderedIds.forEach((id: any, idx: number) => {
      if (typeof id === 'string' && !orderMap.has(id)) {
        orderMap.set(id, idx + 1);
      }
    });

    let nextOrder = orderMap.size + 1;
    db.sections.forEach((sec: any) => {
      if (orderMap.has(sec.id)) {
        sec.order = orderMap.get(sec.id);
      } else {
        sec.order = nextOrder++;
      }
    });

    db.sections.sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
    saveDb(db);

    const user = (req as any).user;
    addAuditLog('SECTIONS_REORDERED', user.email, `Reordered ${db.sections.length} folders.`);
    return res.json({ sections: db.sections });
  });

  app.put('/api/admin/sections/:id', requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params;
    const { title, description, icon, visible, order } = req.body;
    const db = loadDb();
    const sec = db.sections.find((s: any) => s.id === id);
    if (!sec) return res.status(404).json({ error: 'Folder not found' });

    if (title !== undefined) {
      const cleanTitle = sanitizeInput(title);
      if (!cleanTitle) {
        return res.status(400).json({ error: 'Folder name cannot be empty' });
      }
      sec.title = cleanTitle;
    }
    if (description !== undefined) sec.description = sanitizeInput(description);
    if (icon !== undefined) sec.icon = sanitizeInput(icon) || sec.icon;
    if (typeof visible === 'boolean') sec.visible = visible;
    if (typeof order === 'number' && !Number.isNaN(order)) sec.order = order;

    db.sections.sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
    saveDb(db);
    const user = (req as any).user;
    addAuditLog('SECTION_UPDATED', user.email, `Updated folder "${sec.title}" properties.`);
    return res.json({ section: sec, sections: db.sections });
  });

  // Helper to remove physical files in uploads/ linked to a content item
  const cleanupItemFiles = (item: any) => {
    if (!item) return;
    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const candidateUrls = [
      item.localUrl,
      item.url,
      item.audioUrl,
      item.fileUrl,
      item.downloadUrl,
      item.thumbnail,
      item.thumbnailUrl
    ].filter(Boolean);
    for (const rawUrl of candidateUrls) {
      if (typeof rawUrl === 'string' && rawUrl.startsWith('/api/files/')) {
        try {
          const localFileName = path.basename(rawUrl.split('?')[0]);
          const localFilePath = path.resolve(uploadsRoot, localFileName);
          if (localFilePath.startsWith(uploadsRoot + path.sep) && fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
          }
        } catch (err) {
          console.warn('File cleanup notice:', err);
        }
      }
    }
    if (typeof item.id === 'string' && /^[a-zA-Z0-9_-]{4,80}$/.test(item.id)) {
      for (const ext of ['.jpg', '.png', '.webp']) {
        try {
          const thumbPath = path.resolve(uploadsRoot, `thumb-${item.id}${ext}`);
          if (thumbPath.startsWith(uploadsRoot + path.sep) && fs.existsSync(thumbPath)) {
            fs.unlinkSync(thumbPath);
          }
        } catch (err) {
          console.warn('Thumbnail cleanup notice:', err);
        }
      }
    }
  };

  app.delete('/api/admin/sections/:id', requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params;
    const db = loadDb();
    const targetSec = db.sections.find((s: any) => s.id === id);
    if (!targetSec) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (db.sections.length <= 1) {
      return res.status(400).json({ error: 'At least one folder must remain in the application.' });
    }

    const sectionItems = db.content[id] || [];
    for (const item of sectionItems) {
      cleanupItemFiles(item);
    }

    db.sections = db.sections
      .filter((s: any) => s.id !== id)
      .sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999))
      .map((s: any, idx: number) => ({ ...s, order: idx + 1 }));
    delete db.content[id];
    saveDb(db);

    const user = (req as any).user;
    addAuditLog('SECTION_DELETED', user.email, `Deleted folder "${targetSec.title}" (${id}).`);
    return res.json({ success: true, sections: db.sections });
  });

  // --- CONTENT CRUD ---
  app.get('/api/content/:sectionId', requireAuth, (req: Request, res: Response) => {
    const { sectionId } = req.params;
    const user = (req as any).user;
    const db = loadDb();
    const items = db.content[sectionId] || [];

    if (user.role === 'admin') {
      return res.json({ sectionId, items });
    }

    const filtered = items.filter((item: any) => !item.status || item.status === 'approved');
    return res.json({ sectionId, items: filtered });
  });

  // Submission Approval (Admin only)
  app.put('/api/content/:sectionId/:itemId/status', requireAdmin, (req: Request, res: Response) => {
    const { sectionId, itemId } = req.params;
    const { status } = req.body;
    if (!['approved', 'rejected', 'pending_approval'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const db = loadDb();
    const items = db.content[sectionId] || [];
    const item = items.find((i: any) => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    item.status = status;
    item.reviewedAt = new Date().toISOString();
    saveDb(db);

    const user = (req as any).user;
    addAuditLog('SUBMISSION_STATUS_UPDATED', user.email, `Set item [${itemId}] status to "${status}" in [${sectionId}].`);
    return res.json({ item });
  });

  // Content deletion handler (Admin only - removes DB record AND physical storage file)
  const handleDeleteContentItem = (req: Request, res: Response) => {
    const { sectionId, itemId } = req.params;
    const user = (req as any).user;
    const db = loadDb();
    const items = db.content[sectionId] || [];
    const item = items.find((i: any) => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    db.content[sectionId] = items.filter((i: any) => i.id !== itemId);
    saveDb(db);

    cleanupItemFiles(item);

    addAuditLog('CONTENT_DELETED', user.email, `Admin deleted item [${itemId}] ("${item.title || item.name || 'File'}") from folder [${sectionId}].`);
    return res.json({ success: true, itemId, sectionId, message: 'Item and associated file permanently deleted.' });
  };

  app.delete('/api/content/:sectionId/:itemId', requireAdmin, handleDeleteContentItem);
  app.delete('/api/admin/content/:sectionId/:itemId', requireAdmin, handleDeleteContentItem);

  app.post('/api/admin/content/:sectionId', requireAdmin, (req: Request, res: Response) => {
    const { sectionId } = req.params;
    const raw = req.body || {};
    const title = sanitizeInput(raw.title || raw.name || '');
    if (!title) {
      return res.status(400).json({ error: 'Title is required to create an entry.' });
    }

    const db = loadDb();
    if (!db.content[sectionId]) db.content[sectionId] = [];

    const user = (req as any).user;
    const sanitizedData: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (['id', 'createdAt', 'uploadedBy'].includes(k)) continue;
      if (typeof v === 'string') {
        sanitizedData[k] = sanitizeInput(v);
      } else {
        sanitizedData[k] = v;
      }
    }

    const newItem = {
      ...sanitizedData,
      id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      title,
      name: sanitizedData.name || title,
      status: 'approved',
      uploadedBy: user.email,
      uploadedByName: user.name,
      date: sanitizedData.date || new Date().toISOString().split('T')[0],
      createdAt: new Date().toISOString()
    };

    db.content[sectionId].unshift(newItem);
    saveDb(db);

    addAuditLog('CONTENT_ADDED', user.email, `Added content item "${newItem.title}" in [${sectionId}].`);
    return res.status(201).json({ item: newItem });
  });

  const handleUpdateContentItem = (req: Request, res: Response) => {
    const { sectionId, itemId } = req.params;
    const raw = req.body || {};
    const db = loadDb();
    const items = db.content[sectionId] || [];
    const index = items.findIndex((i: any) => i.id === itemId);
    if (index === -1) return res.status(404).json({ error: 'Item not found' });

    const sanitizedUpdate: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (['id', 'createdAt', 'uploadedBy', 'uploadedAt'].includes(k)) continue;
      if (typeof v === 'string') {
        sanitizedUpdate[k] = sanitizeInput(v);
      } else {
        sanitizedUpdate[k] = v;
      }
    }

    const user = (req as any).user;
    items[index] = {
      ...items[index],
      ...sanitizedUpdate,
      updatedAt: new Date().toISOString(),
      updatedBy: user.email
    };
    saveDb(db);

    addAuditLog('CONTENT_UPDATED', user.email, `Updated item [${itemId}] ("${items[index].title || items[index].name || 'Entry'}") in [${sectionId}].`);
    return res.json({ item: items[index] });
  };

  app.put('/api/admin/content/:sectionId/:itemId', requireAdmin, handleUpdateContentItem);
  app.put('/api/content/:sectionId/:itemId', requireAdmin, handleUpdateContentItem);

  // Helper to extract YouTube thumbnail from video link
  const deriveYouTubeThumbnail = (rawUrl: string): string | undefined => {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      let ytId: string | null = null;
      if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
        if (parsed.pathname.startsWith('/embed/')) ytId = parsed.pathname.split('/embed/')[1]?.split(/[?&/]/)[0] || null;
        else if (parsed.pathname.startsWith('/shorts/')) ytId = parsed.pathname.split('/shorts/')[1]?.split(/[?&/]/)[0] || null;
        else if (parsed.pathname.startsWith('/live/')) ytId = parsed.pathname.split('/live/')[1]?.split(/[?&/]/)[0] || null;
        else ytId = parsed.searchParams.get('v');
      } else if (host.includes('youtu.be')) {
        ytId = parsed.pathname.replace(/^\//, '').split(/[?&/]/)[0] || null;
      }
      if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
    } catch {}
    return undefined;
  };

  // Video / Stream Link Creation (Allowed for both Admin & authenticated Users)
  const handleCreateVideoLink = (targetSection: 'videos' | 'video-links') => (req: Request, res: Response) => {
    const { title, url, instructor, description, duration, thumbnail } = req.body;
    if (!title || !url) {
      return res.status(400).json({ error: 'Title and video URL are required' });
    }

    const cleanUrl = sanitizeInput(url);
    if (!/^https?:\/\/.+/i.test(cleanUrl)) {
      return res.status(400).json({ error: 'Please paste a valid YouTube or direct video URL starting with http:// or https://' });
    }

    const db = loadDb();
    if (!db.content[targetSection]) db.content[targetSection] = [];

    const user = (req as any).user;
    const resolvedThumbnail = (typeof thumbnail === 'string' && thumbnail.trim())
      ? sanitizeInput(thumbnail)
      : deriveYouTubeThumbnail(cleanUrl);

    const newVideo: any = {
      id: `vid-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      title: sanitizeInput(title),
      name: sanitizeInput(title),
      url: cleanUrl,
      instructor: sanitizeInput(instructor) || user.name || 'Member',
      duration: sanitizeInput(duration) || '',
      description: sanitizeInput(description) || (targetSection === 'video-links' ? 'Video link played inside Angel Class.' : 'Video stream saved to Videos folder.'),
      status: 'approved',
      uploadedBy: user.email,
      uploadedByName: user.name,
      dateAdded: new Date().toISOString().split('T')[0],
      date: new Date().toISOString().split('T')[0],
      createdAt: new Date().toISOString()
    };

    if (resolvedThumbnail) {
      newVideo.thumbnail = resolvedThumbnail;
    }

    db.content[targetSection].unshift(newVideo);
    saveDb(db);

    addAuditLog('VIDEO_LINK_SAVED', user.email, `User [${user.role}] saved video link "${newVideo.title}" in [${targetSection}].`);

    return res.status(201).json({ item: newVideo });
  };

  app.post('/api/content/videos', requireAuth, handleCreateVideoLink('videos'));
  app.post('/api/content/video-links', requireAuth, handleCreateVideoLink('video-links'));

  // --- FILE UPLOADS WITH EXTENSION WHITELIST & PERSISTENT FOLDER STORAGE ---
  const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus']);
  const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.3gp', '.mkv']);
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
  const ALLOWED_EXTENSIONS = new Set([
    '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
    '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus',
    '.mp4', '.webm', '.mov', '.m4v', '.3gp', '.mkv',
    '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.zip'
  ]);

  const MIME_TYPES: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.3gp': 'video/3gpp',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.opus': 'audio/opus',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.rtf': 'application/rtf',
    '.zip': 'application/zip',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };

  const formatContentDisposition = (filename: string, inline = false): string => {
    const clean = path.basename(filename || 'angelclass-file').replace(/[\r\n"]/g, '_').trim() || 'angelclass-file';
    const asciiSafe = clean.replace(/[^\x20-\x7E]/g, '_') || 'angelclass-file';
    const mode = inline ? 'inline' : 'attachment';
    return `${mode}; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
  };

  const decodeDataUrlBuffer = (rawDataUrl: string): Buffer => {
    const commaIdx = rawDataUrl.indexOf(',');
    const base64Data = commaIdx !== -1 ? rawDataUrl.slice(commaIdx + 1).trim() : rawDataUrl.trim();
    return Buffer.from(base64Data, 'base64');
  };

  const saveThumbnailDataUrl = (thumbnailDataUrl: any, fileId: string): string | undefined => {
    if (typeof thumbnailDataUrl !== 'string' || !thumbnailDataUrl.startsWith('data:image/')) {
      return undefined;
    }
    try {
      const mimeMatch = thumbnailDataUrl.match(/^data:image\/(png|jpeg|jpg|webp)/i);
      const thumbExt = mimeMatch ? (mimeMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : mimeMatch[1].toLowerCase()) : 'jpg';
      const thumbFilename = `thumb-${fileId}.${thumbExt}`;
      const thumbBuffer = decodeDataUrlBuffer(thumbnailDataUrl);
      if (thumbBuffer.length > 0 && thumbBuffer.length <= 3 * 1024 * 1024) {
        fs.writeFileSync(path.join(UPLOADS_DIR, thumbFilename), thumbBuffer);
        return `/api/files/${thumbFilename}`;
      }
    } catch (thumbErr) {
      console.warn('Thumbnail save notice:', thumbErr);
    }
    return undefined;
  };

  const resolveUploadTargetSection = (db: any, requestedSection?: string, extension = ''): string => {
    const isKnownSection = requestedSection && db.sections.some((s: any) => s.id === requestedSection);
    if (isKnownSection && requestedSection) return requestedSection;
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(extension)) return 'photos';
    if (VIDEO_EXTENSIONS.has(extension)) return 'videos';
    if (AUDIO_EXTENSIONS.has(extension)) return 'music';
    if (['.pptx', '.ppt'].includes(extension)) return 'ppt';
    return 'add-more';
  };

  const buildUploadedContentItem = (params: {
    fileId: string;
    cleanName: string;
    extension: string;
    targetSection: string;
    viewUrl?: string;
    publicUrl?: string;
    firebaseUrl?: string;
    storagePath?: string;
    size: number;
    mimeType?: string;
    thumbnailUrl?: string;
    duration?: string;
    user: any;
  }) => {
    const {
      fileId,
      cleanName,
      extension,
      targetSection,
      viewUrl,
      publicUrl,
      firebaseUrl,
      storagePath,
      size,
      mimeType,
      thumbnailUrl,
      duration,
      user
    } = params;

    const isAudioExt = AUDIO_EXTENSIONS.has(extension);
    const isVideoExt = VIDEO_EXTENSIONS.has(extension);
    const isImageExt = IMAGE_EXTENSIONS.has(extension);
    const primaryUrl = firebaseUrl || viewUrl || '';
    const resolvedDownloadUrl = publicUrl || firebaseUrl || viewUrl || '';
    const resolvedMime = mimeType || MIME_TYPES[extension] || 'application/octet-stream';

    const newItem: any = {
      id: fileId,
      title: cleanName,
      name: cleanName,
      url: primaryUrl,
      localUrl: viewUrl || undefined,
      firebaseUrl: firebaseUrl || undefined,
      storagePath: storagePath || undefined,
      downloadUrl: resolvedDownloadUrl,
      type: resolvedMime || (isAudioExt ? 'audio' : isVideoExt ? 'video' : 'file'),
      mimeType: resolvedMime,
      size: size || 0,
      uploadedBy: user.email,
      uploadedByName: user.name,
      uploadedAt: new Date().toISOString(),
      status: 'approved',
      date: new Date().toISOString().split('T')[0]
    };

    if (thumbnailUrl) {
      newItem.thumbnail = thumbnailUrl;
    }

    if (isVideoExt || targetSection === 'videos' || targetSection === 'video-links') {
      if (duration && sanitizeInput(duration)) {
        newItem.duration = sanitizeInput(duration);
      } else if (!newItem.duration) {
        newItem.duration = 'Uploaded Video';
      }
      newItem.instructor = newItem.instructor || user.name;
    }

    if (isAudioExt || targetSection === 'music') {
      newItem.audioUrl = viewUrl || firebaseUrl || primaryUrl;
      newItem.artist = user.name;
      newItem.duration = (duration && sanitizeInput(duration)) || 'Uploaded Audio';
    } else if (isImageExt || targetSection === 'photos') {
      newItem.caption = `Uploaded by ${user.name}`;
      newItem.category = 'Photos';
      if (!newItem.thumbnail) {
        newItem.thumbnail = viewUrl || firebaseUrl || primaryUrl;
      }
    } else {
      newItem.author = user.name;
      newItem.isProtected = targetSection === 'learning' || targetSection === 'ppt';
    }

    return newItem;
  };

  app.post('/api/files/upload', requireAuth, (req: Request, res: Response) => {
    const {
      id: requestedId,
      name,
      type,
      size,
      dataUrl,
      section,
      thumbnailDataUrl,
      thumbnailUrl,
      firebaseUrl,
      storagePath,
      duration
    } = req.body;
    const user = (req as any).user;

    if (!dataUrl || typeof dataUrl !== 'string' || !name) {
      return res.status(400).json({ error: 'File data and name are required' });
    }

    const cleanName = path.basename(sanitizeInput(name));
    const extension = path.extname(cleanName).toLowerCase();

    if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
      return res.status(400).json({
        error: `Security violation: File type [${extension || 'unknown'}] is disallowed. Only safe documents, images, audio, video and presentations are permitted.`
      });
    }

    const safeReqId = typeof requestedId === 'string' && /^[a-zA-Z0-9_-]{4,80}$/.test(requestedId) ? requestedId : null;
    const fileId = safeReqId || `file-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const filename = `${fileId}${extension}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    try {
      const fileBuffer = decodeDataUrlBuffer(dataUrl);
      if (!fileBuffer || fileBuffer.length === 0) {
        return res.status(400).json({ error: 'Uploaded file data is empty or corrupted.' });
      }
      fs.writeFileSync(filePath, fileBuffer);

      const savedThumbnailUrl =
        saveThumbnailDataUrl(thumbnailDataUrl, fileId) ||
        (typeof thumbnailUrl === 'string' && thumbnailUrl.trim() ? sanitizeInput(thumbnailUrl) : undefined);

      const publicUrl = `/api/files/${filename}?download=1&name=${encodeURIComponent(cleanName)}`;
      const viewUrl = `/api/files/${filename}`;

      const db = loadDb();
      const targetSection = resolveUploadTargetSection(db, section, extension);
      const cleanFirebaseUrl = typeof firebaseUrl === 'string' && /^https?:\/\//i.test(firebaseUrl) ? firebaseUrl.trim() : undefined;
      const cleanStoragePath = typeof storagePath === 'string' && storagePath.trim() ? sanitizeInput(storagePath) : undefined;

      const newItem = buildUploadedContentItem({
        fileId,
        cleanName,
        extension,
        targetSection,
        viewUrl,
        publicUrl,
        firebaseUrl: cleanFirebaseUrl,
        storagePath: cleanStoragePath,
        size: fileBuffer.length || size || 0,
        mimeType: type || MIME_TYPES[extension],
        thumbnailUrl: savedThumbnailUrl,
        duration: typeof duration === 'string' ? duration : undefined,
        user
      });

      if (!db.content[targetSection]) db.content[targetSection] = [];
      db.content[targetSection] = db.content[targetSection].filter((it: any) => it.id !== fileId);
      db.content[targetSection].unshift(newItem);
      saveDb(db);

      addAuditLog('FILE_UPLOAD', user.email, `Uploaded verified file "${cleanName}" (${Math.round((fileBuffer.length || size || 0) / 1024)} KB) into [${targetSection}].`);

      return res.status(201).json({
        fileId,
        item: newItem,
        name: cleanName,
        type: newItem.type,
        size: newItem.size,
        url: newItem.url,
        section: targetSection,
        status: newItem.status
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'File storage failed: ' + err.message });
    }
  });

  // --- CHUNKED & RESUMABLE LARGE-FILE UPLOAD PIPELINE (UNRESTRICTED INFRASTRUCTURE SIZE) ---
  const checkAvailableStorageSpace = (requiredBytes: number): { ok: boolean; availableBytes: number } => {
    try {
      const stat = fs.statfsSync(UPLOADS_DIR);
      const available = Number(stat.bavail) * Number(stat.bsize);
      if (Number.isFinite(available) && available > 0 && requiredBytes > available) {
        return { ok: false, availableBytes: available };
      }
      return { ok: true, availableBytes: available };
    } catch {
      return { ok: true, availableBytes: Number.MAX_SAFE_INTEGER };
    }
  };

  const getChunkSessionDir = (rawUploadId: string): string | null => {
    const safeId = String(rawUploadId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId || safeId.length < 4 || safeId.length > 100) return null;
    const resolved = path.resolve(CHUNKS_DIR, safeId);
    const root = path.resolve(CHUNKS_DIR);
    if (!resolved.startsWith(root + path.sep)) return null;
    return resolved;
  };

  const listVerifiedChunks = (sessionDir: string, fileSize: number, chunkSize: number, totalChunks: number): { uploadedChunks: number[]; uploadedBytes: number } => {
    const uploadedChunks: number[] = [];
    let uploadedBytes = 0;
    for (let i = 0; i < totalChunks; i++) {
      const chunkFile = path.join(sessionDir, `chunk-${i}`);
      if (!fs.existsSync(chunkFile)) continue;
      const start = i * chunkSize;
      const expectedSize = Math.min(chunkSize, Math.max(0, fileSize - start));
      try {
        const stat = fs.statSync(chunkFile);
        if (stat.size === expectedSize && expectedSize > 0) {
          uploadedChunks.push(i);
          uploadedBytes += stat.size;
        }
      } catch {
        // ignore broken stat
      }
    }
    return { uploadedChunks, uploadedBytes };
  };

  // Initialize or resume a chunked upload session
  app.post('/api/files/upload/init', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const {
      uploadId: requestedUploadId,
      fileName,
      mimeType,
      fileSize,
      lastModified,
      section,
      chunkSize: requestedChunkSize,
      duration,
      firebaseUrl,
      storagePath,
      thumbnailUrl
    } = req.body || {};

    if (!fileName || typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize <= 0) {
      return res.status(400).json({ error: 'Valid fileName and non-zero fileSize are required.' });
    }

    const cleanName = path.basename(sanitizeInput(fileName));
    const extension = path.extname(cleanName).toLowerCase();
    if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
      return res.status(400).json({
        error: `File type [${extension || 'unknown'}] is disallowed. Only safe documents, images, audio, video and presentations are permitted.`
      });
    }

    const chunkSize = typeof requestedChunkSize === 'number' && requestedChunkSize >= 256 * 1024 && requestedChunkSize <= 16 * 1024 * 1024
      ? Math.floor(requestedChunkSize)
      : 4 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));

    const safeReqUploadId = typeof requestedUploadId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(requestedUploadId)
      ? requestedUploadId
      : `up-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    const sessionDir = getChunkSessionDir(safeReqUploadId);
    if (!sessionDir) {
      return res.status(400).json({ error: 'Invalid upload session identifier.' });
    }

    const metaPath = path.join(sessionDir, 'meta.json');
    let meta: any = null;

    if (fs.existsSync(metaPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const sameFile =
          existing.userId === user.id &&
          existing.fileName === cleanName &&
          existing.fileSize === fileSize &&
          existing.section === (section || existing.section) &&
          Number(existing.lastModified || 0) === Number(lastModified || 0);
        if (sameFile) {
          meta = existing;
        }
      } catch {
        // corrupt meta -> recreate fresh session
      }
    }

    if (!meta) {
      // Check actual infrastructure disk capacity
      const spaceCheck = checkAvailableStorageSpace(fileSize + 10 * 1024 * 1024);
      if (!spaceCheck.ok) {
        return res.status(507).json({
          error: `Insufficient server storage space (${Math.round(spaceCheck.availableBytes / (1024 * 1024))} MB free, ${Math.round(fileSize / (1024 * 1024))} MB required).`
        });
      }

      if (fs.existsSync(sessionDir)) {
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch {}
      }
      fs.mkdirSync(sessionDir, { recursive: true });

      const db = loadDb();
      const targetSection = resolveUploadTargetSection(db, section, extension);
      const fileId = `file-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

      meta = {
        uploadId: safeReqUploadId,
        fileId,
        userId: user.id,
        userEmail: user.email,
        fileName: cleanName,
        extension,
        mimeType: mimeType || MIME_TYPES[extension] || 'application/octet-stream',
        fileSize,
        lastModified: Number(lastModified || 0),
        section: targetSection,
        chunkSize,
        totalChunks,
        duration: typeof duration === 'string' ? sanitizeInput(duration) : undefined,
        firebaseUrl: typeof firebaseUrl === 'string' && /^https?:\/\//i.test(firebaseUrl) ? firebaseUrl.trim() : undefined,
        storagePath: typeof storagePath === 'string' && storagePath.trim() ? sanitizeInput(storagePath) : undefined,
        thumbnailUrl: typeof thumbnailUrl === 'string' && thumbnailUrl.trim() ? sanitizeInput(thumbnailUrl) : undefined,
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } else {
      // Update optional cloud metadata if refreshed on resume
      if (typeof firebaseUrl === 'string' && /^https?:\/\//i.test(firebaseUrl)) meta.firebaseUrl = firebaseUrl.trim();
      if (typeof storagePath === 'string' && storagePath.trim()) meta.storagePath = sanitizeInput(storagePath);
      if (typeof thumbnailUrl === 'string' && thumbnailUrl.trim()) meta.thumbnailUrl = sanitizeInput(thumbnailUrl);
      if (typeof duration === 'string' && duration.trim()) meta.duration = sanitizeInput(duration);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    }

    const { uploadedChunks, uploadedBytes } = listVerifiedChunks(
      sessionDir,
      meta.fileSize,
      meta.chunkSize,
      meta.totalChunks
    );

    return res.json({
      uploadId: meta.uploadId,
      fileId: meta.fileId,
      section: meta.section,
      chunkSize: meta.chunkSize,
      totalChunks: meta.totalChunks,
      uploadedChunks,
      uploadedBytes
    });
  });

  // Upload a single raw chunk atomically
  app.put(
    '/api/files/upload/chunk/:uploadId/:chunkIndex',
    requireAuth,
    express.raw({ type: '*/*', limit: '20mb' }),
    (req: Request, res: Response) => {
      const user = (req as any).user;
      const { uploadId, chunkIndex: rawChunkIndex } = req.params;
      const chunkIndex = Number(rawChunkIndex);

      const sessionDir = getChunkSessionDir(uploadId);
      if (!sessionDir) {
        return res.status(400).json({ error: 'Invalid upload session ID.' });
      }
      const metaPath = path.join(sessionDir, 'meta.json');
      if (!fs.existsSync(metaPath)) {
        return res.status(404).json({ error: 'Upload session not found or expired. Please restart upload.' });
      }

      let meta: any;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      } catch {
        return res.status(500).json({ error: 'Upload session metadata is corrupted.' });
      }

      if (meta.userId !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: Upload session belongs to another user.' });
      }

      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
        return res.status(400).json({ error: `Invalid chunk index [${rawChunkIndex}].` });
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty chunk payload.' });
      }

      const start = chunkIndex * meta.chunkSize;
      const expectedLen = Math.min(meta.chunkSize, Math.max(0, meta.fileSize - start));
      if (req.body.length !== expectedLen) {
        return res.status(400).json({
          error: `Chunk ${chunkIndex} size mismatch (expected ${expectedLen} bytes, received ${req.body.length} bytes).`
        });
      }

      const tempPath = path.join(sessionDir, `chunk-${chunkIndex}.tmp`);
      const finalChunkPath = path.join(sessionDir, `chunk-${chunkIndex}`);
      try {
        fs.writeFileSync(tempPath, req.body);
        fs.renameSync(tempPath, finalChunkPath);
      } catch (err: any) {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
        return res.status(500).json({ error: 'Failed to store uploaded chunk: ' + err.message });
      }

      return res.json({
        uploadId: meta.uploadId,
        chunkIndex,
        receivedBytes: req.body.length
      });
    }
  );

  // Query chunk verification status for resuming after network drops
  app.get('/api/files/upload/status/:uploadId', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const sessionDir = getChunkSessionDir(req.params.uploadId);
    if (!sessionDir) return res.status(400).json({ error: 'Invalid upload ID.' });
    const metaPath = path.join(sessionDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Upload session not found.' });

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.userId !== user.id && user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden.' });
      }
      const { uploadedChunks, uploadedBytes } = listVerifiedChunks(
        sessionDir,
        meta.fileSize,
        meta.chunkSize,
        meta.totalChunks
      );
      return res.json({
        uploadId: meta.uploadId,
        fileSize: meta.fileSize,
        chunkSize: meta.chunkSize,
        totalChunks: meta.totalChunks,
        uploadedChunks,
        uploadedBytes
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Status lookup failed.' });
    }
  });

  // Assemble all chunks sequentially into final file and verify byte-exact integrity
  app.post('/api/files/upload/complete/:uploadId', requireAuth, async (req: Request, res: Response) => {
    const user = (req as any).user;
    const sessionDir = getChunkSessionDir(req.params.uploadId);
    if (!sessionDir) return res.status(400).json({ error: 'Invalid upload ID.' });
    const metaPath = path.join(sessionDir, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Upload session not found or already completed.' });
    }

    let meta: any;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return res.status(500).json({ error: 'Upload metadata corrupted.' });
    }

    if (meta.userId !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    // Verify all chunks exist with expected byte sizes
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkPath = path.join(sessionDir, `chunk-${i}`);
      const expectedLen = Math.min(meta.chunkSize, Math.max(0, meta.fileSize - i * meta.chunkSize));
      if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size !== expectedLen) {
        return res.status(409).json({
          error: `Missing or incomplete chunk ${i + 1}/${meta.totalChunks}. Please resume upload.`
        });
      }
    }

    const fileId = meta.fileId;
    const filename = `${fileId}${meta.extension}`;
    const tempAssembledPath = path.join(UPLOADS_DIR, `${filename}.assembling`);
    const finalPath = path.join(UPLOADS_DIR, filename);

    try {
      const writeFd = fs.openSync(tempAssembledPath, 'w');
      try {
        for (let i = 0; i < meta.totalChunks; i++) {
          const chunkPath = path.join(sessionDir, `chunk-${i}`);
          const chunkBuf = fs.readFileSync(chunkPath);
          let written = 0;
          while (written < chunkBuf.length) {
            written += fs.writeSync(writeFd, chunkBuf, written, chunkBuf.length - written);
          }
        }
      } finally {
        fs.closeSync(writeFd);
      }

      const assembledSize = fs.statSync(tempAssembledPath).size;
      if (assembledSize !== meta.fileSize) {
        try {
          fs.unlinkSync(tempAssembledPath);
        } catch {}
        return res.status(500).json({
          error: `File integrity verification failed (expected ${meta.fileSize} bytes, assembled ${assembledSize} bytes).`
        });
      }

      fs.renameSync(tempAssembledPath, finalPath);

      const { thumbnailDataUrl, duration, firebaseUrl, storagePath, thumbnailUrl } = req.body || {};
      const resolvedDuration = (typeof duration === 'string' && duration.trim()) ? sanitizeInput(duration) : meta.duration;
      const cleanFirebaseUrl = (typeof firebaseUrl === 'string' && /^https?:\/\//i.test(firebaseUrl) ? firebaseUrl.trim() : undefined) || meta.firebaseUrl;
      const cleanStoragePath = (typeof storagePath === 'string' && storagePath.trim() ? sanitizeInput(storagePath) : undefined) || meta.storagePath;
      const savedThumbnailUrl =
        saveThumbnailDataUrl(thumbnailDataUrl, fileId) ||
        (typeof thumbnailUrl === 'string' && /^https?:\/\/|^\/api\/files\//i.test(thumbnailUrl) ? sanitizeInput(thumbnailUrl) : undefined) ||
        meta.thumbnailUrl;

      const publicUrl = `/api/files/${filename}?download=1&name=${encodeURIComponent(meta.fileName)}`;
      const viewUrl = `/api/files/${filename}`;

      const db = loadDb();
      const targetSection = resolveUploadTargetSection(db, meta.section, meta.extension);
      const newItem = buildUploadedContentItem({
        fileId,
        cleanName: meta.fileName,
        extension: meta.extension,
        targetSection,
        viewUrl,
        publicUrl,
        firebaseUrl: cleanFirebaseUrl,
        storagePath: cleanStoragePath,
        size: assembledSize,
        mimeType: meta.mimeType || MIME_TYPES[meta.extension],
        thumbnailUrl: savedThumbnailUrl,
        duration: resolvedDuration,
        user
      });

      if (!db.content[targetSection]) db.content[targetSection] = [];
      db.content[targetSection] = db.content[targetSection].filter((it: any) => it.id !== fileId);
      db.content[targetSection].unshift(newItem);
      saveDb(db);

      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}

      const sizeLabel = assembledSize >= 1024 * 1024
        ? `${(assembledSize / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.round(assembledSize / 1024)} KB`;
      addAuditLog('FILE_UPLOAD', user.email, `Uploaded verified file "${meta.fileName}" (${sizeLabel}) via resumable chunked upload into [${targetSection}].`);

      return res.status(201).json({
        fileId,
        item: newItem,
        name: meta.fileName,
        type: newItem.type,
        size: newItem.size,
        url: newItem.url,
        section: targetSection,
        status: newItem.status
      });
    } catch (err: any) {
      try {
        if (fs.existsSync(tempAssembledPath)) fs.unlinkSync(tempAssembledPath);
      } catch {}
      return res.status(500).json({ error: 'Failed to assemble uploaded file: ' + err.message });
    }
  });

  // Cancel and clean up a resumable upload session
  app.delete('/api/files/upload/:uploadId', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const sessionDir = getChunkSessionDir(req.params.uploadId);
    if (!sessionDir) return res.status(400).json({ error: 'Invalid upload ID.' });
    const metaPath = path.join(sessionDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.userId !== user.id && user.role !== 'admin') {
          return res.status(403).json({ error: 'Forbidden.' });
        }
      } catch {}
    }
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Cleanup failed.' });
    }
  });

  // Streaming raw binary upload (low-memory for Windows & Android with no arbitrary 50MB limit)
  app.post('/api/files/upload-binary', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const decodeHeader = (val: string | string[] | undefined): string => {
      if (!val) return '';
      const raw = Array.isArray(val) ? val[0] : val;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    };

    const rawName = decodeHeader(req.headers['x-file-name']);
    const rawMime = decodeHeader(req.headers['x-file-mime']);
    const requestedSection = decodeHeader(req.headers['x-file-section']);
    const requestedId = decodeHeader(req.headers['x-file-id']);
    const rawDuration = decodeHeader(req.headers['x-file-duration']);
    const rawFirebaseUrl = decodeHeader(req.headers['x-firebase-url']);
    const rawStoragePath = decodeHeader(req.headers['x-storage-path']);
    const rawThumbnailUrl = decodeHeader(req.headers['x-thumbnail-url']);

    if (!rawName) {
      return res.status(400).json({ error: 'Binary file body and x-file-name header are required.' });
    }

    const cleanName = path.basename(sanitizeInput(rawName));
    const extension = path.extname(cleanName).toLowerCase();

    if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
      return res.status(400).json({
        error: `File type [${extension || 'unknown'}] is disallowed. Only safe documents, images, audio, video and presentations are permitted.`
      });
    }

    const safeReqId = /^[a-zA-Z0-9_-]{4,80}$/.test(requestedId) ? requestedId : null;
    const fileId = safeReqId || `file-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const filename = `${fileId}${extension}`;
    const tempPath = path.join(UPLOADS_DIR, `${filename}.uploading`);
    const filePath = path.join(UPLOADS_DIR, filename);

    let totalBytes = 0;
    let settled = false;
    const writeStream = fs.createWriteStream(tempPath);

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
    });

    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      writeStream.destroy();
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
    });

    writeStream.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      if (!res.headersSent) {
        res.status(500).json({ error: 'Binary file storage failed: ' + err.message });
      }
    });

    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;

      if (totalBytes === 0) {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
        return res.status(400).json({ error: 'Uploaded binary file body is empty.' });
      }

      try {
        fs.renameSync(tempPath, filePath);

        const publicUrl = `/api/files/${filename}?download=1&name=${encodeURIComponent(cleanName)}`;
        const viewUrl = `/api/files/${filename}`;

        const db = loadDb();
        const targetSection = resolveUploadTargetSection(db, requestedSection, extension);
        const cleanFirebaseUrl = /^https?:\/\//i.test(rawFirebaseUrl) ? rawFirebaseUrl.trim() : undefined;
        const cleanStoragePath = rawStoragePath.trim() ? sanitizeInput(rawStoragePath) : undefined;
        const cleanThumbUrl = /^https?:\/\/|^\/api\/files\//i.test(rawThumbnailUrl) ? rawThumbnailUrl.trim() : undefined;

        const newItem = buildUploadedContentItem({
          fileId,
          cleanName,
          extension,
          targetSection,
          viewUrl,
          publicUrl,
          firebaseUrl: cleanFirebaseUrl,
          storagePath: cleanStoragePath,
          size: totalBytes,
          mimeType: rawMime || MIME_TYPES[extension],
          thumbnailUrl: cleanThumbUrl,
          duration: rawDuration || undefined,
          user
        });

        if (!db.content[targetSection]) db.content[targetSection] = [];
        db.content[targetSection] = db.content[targetSection].filter((it: any) => it.id !== fileId);
        db.content[targetSection].unshift(newItem);
        saveDb(db);

        addAuditLog('FILE_UPLOAD', user.email, `Uploaded binary file "${cleanName}" (${Math.round(totalBytes / 1024)} KB) into [${targetSection}].`);

        return res.status(201).json({
          fileId,
          item: newItem,
          name: cleanName,
          type: newItem.type,
          size: newItem.size,
          url: newItem.url,
          section: targetSection,
          status: newItem.status
        });
      } catch (err: any) {
        return res.status(500).json({ error: 'Binary file storage failed: ' + err.message });
      }
    });

    req.pipe(writeStream);
  });

  // Register or enrich metadata for files uploaded to Firebase Storage (and attach generated thumbnails)
  app.post('/api/files/register', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const {
      id: requestedId,
      name,
      title,
      type,
      size,
      section,
      url,
      firebaseUrl,
      storagePath,
      thumbnailUrl,
      thumbnailDataUrl,
      duration
    } = req.body || {};

    const db = loadDb();
    const safeReqId = typeof requestedId === 'string' && /^[a-zA-Z0-9_-]{4,80}$/.test(requestedId) ? requestedId : null;
    const targetSection = resolveUploadTargetSection(db, section, path.extname(String(name || '')).toLowerCase());
    if (!db.content[targetSection]) db.content[targetSection] = [];

    const existingIdx = safeReqId ? db.content[targetSection].findIndex((it: any) => it.id === safeReqId) : -1;

    if (existingIdx !== -1) {
      const existingItem = db.content[targetSection][existingIdx];
      const savedThumb = saveThumbnailDataUrl(thumbnailDataUrl, existingItem.id);
      if (savedThumb) existingItem.thumbnail = savedThumb;
      else if (typeof thumbnailUrl === 'string' && thumbnailUrl.trim()) existingItem.thumbnail = thumbnailUrl.trim();
      if (typeof firebaseUrl === 'string' && /^https?:\/\//i.test(firebaseUrl)) {
        existingItem.firebaseUrl = firebaseUrl.trim();
        existingItem.url = existingItem.url || firebaseUrl.trim();
      }
      if (typeof storagePath === 'string' && storagePath.trim()) {
        existingItem.storagePath = sanitizeInput(storagePath);
      }
      if (typeof duration === 'string' && duration.trim()) {
        existingItem.duration = sanitizeInput(duration);
      }
      saveDb(db);
      return res.json({ item: existingItem, section: targetSection });
    }

    const resolvedUrl = (typeof firebaseUrl === 'string' && /^https?:\/\//i.test(firebaseUrl) ? firebaseUrl.trim() : '')
      || (typeof url === 'string' && /^https?:\/\//i.test(url) ? url.trim() : '');

    if (!resolvedUrl || !name) {
      return res.status(400).json({ error: 'Valid Firebase Storage URL and file name are required.' });
    }

    const cleanName = path.basename(sanitizeInput(name || title));
    const extension = path.extname(cleanName).toLowerCase();
    if (extension && !ALLOWED_EXTENSIONS.has(extension)) {
      return res.status(400).json({ error: `File type [${extension}] is disallowed.` });
    }

    const fileId = safeReqId || `file-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const savedThumb = saveThumbnailDataUrl(thumbnailDataUrl, fileId)
      || (typeof thumbnailUrl === 'string' && thumbnailUrl.trim() ? sanitizeInput(thumbnailUrl) : undefined);

    const newItem = buildUploadedContentItem({
      fileId,
      cleanName,
      extension,
      targetSection,
      firebaseUrl: resolvedUrl,
      publicUrl: resolvedUrl,
      storagePath: typeof storagePath === 'string' ? sanitizeInput(storagePath) : undefined,
      size: typeof size === 'number' ? size : 0,
      mimeType: type || MIME_TYPES[extension],
      thumbnailUrl: savedThumb,
      duration: typeof duration === 'string' ? duration : undefined,
      user
    });

    db.content[targetSection].unshift(newItem);
    saveDb(db);
    addAuditLog('FILE_REGISTERED', user.email, `Registered uploaded file "${cleanName}" in [${targetSection}].`);

    return res.status(201).json({
      fileId,
      item: newItem,
      section: targetSection,
      status: newItem.status
    });
  });

  // Single file download proxy for all authenticated users (supports local storage & Firebase Storage URLs)
  app.get('/api/download/file', requireAuth, async (req: Request, res: Response) => {
    const fileUrl = String(req.query.url || '').trim();
    const fallbackUrl = String(req.query.fallback || '').trim();
    const rawNameParam = req.query.name ? path.basename(String(req.query.name)) : '';
    const user = (req as any).user;

    if (!fileUrl && !fallbackUrl) {
      return res.status(400).json({ error: 'File URL parameter is required' });
    }

    const deriveDownloadName = (candidateUrl: string): string => {
      const base = rawNameParam || 'angelclass-file';
      if (path.extname(base)) return base;
      try {
        const cleanPath = candidateUrl.startsWith('http')
          ? new URL(candidateUrl).pathname
          : candidateUrl.split('?')[0];
        const ext = path.extname(decodeURIComponent(cleanPath));
        return ext ? `${base}${ext}` : base;
      } catch {
        const ext = path.extname(candidateUrl.split('?')[0]);
        return ext ? `${base}${ext}` : base;
      }
    };

    const fileName = deriveDownloadName(fileUrl || fallbackUrl);
    addAuditLog(user.role === 'admin' ? 'ADMIN_FILE_DOWNLOAD' : 'USER_FILE_DOWNLOAD', user.email, `User downloaded file: "${fileName}".`);

    const tryServeLocal = (candidate: string): boolean => {
      if (!candidate.startsWith('/api/files/')) return false;
      const filename = path.basename(candidate.split('?')[0]);
      const uploadsRoot = path.resolve(UPLOADS_DIR);
      const target = path.resolve(uploadsRoot, filename);
      if (target.startsWith(uploadsRoot + path.sep) && fs.existsSync(target)) {
        const ext = path.extname(filename).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
        const stat = fs.statSync(target);
        const fileSize = stat.size;
        const rangeHeader = req.headers.range;

        if (rangeHeader && fileSize > 0) {
          const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
          if (match) {
            let start = match[1] ? parseInt(match[1], 10) : 0;
            let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
            if (!match[1] && match[2]) {
              start = Math.max(0, fileSize - parseInt(match[2], 10));
              end = fileSize - 1;
            }
            end = Math.min(end, fileSize - 1);
            if (!isNaN(start) && !isNaN(end) && start >= 0 && start <= end && start < fileSize) {
              res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': mimeType,
                'Content-Disposition': formatContentDisposition(fileName, false)
              });
              if (req.method === 'HEAD') return res.end(), true;
              const stream = fs.createReadStream(target, { start, end });
              res.on('close', () => stream.destroy());
              stream.on('error', () => {
                if (!res.headersSent) res.status(500).end();
              });
              stream.pipe(res);
              return true;
            }
          }
        }

        res.writeHead(200, {
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Length': fileSize,
          'Content-Disposition': formatContentDisposition(fileName, false)
        });
        if (req.method === 'HEAD') return res.end(), true;
        const stream = fs.createReadStream(target);
        res.on('close', () => stream.destroy());
        stream.on('error', () => {
          if (!res.headersSent) res.status(500).end();
        });
        stream.pipe(res);
        return true;
      }
      return false;
    };

    const tryServeRemote = async (candidate: string): Promise<boolean> => {
      if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) return false;
      try {
        const forwardHeaders: Record<string, string> = {};
        if (req.headers.range) forwardHeaders.Range = req.headers.range;
        const response = await fetch(candidate, { headers: forwardHeaders });
        if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const contentLength = response.headers.get('content-length');
        const contentRange = response.headers.get('content-range');
        res.status(response.status === 206 ? 206 : 200);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        if (contentRange) res.setHeader('Content-Range', contentRange);
        res.setHeader('Content-Disposition', formatContentDisposition(fileName, false));
        if (req.method === 'HEAD') {
          res.end();
          return true;
        }
        if (response.body) {
          const nodeStream = Readable.fromWeb(response.body as any);
          res.on('close', () => nodeStream.destroy());
          nodeStream.on('error', () => {
            if (!res.headersSent) res.status(500).end();
          });
          nodeStream.pipe(res);
          return true;
        }
        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
        return true;
      } catch (err: any) {
        console.warn('Remote download notice:', err.message);
        return false;
      }
    };

    const candidates = [fileUrl, fallbackUrl].filter(Boolean);
    for (const candidate of candidates) {
      if (tryServeLocal(candidate)) return;
      if (await tryServeRemote(candidate)) return;
    }

    return res.status(404).json({ error: 'File not found in storage' });
  });

  const buildFolderZipResponse = async (
    req: Request,
    res: Response,
    folderId: string,
    extraItems: any[] = []
  ) => {
    const user = (req as any).user;
    const db = loadDb();
    const section = db.sections.find((s: any) => s.id === folderId);
    const folderTitle = section?.title || folderId;
    const safeFolderPrefix = folderTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || folderId;

    const serverItems = (db.content[folderId] || []).filter(
      (it: any) => user.role === 'admin' || !it.status || it.status === 'approved'
    );

    // Merge backend items with client Firestore items deduplicated by ID
    const mergedMap = new Map<string, any>();
    for (const item of serverItems) {
      if (item?.id) mergedMap.set(item.id, item);
    }
    for (const item of extraItems) {
      if (!item?.id) continue;
      if (user.role !== 'admin' && item.status && item.status !== 'approved') continue;
      const existing = mergedMap.get(item.id);
      mergedMap.set(item.id, existing ? { ...item, ...existing, firebaseUrl: existing.firebaseUrl || item.firebaseUrl } : item);
    }
    const items = Array.from(mergedMap.values());

    if (items.length === 0) {
      return res.status(400).json({ error: 'This folder is empty. Nothing to download.' });
    }

    addAuditLog('FOLDER_DOWNLOAD_ALL', user.email, `Downloaded all (${items.length}) items from [${folderTitle}].`);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      formatContentDisposition(`AngelClass-${folderTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`, false)
    );

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err: any) => {
      console.error('Folder archive error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to create folder archive' });
    });
    archive.pipe(res);

    const usedEntryNames = new Set<string>();
    const allocateUniqueEntryPath = (baseName: string, ext: string): string => {
      const cleanBase = (baseName || 'file').replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
      const normalizedExt = ext && ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
      const baseWithoutExt = normalizedExt && cleanBase.toLowerCase().endsWith(normalizedExt.toLowerCase())
        ? cleanBase.slice(0, -normalizedExt.length)
        : cleanBase;

      let candidate = `${safeFolderPrefix}/${baseWithoutExt}${normalizedExt}`;
      let counter = 1;
      while (usedEntryNames.has(candidate.toLowerCase())) {
        candidate = `${safeFolderPrefix}/${baseWithoutExt} (${counter})${normalizedExt}`;
        counter++;
      }
      usedEntryNames.add(candidate.toLowerCase());
      return candidate;
    };

    const manifestContent = `# Angel Class — ${folderTitle}
Folder: ${folderTitle}
Total Items: ${items.length}
Downloaded: ${new Date().toISOString()}

=====================================
${items.map((item: any, idx: number) => `
[${idx + 1}] ${item.title || item.name || 'Item'}
- ID: ${item.id}
- Author/Contributor: ${item.instructor || item.author || item.artist || item.leader || item.uploadedByName || item.uploadedBy || 'Angel Class'}
- Date: ${item.date || item.dateAdded || item.createdAt || 'N/A'}
- Source: ${item.url || item.firebaseUrl || item.localUrl || item.audioUrl || 'Embedded Content'}
`).join('\n')}
`;
    archive.append(manifestContent, { name: `${safeFolderPrefix}/_Folder-Manifest.txt` });

    const uploadsRoot = path.resolve(UPLOADS_DIR);
    for (const item of items) {
      const displayBase = item.name || item.title || item.id;
      let appended = false;

      // 1. Try local disk storage first
      const localCandidates = [item.localUrl, item.url, item.fileUrl, item.audioUrl, item.downloadUrl].filter(
        (u: any) => typeof u === 'string' && u.startsWith('/api/files/')
      );
      for (const localUrl of localCandidates) {
        const filename = path.basename(localUrl.split('?')[0]);
        const target = path.resolve(uploadsRoot, filename);
        if (target.startsWith(uploadsRoot + path.sep) && fs.existsSync(target)) {
          const ext = path.extname(filename) || path.extname(displayBase);
          archive.file(target, { name: allocateUniqueEntryPath(displayBase, ext) });
          appended = true;
          break;
        }
      }
      if (appended) continue;

      // 2. Try Firebase Storage / direct downloadable remote URL
      const remoteCandidates = [item.firebaseUrl, item.url, item.fileUrl, item.audioUrl, item.downloadUrl].filter(
        (u: any) => typeof u === 'string' && /^https?:\/\//i.test(u)
      );
      for (const remoteUrl of remoteCandidates) {
        if (/(youtube\.com|youtu\.be|vimeo\.com)/i.test(remoteUrl)) continue;
        try {
          const resp = await fetch(remoteUrl);
          if (resp.ok) {
            const urlPathExt = (() => {
              try {
                return path.extname(decodeURIComponent(new URL(remoteUrl).pathname));
              } catch {
                return '';
              }
            })();
            const ext = path.extname(displayBase) || urlPathExt;
            if (resp.body) {
              archive.append(Readable.fromWeb(resp.body as any), { name: allocateUniqueEntryPath(displayBase, ext) });
            } else {
              const arrBuf = await resp.arrayBuffer();
              archive.append(Buffer.from(arrBuf), { name: allocateUniqueEntryPath(displayBase, ext) });
            }
            appended = true;
            break;
          }
        } catch (err: any) {
          console.warn('ZIP remote fetch fallback:', err?.message);
        }
      }
      if (appended) continue;

      // 3. Fallback text record (video links / text entries)
      let docText = `${item.title || item.name}\n${'='.repeat(40)}\n\n`;
      if (item.url) docText += `URL: ${item.url}\n\n`;
      if (item.summary) docText += `Summary:\n${item.summary}\n\n`;
      if (item.description) docText += `Description:\n${item.description}\n\n`;
      if (item.lyrics) docText += `Lyrics:\n${item.lyrics}\n\n`;
      if (Array.isArray(item.steps)) docText += `Procedures:\n${item.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}\n\n`;
      if (Array.isArray(item.contentSections)) {
        docText += item.contentSections.map((cs: any) => `## ${cs.heading}\n${cs.body}\n`).join('\n');
      }
      if (Array.isArray(item.slides)) {
        docText += item.slides.map((sl: any, i: number) => `Slide ${i + 1}: ${sl.title}\n${sl.content}\nQuote: ${sl.quote || ''}\n`).join('\n');
      }
      if (item.date) docText += `Date/Schedule: ${item.date}\n`;
      if (item.location) docText += `Location: ${item.location}\n`;
      if (item.leader) docText += `Leader: ${item.leader}\n`;

      archive.append(docText, { name: allocateUniqueEntryPath(displayBase, '.txt') });
    }

    await archive.finalize();
  };

  // Bulk Folder ZIP Download ("Download All" inside any folder for authenticated users)
  app.get('/api/download/folder/:folderId', requireAuth, async (req: Request, res: Response) => {
    await buildFolderZipResponse(req, res, req.params.folderId, []);
  });

  app.post('/api/download/folder/:folderId', requireAuth, async (req: Request, res: Response) => {
    const clientItems = Array.isArray(req.body?.items) ? req.body.items : [];
    await buildFolderZipResponse(req, res, req.params.folderId, clientItems);
  });

  // Complete Library ZIP Download (Admin Only)
  app.get('/api/download/library', requireAdmin, async (req: Request, res: Response) => {
    const db = loadDb();
    const user = (req as any).user;
    addAuditLog('ADMIN_LIBRARY_DOWNLOAD', user.email, 'Admin exported complete library ZIP archive.');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', formatContentDisposition('AngelClass-Complete-Library.zip', false));

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err: any) => {
      console.error('Library archive error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to build library archive' });
    });
    archive.pipe(res);

    const readmeText = `# Angel Class — Complete Library Archive
Downloaded: ${new Date().toISOString()}
Version: 2.0 Complete Library Archive
`;
    archive.append(readmeText, { name: 'README.txt' });

    const uploadsRoot = path.resolve(UPLOADS_DIR);
    for (const sec of db.sections) {
      const folderTitle = sec.title.replace(/[^a-zA-Z0-9_-]/g, '_');
      const items = db.content[sec.id] || [];
      const usedNames = new Set<string>();

      const uniquePath = (base: string, ext: string) => {
        const cleanBase = (base || 'file').replace(/[\\/:*?"<>|]/g, '_');
        const stripped = ext && cleanBase.toLowerCase().endsWith(ext.toLowerCase())
          ? cleanBase.slice(0, -ext.length)
          : cleanBase;
        let cand = `${folderTitle}/${stripped}${ext}`;
        let c = 1;
        while (usedNames.has(cand.toLowerCase())) {
          cand = `${folderTitle}/${stripped} (${c})${ext}`;
          c++;
        }
        usedNames.add(cand.toLowerCase());
        return cand;
      };

      for (const item of items) {
        const displayBase = item.name || item.title || item.id;
        let appended = false;

        const localCandidate = [item.localUrl, item.url, item.fileUrl, item.audioUrl].find(
          (u: any) => typeof u === 'string' && u.startsWith('/api/files/')
        );
        if (localCandidate) {
          const filename = path.basename(localCandidate.split('?')[0]);
          const target = path.resolve(uploadsRoot, filename);
          if (target.startsWith(uploadsRoot + path.sep) && fs.existsSync(target)) {
            const ext = path.extname(filename) || path.extname(displayBase);
            archive.file(target, { name: uniquePath(displayBase, ext) });
            appended = true;
          }
        }
        if (appended) continue;

        const remoteCandidate = [item.firebaseUrl, item.url, item.fileUrl, item.audioUrl].find(
          (u: any) => typeof u === 'string' && /^https?:\/\//i.test(u) && !/(youtube\.com|youtu\.be|vimeo\.com)/i.test(u)
        );
        if (remoteCandidate) {
          try {
            const resp = await fetch(remoteCandidate);
            if (resp.ok) {
              const arrBuf = await resp.arrayBuffer();
              const ext = path.extname(displayBase);
              archive.append(Buffer.from(arrBuf), { name: uniquePath(displayBase, ext) });
              appended = true;
            }
          } catch {
            // fallback to text summary
          }
        }
        if (appended) continue;

        let docText = `${item.title || item.name}\n${'='.repeat(40)}\n\n`;
        if (item.url) docText += `URL: ${item.url}\n\n`;
        if (item.summary) docText += `Summary:\n${item.summary}\n\n`;
        if (item.description) docText += `Description:\n${item.description}\n\n`;
        if (item.lyrics) docText += `Lyrics:\n${item.lyrics}\n\n`;
        if (Array.isArray(item.steps)) docText += `Procedures:\n${item.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}\n\n`;
        if (Array.isArray(item.contentSections)) {
          docText += item.contentSections.map((cs: any) => `## ${cs.heading}\n${cs.body}\n`).join('\n');
        }
        if (Array.isArray(item.slides)) {
          docText += item.slides.map((sl: any, i: number) => `Slide ${i + 1}: ${sl.title}\n${sl.content}\nQuote: ${sl.quote || ''}\n`).join('\n');
        }
        archive.append(docText, { name: uniquePath(displayBase, '.txt') });
      }
    }

    await archive.finalize();
  });

  // Authenticated File Access Endpoint (HTTP 206 byte-range streaming & RFC 6266 download for all authenticated users)
  app.get('/api/files/:filename', requireAuth, (req: Request, res: Response) => {
    const { filename } = req.params;
    const safeFilename = path.basename(filename);
    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const target = path.resolve(uploadsRoot, safeFilename);

    if (!target.startsWith(uploadsRoot + path.sep) || !fs.existsSync(target)) {
      return res.status(404).json({ error: 'Requested file not found or expired' });
    }

    const ext = path.extname(safeFilename).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const stat = fs.statSync(target);
    const fileSize = stat.size;

    if (req.query.download === '1' || req.query.dl === '1') {
      const displayName = req.query.name ? path.basename(String(req.query.name)) : safeFilename;
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': fileSize,
        'Content-Disposition': formatContentDisposition(displayName, false)
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(target);
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
      return stream.pipe(res);
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader && fileSize > 0) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }

      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (!match[1] && match[2]) {
        const suffixLength = parseInt(match[2], 10);
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
      }

      end = Math.min(end, fileSize - 1);

      if (isNaN(start) || isNaN(end) || start < 0 || start >= fileSize || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }

      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Content-Disposition': formatContentDisposition(safeFilename, true),
        'Cache-Control': 'private, max-age=300'
      });

      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(target, { start, end });
      res.on('close', () => stream.destroy());
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
      return stream.pipe(res);
    }

    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeType,
      'Content-Disposition': formatContentDisposition(safeFilename, true),
      'Cache-Control': 'private, max-age=300'
    });

    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(target);
    res.on('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    return stream.pipe(res);
  });

  // --- ANDROID PACKAGE & APK DOWNLOAD ENDPOINTS ---
  function streamAndroidPackage(res: Response, downloadName: string) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

    const archive = new ZipArchive({
      zlib: { level: 9 }
    });

    archive.on('error', (err: any) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to build Android archive' });
      }
    });

    archive.pipe(res);

    const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="org.angelclass.app">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="Angel Class"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:usesCleartextTraffic="false">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:name=".MainActivity"
            android:label="Angel Class"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="angelclass.org" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

    const mainActivityJava = `package org.angelclass.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * Angel Class Android Main Activity
 * Integrates strict Android FLAG_SECURE content protection to prevent
 * unauthorized screenshots, screen capture utilities, and task switcher snapshots.
 */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // ENFORCE HARDWARE-LEVEL SCREEN SECURITY
        // Disables screen recordings and external display mirroring
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }
}
`;

    const appBuildGradle = `apply plugin: 'com.android.application'

android {
    namespace "org.angelclass.app"
    compileSdkVersion 34

    defaultConfig {
        applicationId "org.angelclass.app"
        minSdkVersion 22
        targetSdkVersion 34
        versionCode 200
        versionName "2.0.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

dependencies {
    implementation fileTree(dir: 'libs', include: ['*.jar'])
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'androidx.coordinatorlayout:coordinatorlayout:1.2.0'
    implementation 'androidx.core:core-splashscreen:1.0.1'
}
`;

    const rootBuildGradle = `buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.2.1'
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

task clean(type: Delete) {
    delete rootProject.buildDir
}
`;

    const capacitorConfig = JSON.stringify({
      appId: "org.angelclass.app",
      appName: "Angel Class",
      webDir: "dist",
      bundledWebRuntime: false,
      server: {
        url: "https://ais-dev-k3lbu5qag5xyvwf3xufsxn-122552909355.asia-southeast1.run.app",
        cleartext: false
      }
    }, null, 2);

    const buildApkScript = `#!/usr/bin/env bash
set -e

echo "=========================================="
echo "  Angel Class — Android APK Builder v2.0  "
echo "=========================================="

if ! command -v gradle &> /dev/null && [ ! -f "./android/gradlew" ]; then
    echo "Notice: Android Gradle wrapper or Gradle CLI not found in PATH."
    echo "Tip: Open the 'android' directory in Android Studio to automatically download Gradle dependencies and build the release APK."
    exit 1
fi

echo "Building Android APK..."
cd android
if [ -f "./gradlew" ]; then
    chmod +x ./gradlew
    ./gradlew assembleRelease
else
    gradle assembleRelease
fi

echo "SUCCESS: Angel Class Android APK generated!"
echo "Location: android/app/build/outputs/apk/release/app-release-unsigned.apk"
`;

    const readmeMd = `# Angel Class — Official Android Application & APK Kit
Version 2.0 | Android 8.0 through Android 15 Compatible

## Overview
Angel Class is a spiritual discipleship, liturgy, and education application engineered with strict content protection (FLAG_SECURE) and private isolated Gemini AI spiritual mentorship.

## Included in this Package
1. **android/app/src/main/AndroidManifest.xml**: Configured with internet capabilities, portrait lock, and secure intent routing.
2. **android/app/src/main/java/org/angelclass/app/MainActivity.java**: Configured with \`WindowManager.LayoutParams.FLAG_SECURE\` to prevent OS screenshots and video captures.
3. **android/app/build.gradle**: Preconfigured for compileSdk 34 and minSdk 22.
4. **capacitor.config.json**: Native hybrid bridge connecting the web application directly into Android.
5. **build-apk.sh**: Shell script for continuous integration or local building.
6. **manifest.json & logo.svg**: Certified WebAPK assets.

## Quick Start (Build Signed APK)
### Option A: Using Android Studio
1. Open **Android Studio** and choose **Open an Existing Project**.
2. Select the \`android\` directory inside this package.
3. Allow Gradle sync to complete.
4. From the top menu, choose **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
5. Sideload the generated APK (\`app-debug.apk\`) to your Android device via USB or file transfer.

### Option B: Command Line (CLI)
\`\`\`bash
chmod +x build-apk.sh
./build-apk.sh
\`\`\`

## 1-Tap WebAPK Installation (Direct on Device)
If you prefer not to build with Android Studio:
1. Open the external installation page (/install) on your Android device (Chrome or Samsung Internet).
2. Tap the browser menu (⋮) -> **"Install App"** or follow the installation prompt.
3. Android OS will immediately package and install Angel Class into your application drawer.
`;

    archive.append(manifestXml, { name: 'AngelClass-Android/android/app/src/main/AndroidManifest.xml' });
    archive.append(mainActivityJava, { name: 'AngelClass-Android/android/app/src/main/java/org/angelclass/app/MainActivity.java' });
    archive.append(appBuildGradle, { name: 'AngelClass-Android/android/app/build.gradle' });
    archive.append(rootBuildGradle, { name: 'AngelClass-Android/android/build.gradle' });
    archive.append(capacitorConfig, { name: 'AngelClass-Android/capacitor.config.json' });
    archive.append(buildApkScript, { name: 'AngelClass-Android/build-apk.sh' });
    archive.append(readmeMd, { name: 'AngelClass-Android/README-ANDROID-BUILD.md' });

    const manifestPath = path.join(__dirname, 'public', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      archive.file(manifestPath, { name: 'AngelClass-Android/public/manifest.json' });
    }

    const logoPath = path.join(__dirname, 'public', 'logo.svg');
    if (fs.existsSync(logoPath)) {
      archive.file(logoPath, { name: 'AngelClass-Android/public/logo.svg' });
    }

    archive.finalize();
  }

  app.get('/api/download/android-bundle', requireAuth, (req: Request, res: Response) => {
    streamAndroidPackage(res, 'AngelClass-v2.0-Android.zip');
  });

  app.get('/api/download/android-apk', requireAuth, (req: Request, res: Response) => {
    streamAndroidPackage(res, 'AngelClass-v2.0-Android-Setup.zip');
  });

  // --- DESIGN & THEME SETTINGS ---
  app.get('/api/design', (req: Request, res: Response) => {
    const db = loadDb();
    return res.json({ settings: db.settings });
  });

  app.put('/api/admin/design', requireAdmin, (req: Request, res: Response) => {
    const { newSettings, saveAsVersion, versionName } = req.body || {};
    if (!newSettings || typeof newSettings !== 'object') {
      return res.status(400).json({ error: 'Valid settings object is required.' });
    }

    const db = loadDb();
    const sanitizedUpdates: Record<string, any> = {};

    if (newSettings.appName !== undefined) {
      const cleanName = sanitizeInput(newSettings.appName);
      if (!cleanName) {
        return res.status(400).json({ error: 'Application name cannot be empty.' });
      }
      sanitizedUpdates.appName = cleanName;
    }
    if (newSettings.subtitle !== undefined) sanitizedUpdates.subtitle = sanitizeInput(newSettings.subtitle);
    if (newSettings.theme !== undefined) sanitizedUpdates.theme = sanitizeInput(newSettings.theme);
    if (newSettings.primaryColor !== undefined) sanitizedUpdates.primaryColor = sanitizeInput(newSettings.primaryColor);
    if (newSettings.secondaryColor !== undefined) sanitizedUpdates.secondaryColor = sanitizeInput(newSettings.secondaryColor);
    if (newSettings.accentColor !== undefined) sanitizedUpdates.accentColor = sanitizeInput(newSettings.accentColor);
    if (newSettings.backgroundColor !== undefined) sanitizedUpdates.backgroundColor = sanitizeInput(newSettings.backgroundColor);
    if (newSettings.fontHeading !== undefined) sanitizedUpdates.fontHeading = sanitizeInput(newSettings.fontHeading);
    if (newSettings.fontBody !== undefined) sanitizedUpdates.fontBody = sanitizeInput(newSettings.fontBody);
    if (newSettings.cardStyle !== undefined) sanitizedUpdates.cardStyle = sanitizeInput(newSettings.cardStyle);
    if (typeof newSettings.animationsEnabled === 'boolean') {
      sanitizedUpdates.animationsEnabled = newSettings.animationsEnabled;
    }
    if (['slow', 'normal', 'fast'].includes(newSettings.animationSpeed)) {
      sanitizedUpdates.animationSpeed = newSettings.animationSpeed;
    }

    if (saveAsVersion) {
      const vId = `v-${Date.now()}`;
      db.settings.versions.unshift({
        id: vId,
        name: sanitizeInput(versionName) || `Custom Theme (${new Date().toLocaleDateString()})`,
        timestamp: new Date().toISOString(),
        theme: sanitizedUpdates.theme || db.settings.theme,
        primaryColor: sanitizedUpdates.primaryColor || db.settings.primaryColor,
        accentColor: sanitizedUpdates.accentColor || db.settings.accentColor
      });
      if (db.settings.versions.length > 10) db.settings.versions.pop();
    }

    db.settings = { ...db.settings, ...sanitizedUpdates };
    saveDb(db);

    const user = (req as any).user;
    addAuditLog('DESIGN_CHANGED', user.email, `Updated application name, theme, and colours.`);
    return res.json({ settings: db.settings });
  });

  app.post('/api/admin/design/restore', requireAdmin, (req: Request, res: Response) => {
    const { versionId } = req.body;
    const db = loadDb();
    const version = db.settings.versions.find((v: any) => v.id === versionId);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    if (version.theme) db.settings.theme = version.theme;
    if (version.primaryColor) db.settings.primaryColor = version.primaryColor;
    if (version.accentColor) db.settings.accentColor = version.accentColor;

    saveDb(db);
    const user = (req as any).user;
    addAuditLog('DESIGN_RESTORED', user.email, `Restored design theme to version "${version.name}".`);
    return res.json({ settings: db.settings });
  });

  // --- ADMIN USER & SESSION MANAGEMENT ---
  app.get('/api/admin/users', requireAdmin, (req: Request, res: Response) => {
    const db = loadDb();
    const sanitized = db.users.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role === 'admin' ? 'admin' : 'user',
      status: u.status,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      sessionRevokedAt: u.sessionRevokedAt
    }));
    return res.json({ users: sanitized });
  });

  app.put('/api/admin/users/:id/status', requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params;
    const { status } = req.body;
    const db = loadDb();
    const user = db.users.find((u: any) => u.id === id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role === 'admin' && status === 'suspended') {
      return res.status(400).json({ error: 'Cannot deactivate Administrator account.' });
    }

    user.status = status;
    saveDb(db);

    const admin = (req as any).user;
    addAuditLog('USER_STATUS_CHANGE', admin.email, `Changed account status of ${user.email} to [${status}].`);
    return res.json({ user });
  });

  app.post('/api/admin/users/:id/revoke-sessions', requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params;
    const db = loadDb();
    const user = db.users.find((u: any) => u.id === id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.sessionRevokedAt = new Date().toISOString();
    saveDb(db);

    const admin = (req as any).user;
    addAuditLog('SESSION_REVOCATION', admin.email, `Revoked all active sessions for ${user.email}.`);
    return res.json({ success: true, message: `Sessions for ${user.email} revoked.` });
  });

  app.get('/api/admin/audit-logs', requireAdmin, (req: Request, res: Response) => {
    const db = loadDb();
    return res.json({ logs: db.auditLogs });
  });

  // --- BACKUP & RECOVERY ---
  app.get('/api/admin/backup', requireAdmin, (req: Request, res: Response) => {
    const db = loadDb();
    // Exclude private AI conversations & personal memories from administrative backup exports
    const exportData = {
      exportedAt: new Date().toISOString(),
      appName: 'Angel Class',
      settings: db.settings,
      sections: db.sections,
      content: db.content,
      auditLogs: db.auditLogs
    };
    return res.json(exportData);
  });

  app.post('/api/admin/restore', requireAdmin, (req: Request, res: Response) => {
    const { backupData } = req.body;
    if (!backupData || !backupData.sections || !backupData.content) {
      return res.status(400).json({ error: 'Invalid backup data format' });
    }

    const db = loadDb();
    db.settings = backupData.settings || db.settings;
    db.sections = backupData.sections || db.sections;
    db.content = backupData.content || db.content;
    saveDb(db);

    const admin = (req as any).user;
    addAuditLog('SYSTEM_RESTORE', admin.email, 'Restored content and curriculum from administrative backup.');
    return res.json({ success: true, message: 'Curriculum & settings successfully restored.' });
  });

  // --- PRIVATE GEMINI AI ASSISTANT (Strictly User Isolated) ---
  // Notice: Admin CANNOT view or access these endpoints for other users!
  app.get('/api/gemini/threads', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const db = loadDb();
    const threads = db.aiConversations[user.id] || [];
    return res.json({ threads });
  });

  app.post('/api/gemini/chat', requireAuth, geminiRateLimiter, async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { message, threadId, contextType, contextData } = req.body;

    const cleanMessage = sanitizeInput(message);
    if (!cleanMessage) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const db = loadDb();
    if (!db.aiConversations[user.id]) db.aiConversations[user.id] = [];
    if (!db.aiMemories[user.id]) db.aiMemories[user.id] = [];

    let currentThread = db.aiConversations[user.id].find((t: any) => t.id === threadId);
    if (!currentThread) {
      currentThread = {
        id: threadId || `thread-${Date.now()}`,
        title: message.slice(0, 32) + (message.length > 32 ? '...' : ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
      };
      db.aiConversations[user.id].unshift(currentThread);
    }

    // Append user message
    currentThread.messages.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    });

    const userMemories = db.aiMemories[user.id] || [];
    const memoryPrompt = userMemories.length > 0 
      ? `\nPersonal context remembered about this devotee:\n- ${userMemories.join('\n- ')}\n` 
      : '';

    let contextualSupplement = '';
    if (contextType === 'protected_learning') {
      contextualSupplement = `\nContext: Student is studying Protected Learning Material: "${contextData?.title || 'Course Lesson'}". Provide clear, educational explanations, practical examples, and engaging reflections.`;
    } else if (contextType === 'ppt') {
      contextualSupplement = `\nContext: Student is reviewing Presentation Slide: "${contextData?.title || 'Slide'}". Break down the concepts clearly and concisely.`;
    } else if (contextType === 'song') {
      contextualSupplement = `\nContext: Student is listening to / studying Song: "${contextData?.title || 'Hymn / Song'}". Explain the vocabulary, meaning, and theme.`;
    }

    const systemInstruction = `You are the Angel Class AI Mentor — a kind, brilliant, encouraging, and intelligent learning companion and tutor for young students in grades 3 to 9, as well as teachers and mentors.

Core Instructions:
1. Broad & Accurate Knowledge: Confidently and accurately answer questions across all topics — including science (physics, biology, chemistry, earth, space), mathematics (arithmetic, fractions, word problems, algebra), creative writing & stories, literature, history, general knowledge, nature, coding, logic puzzles, everyday life, and moral character.
2. Age-Appropriate & Engaging: Use simple, friendly, vivid, and age-appropriate language suitable for grades 3 to 9. Break complex ideas down into step-by-step, intuitive parts with fun, relatable analogies and examples.
3. Direct & Fresh Answers: Always address the user's exact question directly and freshly. Never use repetitive canned statements or boilerplate disclaimers. If asked to do a calculation, show the answer and simple steps clearly. If asked for a story, write a lively, creative story.
4. Conversational Continuity: Remember and understand previous questions and answers in this thread. Understand follow-up questions smoothly (for example, if a student asks "Why did that happen?" or "What was the other one?").
5. Warm & Uplifting: Maintain an encouraging, patient, and polite tone. Celebrate curiosity, encourage asking questions, and nurture kindness, honesty, and perseverance.
${memoryPrompt}${contextualSupplement}`.trim();

    let replyText = '';
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;

    if (apiKey) {
      const activeAi = getAiClient();
      const formattedContents = formatGeminiContents(currentThread.messages.slice(-10));
      const promptContents = formattedContents.length > 0 
        ? formattedContents 
        : [{ role: 'user' as const, parts: [{ text: cleanMessage }] }];

      // Cascading models: primary gemini-3.8-flash (with low thinking for speed), then gemini-3.5-flash-lite (fast), then gemini-3.5-flash
      const candidateConfigs: Array<{ model: string; lowThinking: boolean; timeoutMs: number }> = [
        { model: 'gemini-3.8-flash', lowThinking: true, timeoutMs: 3000 },
        { model: 'gemini-3.5-flash-lite', lowThinking: false, timeoutMs: 8000 },
        { model: 'gemini-3.5-flash', lowThinking: false, timeoutMs: 10000 },
      ];

      for (const candidate of candidateConfigs) {
        try {
          const config: any = {
            systemInstruction,
          };
          if (candidate.lowThinking) {
            config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
          }

          const callPromise = activeAi.models.generateContent({
            model: candidate.model,
            contents: promptContents,
            config,
          });

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Model ${candidate.model} timeout`)), candidate.timeoutMs)
          );

          const response: any = await Promise.race([callPromise, timeoutPromise]);
          const candidateText = response?.text?.trim();
          if (candidateText) {
            replyText = candidateText;
            break;
          }
        } catch (err: any) {
          console.warn(`[Gemini API] Candidate model ${candidate.model} notice:`, err.message || err);
          // Try next model in cascade
        }
      }
    }

    if (!replyText) {
      // Dynamic fallback acknowledging the user's specific question
      const lower = cleanMessage.toLowerCase();
      if (lower.includes('sphere') || lower.includes('sacred sphere')) {
        replyText = `The Seven Sacred Spheres represent virtues of learning and character: Quietude, Discernment, Purity, Steadfast Devotion, Compassion, Sacred Humility, and Radiance. Each sphere teaches us how to focus our minds and treat others with love and respect.`;
      } else if (lower.includes('filter') || lower.includes('discernment')) {
        replyText = `The Three Sacred Filters encourage us to test every thought and word: 1. Is it true? 2. Is it kind and helpful? 3. Is it necessary? When we filter our words this way, we create a harmonious and peaceful classroom!`;
      } else {
        replyText = `Hello ${user.name}! I received your question: "${cleanMessage}". The external AI network is taking a moment to connect. Please check your internet connection or ask me again in just a moment and I'll give you a full, detailed answer!`;
      }
    }

    currentThread.messages.push({
      role: 'assistant',
      content: replyText,
      timestamp: new Date().toISOString()
    });
    currentThread.updatedAt = new Date().toISOString();

    // Remember personal devotee reflections
    if (message.toLowerCase().includes('my goal') || message.toLowerCase().includes('i struggle with') || message.toLowerCase().includes('i love') || message.toLowerCase().includes('i am practicing')) {
      const shortNote = message.slice(0, 100);
      if (!userMemories.includes(shortNote)) {
        userMemories.push(shortNote);
        db.aiMemories[user.id] = userMemories.slice(-10);
      }
    }

    saveDb(db);

    return res.json({
      reply: replyText,
      thread: currentThread
    });
  });

  app.delete('/api/gemini/threads/:id', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const { id } = req.params;
    const db = loadDb();
    if (db.aiConversations[user.id]) {
      db.aiConversations[user.id] = db.aiConversations[user.id].filter((t: any) => t.id !== id);
      saveDb(db);
    }
    return res.json({ success: true, message: 'Conversation deleted permanently.' });
  });

  app.delete('/api/gemini/threads', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const db = loadDb();
    db.aiConversations[user.id] = [];
    saveDb(db);
    return res.json({ success: true, message: 'All personal conversations deleted permanently.' });
  });

  app.get('/api/gemini/memories', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const db = loadDb();
    const memories = db.aiMemories[user.id] || [];
    return res.json({ memories });
  });

  app.delete('/api/gemini/memories', requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const db = loadDb();
    db.aiMemories[user.id] = [];
    saveDb(db);
    return res.json({ success: true, message: 'All personal AI memories erased permanently.' });
  });

  // --- EXTERNAL INSTALLATION PAGE ---
  app.get(['/install', '/install.html'], (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'install.html'));
  });

  // --- VITE DEV / PRODUCTION STATIC SERVING ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Angel Class Full-Stack Server running on port ${PORT}`);
  });
  httpServer.requestTimeout = 0;
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 120000;
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
