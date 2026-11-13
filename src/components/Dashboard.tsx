import React, { useState } from 'react';
import {
  Video, Compass, ScrollText, CalendarDays, Sparkles, Presentation,
  Music, Images, BookOpenCheck, PlusCircle, Search, Link2, ArrowRight,
  Trash2, AlertTriangle, Loader2, CheckCircle2, AlertCircle, X
} from 'lucide-react';
import { SectionConfig } from '../types';
import { useAuth } from '../context/AuthContext';
import { useContent } from '../context/ContentContext';
import { deleteCurriculumSectionFromFirebase } from '../utils/firebaseMedia';
import { FolderView } from './FolderView';

interface DashboardProps {
  onOpenGemini: () => void;
  onOpenGeminiWithContext: (type: any, data: any) => void;
  onOpenAdminPortal?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  onOpenGeminiWithContext
}) => {
  const { user, token, checkSession } = useAuth();
  const { sections, settings, activeSectionId, setActiveSectionId, refreshSections, notifyContentChanged } = useContent();
  const [searchFilter, setSearchFilter] = useState('');
  const [confirmDeleteSection, setConfirmDeleteSection] = useState<SectionConfig | null>(null);
  const [deletingSection, setDeletingSection] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const isAdmin = user?.role === 'admin';

  const showFeedback = (text: string, type: 'success' | 'error' = 'success') => {
    setFeedback({ text, type });
    setTimeout(() => {
      setFeedback((curr) => (curr?.text === text ? null : curr));
    }, 4000);
  };

  // Resolve Navy Blue & Gold defaults unless explicitly customized by Admin
  const hasCustomPrimary = settings?.primaryColor && settings.primaryColor !== '#0F382A';
  const navyColor = hasCustomPrimary ? settings!.primaryColor : '#0B1F3A';
  const navyElevated = hasCustomPrimary ? settings!.primaryColor : '#122C4F';
  const goldColor = settings?.accentColor || '#D4AF37';
  const displayTitle =
    settings?.appName && settings.appName !== 'Angel Class'
      ? settings.appName
      : 'ANGLE CLASS';

  // Icon mapping for Dashboard folders
  const renderIcon = (iconName: string) => {
    const props = { className: 'w-5 h-5', style: { color: goldColor } };
    switch (iconName) {
      case 'Video':
        return <Video {...props} />;
      case 'Link':
        return <Link2 {...props} />;
      case 'Compass':
        return <Compass {...props} />;
      case 'ScrollText':
        return <ScrollText {...props} />;
      case 'CalendarDays':
        return <CalendarDays {...props} />;
      case 'Sparkles':
        return <Sparkles {...props} />;
      case 'Presentation':
        return <Presentation {...props} />;
      case 'Music':
        return <Music {...props} />;
      case 'Images':
        return <Images {...props} />;
      case 'BookOpenCheck':
        return <BookOpenCheck {...props} />;
      case 'PlusCircle':
        return <PlusCircle {...props} />;
      default:
        return <Sparkles {...props} />;
    }
  };

  const handleConfirmDeleteSection = async () => {
    if (!confirmDeleteSection || !isAdmin) return;
    let authToken = token || localStorage.getItem('angel_class_token') || '';
    if (!authToken) {
      await checkSession();
      authToken = localStorage.getItem('angel_class_token') || '';
    }
    if (!authToken) {
      setDeleteError('Session expired. Please sign in again to delete folders.');
      return;
    }

    setDeleteError(null);
    setDeletingSection(true);
    try {
      let res = await fetch(`/api/admin/sections/${confirmDeleteSection.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (res.status === 401) {
        const refreshed = await checkSession();
        const nextToken = localStorage.getItem('angel_class_token') || '';
        if (refreshed && nextToken) {
          res = await fetch(`/api/admin/sections/${confirmDeleteSection.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${nextToken}` }
          });
        }
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Failed to delete folder (HTTP ${res.status})`);
      }

      const fbRes = await deleteCurriculumSectionFromFirebase(confirmDeleteSection.id);
      if (!fbRes.success) {
        throw new Error(fbRes.error || 'Failed to remove cloud folder records.');
      }

      const deletedTitle = confirmDeleteSection.title;
      if (activeSectionId === confirmDeleteSection.id) {
        setActiveSectionId(null);
      }
      setConfirmDeleteSection(null);
      await notifyContentChanged();
      showFeedback(`Permanently deleted folder "${deletedTitle}".`);
    } catch (err: any) {
      setDeleteError(err.message || 'Folder deletion failed.');
    } finally {
      setDeletingSection(false);
    }
  };

  const activeSection = sections.find((s) => s.id === activeSectionId);

  // If a folder is opened, render the unified FolderView
  if (activeSection) {
    return (
      <FolderView
        section={activeSection}
        onBack={() => {
          setActiveSectionId(null);
          refreshSections();
        }}
        onOpenGeminiWithContext={onOpenGeminiWithContext}
      />
    );
  }

  // Filter visible folders according to user search
  const visibleSections = sections
    .filter((s) => s.visible !== false)
    .filter((s) =>
      searchFilter
        ? s.title.toLowerCase().includes(searchFilter.toLowerCase())
        : true
    )
    .sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-10 animate-fade-in">
      {/* Opening Hero Banner — Clean, Text-Focused Navy Blue & Gold */}
      <section
        className="rounded-2xl px-7 py-10 sm:px-12 sm:py-14 border shadow-lg"
        style={{
          background: `linear-gradient(145deg, ${navyColor} 0%, ${navyElevated} 100%)`,
          borderColor: `${goldColor}40`
        }}
      >
        <div className="max-w-3xl mx-auto text-center space-y-5">
          <h1
            className="font-serif-spiritual text-3xl sm:text-4xl lg:text-5xl font-bold tracking-[0.14em] leading-tight text-balance"
            style={{ color: goldColor }}
          >
            {displayTitle}
          </h1>

          <div
            className="w-16 h-px mx-auto"
            style={{ backgroundColor: `${goldColor}80` }}
            aria-hidden="true"
          />

          <p
            className="text-base sm:text-lg leading-relaxed text-[#F5F2EA] font-normal max-w-2xl mx-auto"
            style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 'clamp(1.125rem, 1.8vw, 1.35rem)' }}
          >
            Angle Class is a joyful space where children learn, grow and discover the beauty of kindness, respect, sharing and compassion. Through games, stories and meaningful experiences, we nurture good hearts and build a kinder world together.
          </p>
        </div>
      </section>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between gap-2 animate-fade-in ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-stone-400 hover:text-stone-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Folders Directory Directly Below Introduction */}
      <section className="space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#0B1F3A]/10 pb-3.5">
          <div className="flex items-center gap-2.5 text-sm font-medium text-[#0B1F3A]">
            <h2 className="font-serif-spiritual text-base sm:text-lg font-semibold tracking-wide text-[#0B1F3A]">
              Folders
            </h2>
            <span className="text-[#B89328]" aria-hidden="true">&middot;</span>
            <span className="text-xs text-slate-500 tabular-nums">
              {visibleSections.length} {visibleSections.length === 1 ? 'folder' : 'folders'}
            </span>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-2.5 pointer-events-none" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Search folders..."
              aria-label="Search folders"
              className="w-full pl-10 pr-3.5 py-2 text-xs rounded-xl bg-white border border-[#0B1F3A]/15 text-[#0B1F3A] placeholder:text-slate-400 focus:outline-none focus:border-[#D4AF37] transition-colors"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">
          {visibleSections.map((sec) => {
            const count = (sec as any).itemCount ?? 0;
            return (
              <div
                key={sec.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveSectionId(sec.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveSectionId(sec.id);
                  }
                }}
                className="group text-left rounded-2xl bg-white border border-[#0B1F3A]/10 p-5 sm:p-6 shadow-xs hover:shadow-md hover:border-[#D4AF37]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] transition-all duration-200 flex flex-col justify-between min-h-[144px] cursor-pointer"
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div
                      className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 transition-transform duration-200 group-hover:scale-105"
                      style={{
                        backgroundColor: navyColor,
                        borderColor: `${goldColor}55`
                      }}
                    >
                      {renderIcon(sec.icon)}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-500 tabular-nums whitespace-nowrap">
                        {count} {count === 1 ? 'item' : 'items'}
                      </span>

                      {isAdmin && sections.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteError(null);
                            setConfirmDeleteSection(sec);
                          }}
                          className="p-1.5 rounded-lg text-rose-600 bg-rose-50/70 hover:bg-rose-100 hover:text-rose-700 transition shrink-0"
                          title={`Delete folder "${sec.title}" permanently`}
                          aria-label={`Delete folder ${sec.title}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <h3 className="font-serif-spiritual text-base font-semibold text-[#0B1F3A] group-hover:text-[#16365E] transition-colors leading-snug">
                    {sec.title}
                  </h3>
                </div>

                <div className="mt-5 pt-3 border-t border-[#0B1F3A]/8 flex items-center justify-between text-xs font-medium text-[#0B1F3A]/75 group-hover:text-[#9E7B16] transition-colors">
                  <span>Open Folder</span>
                  <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Permanent Folder Delete Confirmation Modal (Admin Only) */}
      {confirmDeleteSection && isAdmin && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-md rounded-2xl bg-white border border-rose-200 shadow-2xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-serif-spiritual text-base font-bold text-stone-900">
                  Confirm Permanent Deletion
                </h3>
                <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                  Are you sure you want to permanently delete the folder{' '}
                  <strong>&quot;{confirmDeleteSection.title}&quot;</strong>? This removes the folder, its database records, and all stored files inside it permanently.
                </p>
              </div>
            </div>

            {deleteError && (
              <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{deleteError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={deletingSection}
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDeleteSection(null);
                }}
                className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingSection}
                onClick={handleConfirmDeleteSection}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow flex items-center gap-1.5 disabled:opacity-50"
              >
                {deletingSection ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>Delete Permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
