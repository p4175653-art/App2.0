import React, { useState, useEffect } from 'react';
import {
  ArrowLeft, Download, Upload, Trash2, CheckCircle2,
  FileText, Eye, Music, Video, Image as ImageIcon,
  FolderArchive, Loader2, Sparkles, X, Check, Clock,
  Link as LinkIcon, Bookmark, BookmarkCheck, Edit3, Plus,
  AlertCircle, Search, ExternalLink, AlertTriangle, Play, RotateCw
} from 'lucide-react';
import { SectionConfig } from '../types';
import { useAuth } from '../context/AuthContext';
import { useContent } from '../context/ContentContext';
import { UploadModal } from './UploadModal';
import { ProtectedViewerWrapper } from './ProtectedViewerWrapper';
import { AudioPlayer } from './AudioPlayer';
import { getYouTubeThumbnailUrl, isAudioFile, isVideoFile } from '../utils/videoThumbnail';
import {
  listCurriculumItemsFromFirestore,
  saveCurriculumItemToFirestore,
  deleteCurriculumItemFromFirebase
} from '../utils/firebaseMedia';

function parseVideoEmbed(rawUrl: string): { isEmbed: boolean; embedUrl: string } {
  if (!rawUrl) return { isEmbed: false, embedUrl: '' };
  try {
    const url = new URL(rawUrl.trim());
    const host = url.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
      if (url.pathname.startsWith('/embed/')) {
        const id = url.pathname.split('/embed/')[1]?.split(/[?&/]/)[0];
        if (id) return { isEmbed: true, embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1` };
      }
      if (url.pathname.startsWith('/shorts/')) {
        const id = url.pathname.split('/shorts/')[1]?.split(/[?&/]/)[0];
        if (id) return { isEmbed: true, embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1` };
      }
      if (url.pathname.startsWith('/live/')) {
        const id = url.pathname.split('/live/')[1]?.split(/[?&/]/)[0];
        if (id) return { isEmbed: true, embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1` };
      }
      const v = url.searchParams.get('v');
      if (v) {
        return { isEmbed: true, embedUrl: `https://www.youtube-nocookie.com/embed/${v}?rel=0&playsinline=1` };
      }
    } else if (host.includes('youtu.be')) {
      const id = url.pathname.replace(/^\//, '').split(/[?&/]/)[0];
      if (id) {
        return { isEmbed: true, embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1` };
      }
    } else if (host.includes('vimeo.com')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 1];
      if (id && !isNaN(Number(id))) {
        return { isEmbed: true, embedUrl: `https://player.vimeo.com/video/${id}` };
      }
    }
  } catch {
    if (rawUrl.includes('youtu.be/')) {
      const id = rawUrl.split('youtu.be/')[1]?.split(/[?&/]/)[0];
      if (id) return { isEmbed: true, embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1` };
    }
    if (rawUrl.includes('watch?v=')) {
      const id = rawUrl.split('watch?v=')[1]?.split(/[?&/]/)[0];
      if (id) return { isEmbed: true, embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1` };
    }
  }
  return { isEmbed: false, embedUrl: rawUrl };
}

interface FolderViewProps {
  section: SectionConfig;
  onBack: () => void;
  onOpenGeminiWithContext?: (type: any, data: any) => void;
}

export const FolderView: React.FC<FolderViewProps> = ({
  section,
  onBack,
  onOpenGeminiWithContext
}) => {
  const { user, token, firebaseUser, checkSession } = useAuth();
  const { contentVersion, notifyContentChanged } = useContent();
  const isAdmin = user?.role === 'admin';

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);

  // Add / Edit entry modal state
  const [showEntryModal, setShowEntryModal] = useState(false);
  const [editingItem, setEditingItem] = useState<any | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryForm, setEntryForm] = useState<Record<string, any>>({});

  // Viewer & confirmation states
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<any | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [downloadingItemId, setDownloadingItemId] = useState<string | null>(null);
  const [failedThumbIds, setFailedThumbIds] = useState<Record<string, boolean>>({});
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const [videoRetryKey, setVideoRetryKey] = useState(0);

  // Feedback banner
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showFeedback = (text: string, type: 'success' | 'error' = 'success') => {
    setFeedback({ text, type });
    setTimeout(() => {
      setFeedback((curr) => (curr?.text === text ? null : curr));
    }, 4000);
  };

  const getAuthToken = () => token || localStorage.getItem('angel_class_token') || '';

  const withAuthToken = (rawUrl?: string) => {
    if (!rawUrl) return '';
    if (!rawUrl.startsWith('/api/files/')) return rawUrl;
    const t = getAuthToken();
    if (!t) return rawUrl;
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}token=${encodeURIComponent(t)}`;
  };

  const isAudioEntry = (item: any) => {
    const rawUrl = (item?.audioUrl || item?.url || item?.fileUrl || item?.name || '').split('?')[0].toLowerCase();
    if (section.id === 'music' && !rawUrl.match(/\.(pdf|png|jpg|jpeg|webp|svg|mp4|webm|mov|m4v|3gp|mkv|ppt|pptx|doc|docx|txt)$/)) {
      return true;
    }
    return Boolean(item?.audioUrl || isAudioFile({ name: rawUrl, type: item?.type }));
  };

  const isVideoEntry = (item: any) => {
    const fullUrl = item?.url || item?.fileUrl || '';
    const rawUrl = fullUrl.split('?')[0].toLowerCase() || (item?.name || '').toLowerCase();
    if (parseVideoEmbed(fullUrl).isEmbed) return true;
    if ((section.id === 'videos' || section.id === 'video-links') && !rawUrl.match(/\.(pdf|png|jpg|jpeg|webp|svg|mp3|wav|ogg|m4a|aac|flac|opus|ppt|pptx|doc|docx|txt)$/)) {
      return true;
    }
    return isVideoFile({ name: rawUrl, type: item?.type });
  };

  const canDownloadItem = (item: any) => {
    const rawUrl = item?.localUrl || item?.url || item?.audioUrl || item?.fileUrl || item?.downloadUrl || item?.firebaseUrl || '';
    if (rawUrl && parseVideoEmbed(rawUrl).isEmbed && !item?.localUrl && !item?.firebaseUrl) {
      return false;
    }
    return true;
  };

  const canUploadInSection = true;
  const canPasteLinkInSection = section.id === 'video-links' || section.id === 'videos';

  const getCardThumbnailUrl = (item: any): string | null => {
    if (failedThumbIds[item.id]) return null;
    if (item.thumbnail) return withAuthToken(item.thumbnail);
    const ytThumb = getYouTubeThumbnailUrl(item.url || item.fileUrl || item.firebaseUrl);
    if (ytThumb) return ytThumb;
    return null;
  };

  const [savedOfflineIds, setSavedOfflineIds] = useState<string[]>(() => {
    try {
      const c = localStorage.getItem('angel_class_saved_files');
      return c ? JSON.parse(c) : [];
    } catch {
      return [];
    }
  });

  const toggleOfflineSave = (itemId: string) => {
    const updated = savedOfflineIds.includes(itemId)
      ? savedOfflineIds.filter((id) => id !== itemId)
      : [...savedOfflineIds, itemId];
    setSavedOfflineIds(updated);
    try {
      localStorage.setItem('angel_class_saved_files', JSON.stringify(updated));
    } catch {
      // ignore
    }
  };

  const fetchContent = async (silent = false) => {
    if (!silent) setLoading(true);
    let authToken = getAuthToken();
    if (!authToken) {
      await checkSession();
      authToken = getAuthToken();
    }
    try {
      const [apiResult, firestoreItems] = await Promise.all([
        fetch(`/api/content/${section.id}`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
        }),
        listCurriculumItemsFromFirestore(section.id, isAdmin).catch(() => [])
      ]);

      let apiItems: any[] = [];
      if (apiResult.ok) {
        const data = await apiResult.json();
        apiItems = data.items || [];
      } else if (!silent && firestoreItems.length === 0) {
        const errData = await apiResult.json().catch(() => ({}));
        showFeedback(errData.error || 'Failed to load folder contents.', 'error');
      }

      // Merge Firestore & backend records deduplicated by ID so uploaded files persist across sessions
      const mergedMap = new Map<string, any>();
      for (const fbItem of firestoreItems) {
        if (fbItem?.id) mergedMap.set(fbItem.id, fbItem);
      }
      for (const apiItem of apiItems) {
        if (!apiItem?.id) continue;
        const existing = mergedMap.get(apiItem.id);
        mergedMap.set(
          apiItem.id,
          existing
            ? {
                ...existing,
                ...apiItem,
                firebaseUrl: apiItem.firebaseUrl || existing.firebaseUrl,
                storagePath: apiItem.storagePath || existing.storagePath,
                thumbnail: apiItem.thumbnail || existing.thumbnail
              }
            : apiItem
        );
      }

      const combined = Array.from(mergedMap.values()).sort((a, b) => {
        const ta = new Date(a.uploadedAt || a.createdAt || a.date || 0).getTime();
        const tb = new Date(b.uploadedAt || b.createdAt || b.date || 0).getTime();
        return tb - ta;
      });
      setItems(combined);
    } catch (err: any) {
      if (!silent) {
        showFeedback('Network error loading folder: ' + err.message, 'error');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    setSearch('');
    setSelectedItem(null);
    setVideoPlaybackError(null);
    fetchContent(false);
  }, [section.id, token]);

  useEffect(() => {
    if (firebaseUser?.uid) {
      fetchContent(true);
    }
  }, [firebaseUser?.uid]);

  useEffect(() => {
    if (contentVersion > 0) {
      fetchContent(true);
    }
  }, [contentVersion]);

  useEffect(() => {
    setVideoPlaybackError(null);
    setVideoRetryKey(0);
  }, [selectedItem?.id]);

  // Open Add Entry modal
  const openCreateModal = () => {
    setEditingItem(null);
    setEntryForm({
      title: '',
      description: '',
      url: '',
      audioUrl: '',
      instructor: user?.name || '',
      author: user?.name || '',
      artist: user?.name || '',
      leader: user?.name || '',
      duration: '',
      location: '',
      date: new Date().toISOString().split('T')[0],
      startDate: '',
      endDate: '',
      term: '',
      code: '',
      category: '',
      version: '1.0',
      difficulty: 'Standard',
      stepsText: '',
      lyrics: '',
      caption: ''
    });
    setShowEntryModal(true);
  };

  // Open Edit Modal pre-filled with existing item
  const openEditModal = (item: any) => {
    setEditingItem(item);
    setEntryForm({
      title: item.title || item.name || '',
      description: item.description || item.summary || item.highlight || item.caption || '',
      url: item.url || item.fileUrl || '',
      audioUrl: item.audioUrl || '',
      instructor: item.instructor || '',
      author: item.author || '',
      artist: item.artist || '',
      leader: item.leader || '',
      duration: item.duration || '',
      location: item.location || '',
      date: item.date || item.dateAdded || '',
      startDate: item.startDate || '',
      endDate: item.endDate || '',
      term: item.term || '',
      code: item.code || '',
      category: item.category || '',
      version: item.version || '',
      difficulty: item.difficulty || '',
      stepsText: Array.isArray(item.steps) ? item.steps.join('\n') : '',
      lyrics: item.lyrics || '',
      caption: item.caption || ''
    });
    setShowEntryModal(true);
  };

  // Save new or edited item
  const handleSaveEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entryForm.title?.trim()) {
      showFeedback('Title is required.', 'error');
      return;
    }

    const authToken = getAuthToken();
    if (!authToken) {
      showFeedback('Authentication required.', 'error');
      return;
    }

    setEntrySaving(true);
    try {
      const payload: Record<string, any> = {
        title: entryForm.title.trim(),
        name: entryForm.title.trim(),
        description: entryForm.description?.trim() || '',
        summary: entryForm.description?.trim() || ''
      };

      if (entryForm.url?.trim()) payload.url = entryForm.url.trim();
      if (entryForm.audioUrl?.trim()) payload.audioUrl = entryForm.audioUrl.trim();
      if (entryForm.instructor?.trim()) payload.instructor = entryForm.instructor.trim();
      if (entryForm.author?.trim()) payload.author = entryForm.author.trim();
      if (entryForm.artist?.trim()) payload.artist = entryForm.artist.trim();
      if (entryForm.leader?.trim()) payload.leader = entryForm.leader.trim();
      if (entryForm.duration?.trim()) payload.duration = entryForm.duration.trim();
      if (entryForm.location?.trim()) payload.location = entryForm.location.trim();
      if (entryForm.date?.trim()) payload.date = entryForm.date.trim();
      if (entryForm.startDate?.trim()) payload.startDate = entryForm.startDate.trim();
      if (entryForm.endDate?.trim()) payload.endDate = entryForm.endDate.trim();
      if (entryForm.term?.trim()) payload.term = entryForm.term.trim();
      if (entryForm.code?.trim()) payload.code = entryForm.code.trim();
      if (entryForm.category?.trim()) payload.category = entryForm.category.trim();
      if (entryForm.version?.trim()) payload.version = entryForm.version.trim();
      if (entryForm.difficulty?.trim()) payload.difficulty = entryForm.difficulty.trim();
      if (entryForm.lyrics?.trim()) payload.lyrics = entryForm.lyrics.trim();
      if (entryForm.caption?.trim()) payload.caption = entryForm.caption.trim();
      if (section.id === 'schedules' && entryForm.description?.trim()) {
        payload.highlight = entryForm.description.trim();
      }
      if (entryForm.stepsText?.trim()) {
        payload.steps = entryForm.stepsText
          .split('\n')
          .map((s: string) => s.trim())
          .filter(Boolean);
      }

      if (editingItem) {
        const res = await fetch(`/api/admin/content/${section.id}/${editingItem.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update item');

        if (data.item?.url || data.item?.firebaseUrl || data.item?.localUrl) {
          await saveCurriculumItemToFirestore(section.id, data.item);
        }
        setItems((prev) => prev.map((it) => (it.id === editingItem.id ? data.item : it)));
        if (selectedItem?.id === editingItem.id) setSelectedItem(data.item);
        showFeedback(`Updated "${data.item.title}" successfully.`);
      } else {
        const isVideoLinkSection = section.id === 'video-links' || (section.id === 'videos' && payload.url);
        if (section.id === 'video-links' && !payload.url) {
          showFeedback('Please paste a YouTube or direct video URL.', 'error');
          setEntrySaving(false);
          return;
        }
        const endpoint =
          section.id === 'video-links'
            ? '/api/content/video-links'
            : isVideoLinkSection
              ? '/api/content/videos'
              : `/api/admin/content/${section.id}`;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save entry');

        if (data.item?.url || data.item?.firebaseUrl || data.item?.localUrl) {
          await saveCurriculumItemToFirestore(section.id, data.item);
        }
        setItems((prev) => [data.item, ...prev]);
        showFeedback(`Added "${data.item.title}" to ${section.title}.`);
      }

      await notifyContentChanged();
      setShowEntryModal(false);
      setEditingItem(null);
    } catch (err: any) {
      showFeedback(err.message || 'Operation failed.', 'error');
    } finally {
      setEntrySaving(false);
    }
  };

  // Authenticated Download Helper (Android & Windows compatible)
  const triggerBlobDownload = async (
    endpointUrl: string,
    downloadFilename: string,
    fetchOptions?: RequestInit
  ) => {
    const authToken = getAuthToken();
    const res = await fetch(endpointUrl, {
      ...fetchOptions,
      headers: {
        ...(fetchOptions?.headers || {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      }
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Download failed (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = downloadFilename;
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Defer objectURL revocation so Android Chrome / WebView download manager completes handoff
    setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
  };

  const resolveDownloadFilename = (item: any, sourceUrl: string) => {
    const baseName = item.name || item.title || `${section.id}-file`;
    if (/\.[a-zA-Z0-9]{1,8}$/.test(baseName)) return baseName;
    try {
      const pathname = sourceUrl.startsWith('http')
        ? new URL(sourceUrl).pathname
        : sourceUrl.split('?')[0];
      const match = /\.[a-zA-Z0-9]{1,8}$/.exec(decodeURIComponent(pathname));
      return match ? `${baseName}${match[0]}` : baseName;
    } catch {
      const match = /\.[a-zA-Z0-9]{1,8}$/.exec(sourceUrl.split('?')[0]);
      return match ? `${baseName}${match[0]}` : baseName;
    }
  };

  // Streaming native download helper for individual files (handles arbitrary multi-GB sizes without RAM buffering)
  const triggerStreamDownload = async (endpointUrl: string, downloadFilename: string) => {
    let authToken = getAuthToken();
    if (!authToken) {
      await checkSession();
      authToken = getAuthToken();
    }
    if (!authToken) {
      throw new Error('Authentication required to download files.');
    }

    let headRes = await fetch(endpointUrl, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (headRes.status === 401) {
      const refreshed = await checkSession();
      const nextToken = getAuthToken();
      if (refreshed && nextToken) {
        authToken = nextToken;
        headRes = await fetch(endpointUrl, {
          method: 'HEAD',
          headers: { Authorization: `Bearer ${authToken}` }
        });
      }
    }
    if (!headRes.ok) {
      const errRes = await fetch(endpointUrl, {
        headers: { Authorization: `Bearer ${authToken}` }
      }).catch(() => null);
      const errData = errRes ? await errRes.json().catch(() => ({})) : {};
      throw new Error(errData.error || `Download failed (HTTP ${headRes.status})`);
    }

    const separator = endpointUrl.includes('?') ? '&' : '?';
    const authedStreamUrl = `${endpointUrl}${separator}token=${encodeURIComponent(authToken)}`;
    const link = document.createElement('a');
    link.href = authedStreamUrl;
    link.download = downloadFilename;
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadFile = async (item: any) => {
    if (!canDownloadItem(item)) {
      showFeedback('This video link is streamed from an external player.', 'error');
      return;
    }

    const primaryRaw = item.localUrl || item.url || item.audioUrl || item.fileUrl || item.downloadUrl || item.firebaseUrl || '';
    const fallbackRaw = item.firebaseUrl || (item.url && item.url !== primaryRaw ? item.url : '') || '';
    const filename = resolveDownloadFilename(item, primaryRaw || fallbackRaw);
    setDownloadingItemId(item.id);

    try {
      if (primaryRaw || fallbackRaw) {
        // Strip query params ONLY for internal /api/files/ paths; preserve ?alt=media&token=... for Firebase Storage
        const cleanPrimary = primaryRaw.startsWith('/api/files/') ? primaryRaw.split('?')[0] : primaryRaw;
        const cleanFallback = fallbackRaw.startsWith('/api/files/') ? fallbackRaw.split('?')[0] : fallbackRaw;
        const params = new URLSearchParams();
        if (cleanPrimary) params.set('url', cleanPrimary);
        if (cleanFallback && cleanFallback !== cleanPrimary) params.set('fallback', cleanFallback);
        params.set('name', filename);

        await triggerStreamDownload(`/api/download/file?${params.toString()}`, filename);
        showFeedback(`Downloading "${filename}"...`);
      } else {
        const lines = [
          `${item.title || item.name}`,
          '='.repeat(40),
          '',
          item.summary || item.description || item.highlight || '',
          item.location ? `Location: ${item.location}` : '',
          item.date ? `Date: ${item.date}` : '',
          item.startDate ? `Start Date: ${item.startDate}` : '',
          item.endDate ? `End Date: ${item.endDate}` : '',
          item.leader ? `Leader: ${item.leader}` : '',
          item.instructor ? `Instructor: ${item.instructor}` : '',
          item.author ? `Author: ${item.author}` : '',
          Array.isArray(item.steps) && item.steps.length > 0
            ? `\nSteps:\n${item.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`
            : '',
          item.lyrics ? `\nLyrics:\n${item.lyrics}` : ''
        ].filter(Boolean);

        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 15000);
        showFeedback(`Exported "${filename}.txt".`);
      }
    } catch (err: any) {
      showFeedback(err.message || 'Download failed.', 'error');
    } finally {
      setDownloadingItemId(null);
    }
  };

  const handleDownloadFolderZip = async () => {
    if (items.length === 0) return;
    setDownloadingZip(true);
    try {
      await triggerBlobDownload(
        `/api/download/folder/${section.id}`,
        `AngelClass-${section.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        }
      );
      showFeedback(`Downloaded all files in "${section.title}".`);
    } catch (err: any) {
      showFeedback(err.message || 'Download All failed.', 'error');
    } finally {
      setDownloadingZip(false);
    }
  };

  const handleApprove = async (itemId: string) => {
    const authToken = getAuthToken();
    if (!authToken) return;
    try {
      const res = await fetch(`/api/content/${section.id}/${itemId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ status: 'approved' })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Approval failed');
      }
      setItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, status: 'approved' } : item))
      );
      await notifyContentChanged();
      showFeedback('Item approved.');
    } catch (err: any) {
      showFeedback(err.message || 'Approval failed.', 'error');
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteItem) return;
    const itemToDelete = confirmDeleteItem;
    let authToken = getAuthToken();
    if (!authToken) {
      await checkSession();
      authToken = getAuthToken();
    }
    if (!authToken) {
      setDeleteError('Session expired. Please sign in again to delete files.');
      return;
    }

    setDeleteError(null);
    setDeletingId(itemToDelete.id);
    try {
      let res = await fetch(`/api/content/${section.id}/${itemToDelete.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (res.status === 401) {
        const refreshed = await checkSession();
        const nextToken = getAuthToken();
        if (refreshed && nextToken) {
          res = await fetch(`/api/content/${section.id}/${itemToDelete.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${nextToken}` }
          });
        }
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 404) {
        throw new Error(data.error || `Failed to delete item (HTTP ${res.status})`);
      }

      const fbRes = await deleteCurriculumItemFromFirebase(
        section.id,
        itemToDelete.id,
        itemToDelete.storagePath,
        itemToDelete.firebaseUrl,
        itemToDelete.thumbnail
      );
      if (!fbRes.success) {
        throw new Error(fbRes.error || 'Failed to delete item from cloud database.');
      }

      setItems((prev) => prev.filter((item) => item.id !== itemToDelete.id));
      if (selectedItem?.id === itemToDelete.id) setSelectedItem(null);
      setConfirmDeleteItem(null);
      await notifyContentChanged();
      showFeedback(`Permanently deleted "${itemToDelete.title || itemToDelete.name}".`);
    } catch (err: any) {
      const msg = err.message || 'Delete failed.';
      setDeleteError(msg);
      showFeedback(msg, 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const getItemIcon = (item: any) => {
    if (isVideoEntry(item)) {
      return <Video className="w-5 h-5 text-amber-600" />;
    }
    if (isAudioEntry(item)) {
      return <Music className="w-5 h-5 text-emerald-700" />;
    }
    const url = (item.url || item.name || '').toLowerCase();
    if (url.match(/\.(jpg|jpeg|png|webp|svg)$/) || section.id === 'photos') {
      return <ImageIcon className="w-5 h-5 text-amber-500" />;
    }
    return <FileText className="w-5 h-5 text-emerald-800" />;
  };

  const filteredItems = items.filter((item) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    const searchable = [
      item.title,
      item.name,
      item.description,
      item.summary,
      item.highlight,
      item.caption,
      item.instructor,
      item.author,
      item.artist,
      item.leader,
      item.location,
      item.category,
      item.code,
      item.term
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return searchable.includes(q);
  });

  const renderViewerBody = (item: any) => {
    const rawUrl = item.localUrl || item.url || item.fileUrl || item.firebaseUrl;
    const authMediaUrl = withAuthToken(rawUrl);
    const resolvedAudioRaw = item.audioUrl || (isAudioEntry(item) ? rawUrl : '');
    const authAudioUrl = withAuthToken(resolvedAudioRaw);
    const lowerUrl = (rawUrl || '').split('?')[0].toLowerCase();
    const isAud = isAudioEntry(item);
    const isVid = isVideoEntry(item);

    const bodyContent = (
      <div className="space-y-4">
        {/* Image Preview */}
        {rawUrl && (lowerUrl.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg)$/) || (section.id === 'photos' && !lowerUrl.match(/\.(pdf|mp4|webm|mp3|m4a|wav|ogg)$/))) && (
          <div className="rounded-xl overflow-hidden bg-black/5 flex items-center justify-center max-h-80">
            <img
              src={authMediaUrl}
              alt={item.title || item.name}
              className="max-h-80 w-auto object-contain rounded-xl"
            />
          </div>
        )}

        {/* Video Player & YouTube/Vimeo Embed */}
        {(() => {
          if (!rawUrl) return null;
          const embed = parseVideoEmbed(rawUrl);
          if (embed.isEmbed) {
            return (
              <div className="aspect-video w-full rounded-xl overflow-hidden bg-black shadow">
                <iframe
                  src={embed.embedUrl}
                  title={item.title}
                  className="w-full h-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            );
          }
          if (isVid) {
            const posterUrl = getCardThumbnailUrl(item) || undefined;
            return (
              <div className="rounded-xl overflow-hidden bg-black border border-stone-800 shadow-inner">
                <video
                  key={`${authMediaUrl}-${videoRetryKey}`}
                  src={authMediaUrl}
                  poster={posterUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={() => setVideoPlaybackError(null)}
                  onCanPlay={() => setVideoPlaybackError(null)}
                  onError={() =>
                    setVideoPlaybackError(
                      'Unable to play this video inside the browser. Verify the video URL or format and try again.'
                    )
                  }
                  className="w-full max-h-[60vh] rounded-xl bg-black"
                />
                {videoPlaybackError && (
                  <div className="p-3 bg-rose-950/90 text-rose-100 text-xs flex flex-wrap items-center justify-between gap-2 border-t border-rose-800">
                    <span>{videoPlaybackError}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        await checkSession();
                        setVideoPlaybackError(null);
                        setVideoRetryKey((k) => k + 1);
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
          }
          return null;
        })()}

        {/* Dedicated Audio Player */}
        {authAudioUrl && isAud && (
          <AudioPlayer
            src={authAudioUrl}
            title={item.title || item.name}
            fallbackDuration={item.duration}
            onRefreshSession={checkSession}
          />
        )}

        {/* PDF Inline Preview */}
        {rawUrl && lowerUrl.endsWith('.pdf') && (
          <div className="w-full h-96 rounded-xl overflow-hidden border border-stone-200 bg-stone-100">
            <iframe
              src={authMediaUrl}
              title={item.title || item.name}
              className="w-full h-full border-0"
            />
          </div>
        )}

        {/* External Resource Link (non-video/non-audio generic web resources only) */}
        {rawUrl && (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) && !isVid && !isAud && !parseVideoEmbed(rawUrl).isEmbed && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-2 text-xs">
            <span className="text-emerald-900 font-mono truncate">{rawUrl}</span>
            <a
              href={rawUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1 rounded-lg bg-[#0F382A] text-amber-200 font-semibold inline-flex items-center gap-1 shrink-0"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Open Link</span>
            </a>
          </div>
        )}

        {/* Metadata Pills Grid */}
        {(item.code || item.category || item.version || item.term || item.location || item.date || item.startDate || item.leader || item.instructor || item.author || item.artist) && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            {item.code && (
              <div className="p-2.5 rounded-xl bg-stone-50 border border-stone-200">
                <span className="text-[10px] uppercase text-stone-400 font-bold block">Code</span>
                <span className="font-semibold text-stone-800">{item.code}</span>
              </div>
            )}
            {item.category && (
              <div className="p-2.5 rounded-xl bg-stone-50 border border-stone-200">
                <span className="text-[10px] uppercase text-stone-400 font-bold block">Category</span>
                <span className="font-semibold text-stone-800">{item.category}</span>
              </div>
            )}
            {item.term && (
              <div className="p-2.5 rounded-xl bg-stone-50 border border-stone-200">
                <span className="text-[10px] uppercase text-stone-400 font-bold block">Term</span>
                <span className="font-semibold text-stone-800">{item.term}</span>
              </div>
            )}
            {(item.startDate || item.date) && (
              <div className="p-2.5 rounded-xl bg-stone-50 border border-stone-200">
                <span className="text-[10px] uppercase text-stone-400 font-bold block">Date</span>
                <span className="font-semibold text-stone-800">
                  {item.startDate && item.endDate ? `${item.startDate} to ${item.endDate}` : (item.date || item.startDate)}
                </span>
              </div>
            )}
            {item.location && (
              <div className="p-2.5 rounded-xl bg-stone-50 border border-stone-200">
                <span className="text-[10px] uppercase text-stone-400 font-bold block">Location</span>
                <span className="font-semibold text-stone-800">{item.location}</span>
              </div>
            )}
            {(item.instructor || item.author || item.artist || item.leader) && (
              <div className="p-2.5 rounded-xl bg-stone-50 border border-stone-200">
                <span className="text-[10px] uppercase text-stone-400 font-bold block">Contributor</span>
                <span className="font-semibold text-stone-800">
                  {item.instructor || item.author || item.artist || item.leader}
                </span>
              </div>
            )}
          </div>
        )}

        {item.summary && (
          <div>
            <h5 className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-1">Summary</h5>
            <p className="text-xs text-stone-700 leading-relaxed bg-stone-50 p-3 rounded-xl border border-stone-200 whitespace-pre-line">
              {item.summary}
            </p>
          </div>
        )}

        {item.description && item.description !== item.summary && (
          <div>
            <h5 className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-1">Description</h5>
            <p className="text-xs text-stone-700 leading-relaxed bg-stone-50 p-3 rounded-xl border border-stone-200 whitespace-pre-line">
              {item.description}
            </p>
          </div>
        )}

        {item.caption && item.caption !== item.description && (
          <div>
            <h5 className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-1">Caption</h5>
            <p className="text-xs text-stone-700 leading-relaxed bg-stone-50 p-3 rounded-xl border border-stone-200">
              {item.caption}
            </p>
          </div>
        )}

        {item.lyrics && (
          <div>
            <h5 className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-1">Lyrics</h5>
            <p className="text-xs text-stone-700 leading-relaxed bg-stone-50 p-3 rounded-xl border border-stone-200 whitespace-pre-line">
              {item.lyrics}
            </p>
          </div>
        )}

        {Array.isArray(item.steps) && item.steps.length > 0 && (
          <div>
            <h5 className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-1">Procedure Steps</h5>
            <ol className="space-y-1.5 list-decimal list-inside text-xs text-stone-700 bg-stone-50 p-3 rounded-xl border border-stone-200">
              {item.steps.map((st: string, idx: number) => (
                <li key={idx} className="leading-relaxed">{st}</li>
              ))}
            </ol>
          </div>
        )}

        {Array.isArray(item.slides) && item.slides.length > 0 && (
          <div>
            <h5 className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-1">
              Slides ({item.slides.length})
            </h5>
            <div className="space-y-2">
              {item.slides.map((sl: any, idx: number) => (
                <div key={idx} className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs">
                  <p className="font-bold text-[#0F382A]">Slide {idx + 1}: {sl.title}</p>
                  <p className="text-stone-600 mt-1 whitespace-pre-line">{sl.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );

    if (section.protected || item.isProtected) {
      return (
        <ProtectedViewerWrapper
          title={item.title || item.name}
          classification={section.id.toUpperCase()}
          onAskGemini={
            onOpenGeminiWithContext
              ? () => {
                  setSelectedItem(null);
                  onOpenGeminiWithContext(section.id === 'ppt' ? 'ppt' : 'protected_learning', item);
                }
              : undefined
          }
        >
          {bodyContent}
        </ProtectedViewerWrapper>
      );
    }

    return bodyContent;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Navigation & Action Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-stone-200 text-xs font-semibold text-stone-700 hover:bg-stone-50 shadow-sm transition"
          >
            <ArrowLeft className="w-4 h-4 text-emerald-800" />
            <span>Dashboard</span>
          </button>

          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-serif-spiritual text-2xl font-bold text-[#0F382A]">
                {section.title}
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/15 text-amber-900 border border-amber-400/40">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
            </div>
          </div>
        </div>

        {/* Folder Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          {(isAdmin || canPasteLinkInSection) && (
            <button
              onClick={openCreateModal}
              className="flex-1 sm:flex-initial px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-emerald-950 font-bold text-xs tracking-wide shadow-sm transition flex items-center justify-center gap-1.5"
            >
              {canPasteLinkInSection ? (
                <LinkIcon className="w-4 h-4 text-emerald-950" />
              ) : (
                <Plus className="w-4 h-4 text-emerald-950" />
              )}
              <span>{canPasteLinkInSection ? 'Paste Video Link' : 'Add Entry'}</span>
            </button>
          )}

          {canUploadInSection && (
            <button
              onClick={() => setShowUploadModal(true)}
              className="flex-1 sm:flex-initial px-4 py-2 rounded-xl bg-[#0F382A] text-amber-200 font-bold text-xs tracking-wide shadow-sm hover:bg-[#164E3D] transition flex items-center justify-center gap-2"
            >
              <Upload className="w-4 h-4 text-amber-300" />
              <span>Upload</span>
            </button>
          )}

          <button
            onClick={handleDownloadFolderZip}
            disabled={downloadingZip || items.length === 0}
            className="flex-1 sm:flex-initial px-3.5 py-2 rounded-xl bg-white border border-stone-300 text-stone-700 font-semibold text-xs tracking-wide shadow-sm hover:bg-stone-50 hover:border-amber-400 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2"
            title="Download all contents of this folder"
          >
            {downloadingZip ? (
              <Loader2 className="w-4 h-4 animate-spin text-emerald-800" />
            ) : (
              <FolderArchive className="w-4 h-4 text-emerald-800" />
            )}
            <span>Download All</span>
          </button>
        </div>
      </div>

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
            onClick={() => setFeedback(null)}
            className="text-stone-400 hover:text-stone-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search Input Bar */}
      {items.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-stone-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search in ${section.title}...`}
              className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-white border border-stone-200 focus:outline-none focus:border-emerald-700 shadow-sm"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-2 text-stone-400 hover:text-stone-700"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <span className="text-[11px] text-stone-400 hidden sm:inline">
            Showing {filteredItems.length} of {items.length}
          </span>
        </div>
      )}

      {/* Items Grid or Empty State */}
      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center text-stone-400 space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-emerald-800" />
          <p className="text-xs font-medium">Opening folder contents...</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="py-16 rounded-2xl bg-white border border-dashed border-stone-300 text-center p-8 space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-400 flex items-center justify-center mx-auto">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-serif-spiritual text-base font-bold text-stone-700 mb-1">
              {search ? 'No items match your search' : `${section.title} is currently empty`}
            </h3>
            <p className="text-xs text-stone-500 max-w-sm mx-auto">
              {search
                ? 'Try a different keyword to locate items in this folder.'
                : section.id === 'video-links'
                  ? 'Paste a YouTube or direct video URL or upload a video file.'
                  : 'Upload files or add a new entry to populate this folder.'}
            </p>
          </div>
          {!search && (
            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              {canUploadInSection && (
                <button
                  onClick={() => setShowUploadModal(true)}
                  className="px-4 py-2 rounded-xl bg-[#0F382A] text-amber-200 text-xs font-bold hover:bg-[#164E3D] shadow transition inline-flex items-center gap-2"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload</span>
                </button>
              )}
              {(isAdmin || canPasteLinkInSection) && (
                <button
                  onClick={openCreateModal}
                  className="px-4 py-2 rounded-xl bg-amber-500 text-emerald-950 text-xs font-bold hover:bg-amber-400 shadow transition inline-flex items-center gap-1.5"
                >
                  {canPasteLinkInSection ? <LinkIcon className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  <span>{canPasteLinkInSection ? 'Paste Video Link' : 'Add Entry'}</span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredItems.map((item) => {
            const isPending = item.status === 'pending_approval';
            const isVid = isVideoEntry(item);
            const rawMediaUrl = item.localUrl || item.url || item.fileUrl || item.firebaseUrl || '';
            const cardThumbUrl = getCardThumbnailUrl(item);
            const embedInfo = parseVideoEmbed(rawMediaUrl);
            const authVideoPreviewUrl = rawMediaUrl && !embedInfo.isEmbed ? withAuthToken(rawMediaUrl) : '';

            return (
              <div
                key={item.id}
                className="group rounded-2xl bg-white border border-stone-200 p-4 shadow-sm hover:shadow-md hover:border-amber-400/60 transition flex flex-col justify-between"
              >
                <div>
                  {/* Video Thumbnail Preview OR Standard Header Icon */}
                  {isVid ? (
                    <div
                      onClick={() => setSelectedItem(item)}
                      className="relative aspect-video w-full rounded-xl overflow-hidden bg-stone-900 mb-3 cursor-pointer border border-stone-200"
                    >
                      {cardThumbUrl ? (
                        <img
                          src={cardThumbUrl}
                          alt={item.title || item.name || 'Video thumbnail'}
                          onError={() =>
                            setFailedThumbIds((prev) => ({ ...prev, [item.id]: true }))
                          }
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : authVideoPreviewUrl ? (
                        <video
                          src={`${authVideoPreviewUrl}#t=0.5`}
                          preload="metadata"
                          muted
                          playsInline
                          className="w-full h-full object-cover pointer-events-none"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#0F382A] to-[#082219]">
                          <Video className="w-8 h-8 text-amber-300/80" />
                        </div>
                      )}

                      {/* Play Button Overlay */}
                      <div className="absolute inset-0 bg-black/20 group-hover:bg-black/35 transition flex items-center justify-center">
                        <div className="w-11 h-11 rounded-full bg-[#0F382A]/90 border border-amber-300/70 text-amber-300 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                          <Play className="w-5 h-5 fill-current ml-0.5" />
                        </div>
                      </div>

                      {/* Top Status & Duration Badges */}
                      <div className="absolute top-2 right-2 flex items-center gap-1">
                        {isPending ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50/95 text-amber-900 border border-amber-300 shadow-sm">
                            <Clock className="w-3 h-3 text-amber-600" /> Pending
                          </span>
                        ) : item.status === 'approved' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50/95 text-emerald-900 border border-emerald-200 shadow-sm">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Approved
                          </span>
                        ) : null}
                      </div>

                      {item.duration && (
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/80 text-amber-200 text-[10px] font-mono font-semibold">
                          {item.duration}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-10 h-10 rounded-xl bg-stone-50 border border-stone-200 flex items-center justify-center">
                        {getItemIcon(item)}
                      </div>

                      <div className="flex items-center gap-1.5">
                        {item.duration && isAudioEntry(item) && (
                          <span className="px-2 py-0.5 rounded-md bg-emerald-950 text-amber-200 text-[10px] font-mono font-semibold">
                            {item.duration}
                          </span>
                        )}
                        {isPending && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300">
                            <Clock className="w-3 h-3 text-amber-600" /> Pending
                          </span>
                        )}
                        {!isPending && item.status === 'approved' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Approved
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Title */}
                  <h4
                    onClick={() => setSelectedItem(item)}
                    className="font-serif-spiritual text-sm font-bold text-[#0F382A] mb-1 line-clamp-1 group-hover:text-emerald-900 cursor-pointer"
                  >
                    {item.title || item.name || 'Untitled Item'}
                  </h4>

                  {/* Details */}
                  <p className="text-[11px] text-stone-500 line-clamp-2 leading-relaxed mb-3">
                    {item.description || item.summary || item.highlight || item.caption || item.location || 'Resource item'}
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-stone-400 mb-3 pt-2 border-t border-stone-100">
                    <span>{item.date || item.startDate || item.dateAdded || item.uploadedAt?.split('T')[0] || 'Active'}</span>
                    <span className="truncate max-w-[140px]">
                      {item.instructor || item.author || item.artist || item.leader || item.uploadedByName || ''}
                    </span>
                  </div>
                </div>

                {/* Card Actions */}
                <div className="flex flex-wrap items-center justify-between pt-2 border-t border-stone-100 gap-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {/* View/Open Button */}
                    <button
                      type="button"
                      onClick={() => setSelectedItem(item)}
                      className="px-2.5 py-1 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold flex items-center gap-1 transition"
                      title="Open or preview"
                    >
                      <Eye className="w-3.5 h-3.5 text-stone-600" />
                      <span>{isVid || isAudioEntry(item) ? 'Play' : 'View'}</span>
                    </button>

                    {/* Download Button (Admin for all; Users for audio & video files) */}
                    {canDownloadItem(item) && (
                      <button
                        type="button"
                        onClick={() => handleDownloadFile(item)}
                        disabled={downloadingItemId === item.id}
                        className="px-2.5 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-semibold flex items-center gap-1 transition disabled:opacity-50"
                        title="Download file"
                      >
                        {downloadingItemId === item.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-700" />
                        ) : (
                          <Download className="w-3.5 h-3.5 text-emerald-700" />
                        )}
                        <span>Download</span>
                      </button>
                    )}

                    {/* Bookmark Button */}
                    <button
                      type="button"
                      onClick={() => toggleOfflineSave(item.id)}
                      className={`p-1.5 rounded-lg text-xs font-semibold transition ${
                        savedOfflineIds.includes(item.id)
                          ? 'bg-amber-100 text-amber-900 border border-amber-300'
                          : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                      }`}
                      title={savedOfflineIds.includes(item.id) ? 'Bookmarked' : 'Bookmark item'}
                    >
                      {savedOfflineIds.includes(item.id) ? (
                        <BookmarkCheck className="w-3.5 h-3.5 text-amber-600" />
                      ) : (
                        <Bookmark className="w-3.5 h-3.5 text-stone-500" />
                      )}
                    </button>
                  </div>

                  {/* Direct Admin Actions: Approve, Edit, Delete */}
                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0 ml-auto">
                      {isPending && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleApprove(item.id);
                          }}
                          className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition"
                          title="Approve item"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(item);
                        }}
                        className="p-1.5 rounded-lg text-stone-500 hover:text-emerald-800 hover:bg-emerald-50 transition"
                        title="Edit item"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteError(null);
                          setConfirmDeleteItem(item);
                        }}
                        className="p-1.5 rounded-lg text-rose-600 bg-rose-50/70 hover:text-rose-700 hover:bg-rose-100 transition shrink-0"
                        title="Permanently delete item"
                        aria-label={`Delete ${item.title || item.name || 'item'}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Upload Modal */}
      <UploadModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        defaultSectionId={section.id}
        onUploadSuccess={() => {
          fetchContent(true);
          showFeedback('File uploaded successfully.');
        }}
      />

      {/* Item Viewer Modal */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-3xl max-h-[88vh] rounded-2xl bg-white border border-stone-200 shadow-2xl p-6 relative flex flex-col overflow-hidden">
            <div className="flex items-center justify-between pb-3 border-b border-stone-200">
              <h3 className="font-serif-spiritual text-lg font-bold text-[#0F382A] truncate pr-4">
                {selectedItem.title || selectedItem.name}
              </h3>
              <button
                onClick={() => setSelectedItem(null)}
                className="text-stone-400 hover:text-stone-700 p-1 rounded-lg hover:bg-stone-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-4">
              {renderViewerBody(selectedItem)}
            </div>

            <div className="pt-3 border-t border-stone-200 flex flex-wrap items-center justify-between gap-2">
              {onOpenGeminiWithContext && (
                <button
                  onClick={() => {
                    const item = selectedItem;
                    setSelectedItem(null);
                    onOpenGeminiWithContext('general', item);
                  }}
                  className="px-3 py-1.5 rounded-xl bg-amber-500/15 text-amber-900 border border-amber-400/40 text-xs font-semibold hover:bg-amber-500/25 flex items-center gap-1.5 transition"
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-700" />
                  <span>Ask Gemini AI</span>
                </button>
              )}

              {(isAdmin || canDownloadItem(selectedItem)) && (
                <div className="flex items-center gap-2 ml-auto">
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => {
                          const item = selectedItem;
                          openEditModal(item);
                        }}
                        className="px-3 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold transition flex items-center gap-1.5"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setDeleteError(null);
                          setConfirmDeleteItem(selectedItem);
                        }}
                        className="px-3 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold transition flex items-center gap-1.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    </>
                  )}

                  {canDownloadItem(selectedItem) && (
                    <button
                      onClick={() => handleDownloadFile(selectedItem)}
                      disabled={downloadingItemId === selectedItem.id}
                      className="px-4 py-2 rounded-xl bg-[#0F382A] text-amber-200 text-xs font-bold hover:bg-[#164E3D] shadow transition flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {downloadingItemId === selectedItem.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      <span>Download File</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Entry Modal (Admin for all entries; Users for pasting Video Links) */}
      {showEntryModal && (isAdmin || (!editingItem && canPasteLinkInSection)) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-lg rounded-2xl bg-white border border-stone-200 shadow-2xl p-6 relative max-h-[90vh] overflow-y-auto">
            <button
              onClick={() => {
                setShowEntryModal(false);
                setEditingItem(null);
              }}
              className="absolute top-4 right-4 text-stone-400 hover:text-stone-700 p-1"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="font-serif-spiritual text-lg font-bold text-[#0F382A] mb-1">
              {editingItem
                ? `Edit Item in ${section.title}`
                : canPasteLinkInSection
                  ? `Paste Video Link to ${section.title}`
                  : `Add Entry to ${section.title}`}
            </h3>
            <p className="text-[11px] text-stone-500 mb-4">
              {canPasteLinkInSection && !editingItem
                ? 'Paste a YouTube or direct video URL to watch it directly inside the app.'
                : 'Changes are saved directly to the backend database.'}
            </p>

            <form onSubmit={handleSaveEntry} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Title *</label>
                <input
                  type="text"
                  required
                  value={entryForm.title || ''}
                  onChange={(e) => setEntryForm({ ...entryForm, title: e.target.value })}
                  placeholder={`Title for ${section.title}...`}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                />
              </div>

              {(section.id === 'videos' || section.id === 'video-links' || section.id === 'photos' || section.id === 'add-more' || section.isCustom) && (
                <div>
                  <label className="block font-semibold text-stone-700 mb-1">
                    {section.id === 'videos' || section.id === 'video-links'
                      ? `YouTube or Direct Video URL${section.id === 'video-links' ? ' *' : ''}`
                      : 'Resource / File URL (optional)'}
                  </label>
                  <input
                    type="url"
                    required={section.id === 'video-links'}
                    value={entryForm.url || ''}
                    onChange={(e) => setEntryForm({ ...entryForm, url: e.target.value })}
                    placeholder="https://www.youtube.com/watch?v=... or https://.../video.mp4"
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                  />
                </div>
              )}

              {section.id === 'music' && (
                <div>
                  <label className="block font-semibold text-stone-700 mb-1">Audio Stream URL (optional)</label>
                  <input
                    type="text"
                    value={entryForm.audioUrl || ''}
                    onChange={(e) => setEntryForm({ ...entryForm, audioUrl: e.target.value })}
                    placeholder="https://..."
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                  />
                </div>
              )}

              {(section.id === 'videos' || section.id === 'video-links') && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Instructor</label>
                    <input
                      type="text"
                      value={entryForm.instructor || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, instructor: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Duration</label>
                    <input
                      type="text"
                      value={entryForm.duration || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, duration: e.target.value })}
                      placeholder="e.g., 15:00"
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                </div>
              )}

              {section.id === 'activity' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Date / Time</label>
                    <input
                      type="text"
                      value={entryForm.date || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, date: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Location</label>
                    <input
                      type="text"
                      value={entryForm.location || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, location: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Leader</label>
                    <input
                      type="text"
                      value={entryForm.leader || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, leader: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                </div>
              )}

              {section.id === 'schedules' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Term / Event Group</label>
                    <input
                      type="text"
                      value={entryForm.term || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, term: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Location</label>
                    <input
                      type="text"
                      value={entryForm.location || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, location: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Start Date</label>
                    <input
                      type="date"
                      value={entryForm.startDate || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, startDate: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">End Date</label>
                    <input
                      type="date"
                      value={entryForm.endDate || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, endDate: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                </div>
              )}

              {section.id === 'sop' && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">SOP Code</label>
                      <input
                        type="text"
                        value={entryForm.code || ''}
                        onChange={(e) => setEntryForm({ ...entryForm, code: e.target.value })}
                        placeholder="SOP-01"
                        className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Category</label>
                      <input
                        type="text"
                        value={entryForm.category || ''}
                        onChange={(e) => setEntryForm({ ...entryForm, category: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Version</label>
                      <input
                        type="text"
                        value={entryForm.version || ''}
                        onChange={(e) => setEntryForm({ ...entryForm, version: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Procedure Steps (one per line)</label>
                    <textarea
                      rows={3}
                      value={entryForm.stepsText || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, stepsText: e.target.value })}
                      placeholder="Step 1...&#10;Step 2..."
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                </>
              )}

              {section.id === 'music' && (
                <div>
                  <label className="block font-semibold text-stone-700 mb-1">Lyrics / Notes</label>
                  <textarea
                    rows={3}
                    value={entryForm.lyrics || ''}
                    onChange={(e) => setEntryForm({ ...entryForm, lyrics: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                  />
                </div>
              )}

              {(section.id === 'ppt' || section.id === 'learning' || section.id === 'games') && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Author / Creator</label>
                    <input
                      type="text"
                      value={entryForm.author || ''}
                      onChange={(e) => setEntryForm({ ...entryForm, author: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">
                      {section.id === 'games' ? 'Difficulty' : 'Category'}
                    </label>
                    <input
                      type="text"
                      value={section.id === 'games' ? (entryForm.difficulty || '') : (entryForm.category || '')}
                      onChange={(e) =>
                        setEntryForm(
                          section.id === 'games'
                            ? { ...entryForm, difficulty: e.target.value }
                            : { ...entryForm, category: e.target.value }
                        )
                      }
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Description / Details</label>
                <textarea
                  rows={3}
                  value={entryForm.description || ''}
                  onChange={(e) => setEntryForm({ ...entryForm, description: e.target.value })}
                  placeholder="Enter details, notes, or summary..."
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowEntryModal(false);
                    setEditingItem(null);
                  }}
                  className="w-1/2 py-2 rounded-xl bg-stone-100 text-stone-600 font-semibold hover:bg-stone-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={entrySaving}
                  className="w-1/2 py-2 rounded-xl bg-[#0F382A] text-amber-200 font-semibold hover:bg-[#164E3D] shadow disabled:opacity-50"
                >
                  {entrySaving ? 'Saving...' : editingItem ? 'Update Item' : 'Save Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Permanent Delete Confirmation Modal (Admin Only) */}
      {confirmDeleteItem && isAdmin && (
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
                  Are you sure you want to permanently delete{' '}
                  <strong>&quot;{confirmDeleteItem.title || confirmDeleteItem.name}&quot;</strong> from{' '}
                  <strong>{section.title}</strong>? This removes both the database record and stored file permanently.
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
                disabled={deletingId === confirmDeleteItem.id}
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDeleteItem(null);
                }}
                className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingId === confirmDeleteItem.id}
                onClick={handleConfirmDelete}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow flex items-center gap-1.5 disabled:opacity-50"
              >
                {deletingId === confirmDeleteItem.id ? (
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
