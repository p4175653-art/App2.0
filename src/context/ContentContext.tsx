import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { SectionConfig, ThemeSettings } from '../types';

interface ContentContextType {
  sections: SectionConfig[];
  settings: ThemeSettings | null;
  isLoading: boolean;
  activeSectionId: string | null;
  contentVersion: number;
  setActiveSectionId: (id: string | null) => void;
  refreshSections: () => Promise<void>;
  notifyContentChanged: () => Promise<void>;
  updateThemeSettings: (newSettings: Partial<ThemeSettings>) => void;
}

const ContentContext = createContext<ContentContextType | undefined>(undefined);

const STORAGE_KEY_SECTIONS = 'angel_class_cached_sections';
const STORAGE_KEY_SETTINGS = 'angel_class_cached_settings';

export const ContentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [sections, setSections] = useState<SectionConfig[]>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY_SECTIONS);
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });

  const [settings, setSettings] = useState<ThemeSettings | null>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY_SETTINGS);
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });

  const [isLoading, setIsLoading] = useState(true);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [contentVersion, setContentVersion] = useState(0);

  const fetchSections = useCallback(async () => {
    try {
      const res = await fetch('/api/sections');
      if (res.ok) {
        const data = await res.json();
        setSections(data.sections || []);
        setSettings(data.settings || null);
        localStorage.setItem(STORAGE_KEY_SECTIONS, JSON.stringify(data.sections));
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(data.settings));
      }
    } catch (err) {
      console.warn('Using offline cached sections and settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const notifyContentChanged = useCallback(async () => {
    setContentVersion((v) => v + 1);
    await fetchSections();
  }, [fetchSections]);

  useEffect(() => {
    fetchSections();
  }, [fetchSections]);

  // Apply Admin-configured application name, theme, and colours globally
  useEffect(() => {
    if (!settings) return;
    const appName = settings.appName?.trim() || 'Angel Class';
    document.title = appName;

    const root = document.documentElement;
    if (settings.primaryColor) {
      root.style.setProperty('--color-primary', settings.primaryColor);
      const themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) themeMeta.setAttribute('content', settings.primaryColor);
    }
    if (settings.accentColor) {
      root.style.setProperty('--color-accent', settings.accentColor);
    }
    if (settings.backgroundColor) {
      root.style.setProperty('--color-bg', settings.backgroundColor);
    }
  }, [settings]);

  const updateThemeSettings = (newSettings: Partial<ThemeSettings>) => {
    setSettings((prev) => {
      const updated = prev ? { ...prev, ...newSettings } : (newSettings as ThemeSettings);
      try {
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(updated));
      } catch {
        // ignore storage errors
      }
      return updated;
    });
  };

  return (
    <ContentContext.Provider
      value={{
        sections,
        settings,
        isLoading,
        activeSectionId,
        contentVersion,
        setActiveSectionId,
        refreshSections: fetchSections,
        notifyContentChanged,
        updateThemeSettings
      }}
    >
      {children}
    </ContentContext.Provider>
  );
};

export const useContent = () => {
  const context = useContext(ContentContext);
  if (!context) {
    throw new Error('useContent must be used within a ContentProvider');
  }
  return context;
};
