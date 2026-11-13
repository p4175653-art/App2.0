export type UserRole = 'admin' | 'user';
export type AccountStatus = 'active' | 'suspended';

export interface User {
  id: string;
  name: string;
  email: string;
  phoneNumber?: string;
  emailVerified?: boolean;
  role: UserRole;
  status: AccountStatus;
  createdAt?: string;
  lastLogin?: string;
  lastLoginAt?: string;
  sessionRevokedAt?: string | null;
}

export interface SectionConfig {
  id: string;
  title: string;
  icon: string;
  description: string;
  order: number;
  visible: boolean;
  isCustom?: boolean;
  protected?: boolean;
}

export interface ThemeSettings {
  theme: string;
  appName: string;
  subtitle: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  fontHeading: string;
  fontBody: string;
  cardStyle: string;
  animationsEnabled: boolean;
  animationSpeed: 'slow' | 'normal' | 'fast';
  logoUrl: string;
  versions?: Array<{
    id: string;
    name: string;
    timestamp: string;
    theme: string;
    primaryColor: string;
    accentColor: string;
  }>;
}

export interface VideoItem {
  id: string;
  title: string;
  duration: string;
  instructor: string;
  url: string;
  thumbnail: string;
  description: string;
  dateAdded: string;
}

export interface ActivityItem {
  id: string;
  title: string;
  date: string;
  location: string;
  leader: string;
  description: string;
  capacity: number;
  enrolled: number;
}

export interface SopItem {
  id: string;
  code: string;
  title: string;
  category: string;
  version: string;
  summary: string;
  steps: string[];
}

export interface ScheduleItem {
  id: string;
  term: string;
  title: string;
  startDate: string;
  endDate: string;
  location: string;
  highlight: string;
}

export interface GameItem {
  id: string;
  title: string;
  category: string;
  difficulty: string;
  questionsCount: number;
  description: string;
  questions?: Array<{
    q: string;
    options: string[];
    correct: number;
    explanation: string;
  }>;
}

export interface PptSlide {
  title: string;
  content: string;
  quote?: string;
  themeColor?: string;
}

export interface PptItem {
  id: string;
  title: string;
  author: string;
  slideCount: number;
  isProtected: boolean;
  summary: string;
  slides: PptSlide[];
}

export interface MusicItem {
  id: string;
  title: string;
  artist: string;
  duration: string;
  audioUrl: string;
  description: string;
  lyrics: string;
}

export interface PhotoItem {
  id: string;
  title: string;
  url: string;
  caption: string;
  category: string;
  date: string;
}

export interface LearningItem {
  id: string;
  title: string;
  author: string;
  classification: string;
  isProtected: boolean;
  lastUpdated: string;
  summary: string;
  contentSections: Array<{
    heading: string;
    body: string;
  }>;
}

export interface CustomContentItem {
  id: string;
  title: string;
  description?: string;
  content?: string;
  category?: string;
  dateAdded?: string;
  fileUrl?: string;
}

export interface AuditLog {
  id: string;
  action: string;
  performedBy: string;
  details: string;
  timestamp: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface AiThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}
