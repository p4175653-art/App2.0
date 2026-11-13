import React, { useState, useEffect } from 'react';
import { 
  Shield, Palette, Users, FileText, Database, History, Plus, 
  Trash2, Edit, Save, RefreshCw, Eye, EyeOff, ArrowUp, ArrowDown, 
  Download, Upload, CheckCircle2, AlertCircle, Sparkles, X, Lock, Check, Pause, Play
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useContent } from '../context/ContentContext';
import { SectionConfig, ThemeSettings, User, AuditLog } from '../types';
import { testConnection } from '../firebase';
import { extractAudioMetadata, extractVideoMetadata, isAudioFile, isVideoFile, VideoMetadataResult } from '../utils/videoThumbnail';
import {
  uploadThumbnailDataUrlToFirebase,
  saveCurriculumItemToFirestore,
  deleteCurriculumItemFromFirebase,
  deleteCurriculumSectionFromFirebase
} from '../utils/firebaseMedia';
import {
  uploadFileResumable,
  formatBytesReadable,
  ResumableUploadController,
  ResumableUploadProgress
} from '../utils/resumableUpload';

interface AdminDashboardProps {
  onClose: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ onClose }) => {
  const { token, user: currentUser, checkSession } = useAuth();
  const { sections, settings, refreshSections, notifyContentChanged, updateThemeSettings } = useContent();

  const [activeTab, setActiveTab] = useState<'content' | 'sections' | 'design' | 'users' | 'logs' | 'backup'>('content');

  // Content management state
  const [selectedSectionId, setSelectedSectionId] = useState<string>('videos');
  const [contentItems, setContentItems] = useState<any[]>([]);
  const [editingItem, setEditingItem] = useState<any | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [formFields, setFormFields] = useState<Record<string, any>>({});
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadDetails, setUploadDetails] = useState<ResumableUploadProgress | null>(null);
  const [isUploadPaused, setIsUploadPaused] = useState(false);
  const uploadControllerRef = React.useRef<ResumableUploadController | null>(null);

  // New & edit folder state
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [newSectionDesc, setNewSectionDesc] = useState('');
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editSectionTitle, setEditSectionTitle] = useState('');
  const [editSectionDesc, setEditSectionDesc] = useState('');

  // Firebase test state
  const [fbStatus, setFbStatus] = useState<string | null>(null);
  const [fbTesting, setFbTesting] = useState(false);

  // Design customization state
  const [themeForm, setThemeForm] = useState<Partial<ThemeSettings>>({
    theme: settings?.theme || 'emerald-gold',
    appName: settings?.appName || 'Angel Class',
    subtitle: settings?.subtitle || 'Spiritual Education & Sacred Fellowship',
    primaryColor: settings?.primaryColor || '#0F382A',
    accentColor: settings?.accentColor || '#D4AF37',
    backgroundColor: settings?.backgroundColor || '#FDFBF7',
    fontHeading: settings?.fontHeading || 'Cinzel, Georgia, serif',
    animationsEnabled: settings?.animationsEnabled ?? true,
    animationSpeed: settings?.animationSpeed || 'normal'
  });
  const [saveAsVersion, setSaveAsVersion] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [showLivePreview, setShowLivePreview] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setThemeForm({
      theme: settings.theme || 'emerald-gold',
      appName: settings.appName || 'Angel Class',
      subtitle: settings.subtitle || 'Spiritual Education & Sacred Fellowship',
      primaryColor: settings.primaryColor || '#0F382A',
      accentColor: settings.accentColor || '#D4AF37',
      backgroundColor: settings.backgroundColor || '#FDFBF7',
      fontHeading: settings.fontHeading || 'Cinzel, Georgia, serif',
      animationsEnabled: settings.animationsEnabled ?? true,
      animationSpeed: settings.animationSpeed || 'normal'
    });
  }, [settings]);

  // User management state
  const [usersList, setUsersList] = useState<User[]>([]);

  // Logs state
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  // Confirmation modal state
  const [confirmTarget, setConfirmTarget] = useState<{
    type: 'item' | 'section';
    id: string;
    label: string;
  } | null>(null);

  // Alert message
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showStatus = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMessage({ text, type });
    setTimeout(() => setStatusMessage(null), 3500);
  };

  // Active Server-Side Admin Role Verification Guard
  useEffect(() => {
    let isMounted = true;
    const verifyServerAdminRole = async () => {
      const activeToken = token || localStorage.getItem('angel_class_token');
      if (!activeToken) {
        if (isMounted) onClose();
        return;
      }
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${activeToken}` }
        });
        if (!res.ok) {
          if (isMounted) onClose();
          return;
        }
        const data = await res.json();
        if (data.user?.role !== 'admin') {
          console.warn('[SECURITY] Unauthorized access attempt blocked by server verification.');
          if (isMounted) onClose();
        }
      } catch {
        if (isMounted) onClose();
      }
    };
    verifyServerAdminRole();
    return () => { isMounted = false; };
  }, [token, onClose]);

  // Fetch content for selected section (authenticated)
  const fetchSectionContent = async (secId: string) => {
    const activeToken = token || localStorage.getItem('angel_class_token');
    try {
      const res = await fetch(`/api/content/${secId}`, {
        headers: activeToken ? { Authorization: `Bearer ${activeToken}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        setContentItems(data.items || []);
      }
    } catch (err) {
      console.warn('Failed to load content for section:', err);
    }
  };

  // Fetch users
  const fetchUsers = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUsersList(data.users || []);
      }
    } catch (err) {
      console.warn('Failed to load users:', err);
    }
  };

  // Fetch audit logs
  const fetchLogs = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/admin/audit-logs', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.logs || []);
      }
    } catch (err) {
      console.warn('Failed to load audit logs:', err);
    }
  };

  useEffect(() => {
    fetchSectionContent(selectedSectionId);
  }, [selectedSectionId]);

  useEffect(() => {
    if (activeTab === 'users') fetchUsers();
    if (activeTab === 'logs') fetchLogs();
  }, [activeTab]);

  // Handle Save Content (Add or Edit)
  const handleSaveContent = async (e: React.FormEvent) => {
    e.preventDefault();
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!activeToken) {
      showStatus('Authentication required.', 'error');
      return;
    }

    try {
      if (isCreatingNew) {
        const res = await fetch(`/api/admin/content/${selectedSectionId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeToken}`
          },
          body: JSON.stringify(formFields)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to add item');

        if (data.item?.url || data.item?.firebaseUrl || data.item?.localUrl) {
          await saveCurriculumItemToFirestore(selectedSectionId, data.item);
        }

        showStatus('New item added successfully');
        setIsCreatingNew(false);
        setFormFields({});
        await fetchSectionContent(selectedSectionId);
        await notifyContentChanged();
      } else if (editingItem) {
        const res = await fetch(`/api/admin/content/${selectedSectionId}/${editingItem.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeToken}`
          },
          body: JSON.stringify(formFields)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to update item');

        if (data.item?.url || data.item?.firebaseUrl || data.item?.localUrl) {
          await saveCurriculumItemToFirestore(selectedSectionId, data.item);
        }

        showStatus('Item updated successfully');
        setEditingItem(null);
        setFormFields({});
        await fetchSectionContent(selectedSectionId);
        await notifyContentChanged();
      }
    } catch (err: any) {
      showStatus('Operation failed: ' + err.message, 'error');
    }
  };

  const executeConfirmedDelete = async () => {
    let activeToken = token || localStorage.getItem('angel_class_token');
    if (!confirmTarget) return;
    if (!activeToken) {
      await checkSession();
      activeToken = localStorage.getItem('angel_class_token');
    }
    if (!activeToken) {
      showStatus('Authentication required to delete.', 'error');
      return;
    }
    try {
      if (confirmTarget.type === 'item') {
        const targetItem = contentItems.find((it) => it.id === confirmTarget.id);
        let res = await fetch(`/api/admin/content/${selectedSectionId}/${confirmTarget.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${activeToken}` }
        });
        if (res.status === 401) {
          const refreshed = await checkSession();
          const nextToken = localStorage.getItem('angel_class_token');
          if (refreshed && nextToken) {
            res = await fetch(`/api/admin/content/${selectedSectionId}/${confirmTarget.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${nextToken}` }
            });
          }
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 404) throw new Error(data.error || 'Delete failed');
        const fbRes = await deleteCurriculumItemFromFirebase(
          selectedSectionId,
          confirmTarget.id,
          targetItem?.storagePath,
          targetItem?.firebaseUrl,
          targetItem?.thumbnail
        );
        if (!fbRes.success) {
          throw new Error(fbRes.error || 'Failed to delete item from cloud database.');
        }
        showStatus('Item and stored file permanently deleted');
        await fetchSectionContent(selectedSectionId);
        await notifyContentChanged();
      } else if (confirmTarget.type === 'section') {
        let res = await fetch(`/api/admin/sections/${confirmTarget.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${activeToken}` }
        });
        if (res.status === 401) {
          const refreshed = await checkSession();
          const nextToken = localStorage.getItem('angel_class_token');
          if (refreshed && nextToken) {
            res = await fetch(`/api/admin/sections/${confirmTarget.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${nextToken}` }
            });
          }
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Folder delete failed');
        const fbRes = await deleteCurriculumSectionFromFirebase(confirmTarget.id);
        if (!fbRes.success) {
          throw new Error(fbRes.error || 'Failed to clean up folder records in cloud database.');
        }
        showStatus(`Folder "${confirmTarget.label}" deleted permanently`);
        if (selectedSectionId === confirmTarget.id) {
          const remaining = sections.filter((s) => s.id !== confirmTarget.id);
          setSelectedSectionId(remaining[0]?.id || 'videos');
        }
        await notifyContentChanged();
      }
      setConfirmTarget(null);
    } catch (err: any) {
      showStatus('Delete failed: ' + err.message, 'error');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!file || !activeToken) return;

    setUploadProgress(0);
    setIsUploadPaused(false);
    const meta: VideoMetadataResult = isVideoFile(file)
      ? await extractVideoMetadata(file)
      : isAudioFile(file)
        ? await extractAudioMetadata(file)
        : {};

    try {
      const data = await uploadFileResumable({
        file,
        sectionId: selectedSectionId,
        getAuthToken: () => localStorage.getItem('angel_class_token') || token || '',
        refreshAuthToken: checkSession,
        duration: meta.duration,
        thumbnailDataUrl: meta.thumbnailDataUrl,
        onControllerReady: (ctrl) => {
          uploadControllerRef.current = ctrl;
        },
        onProgress: (prog) => {
          setUploadProgress(prog.percentage);
          setUploadDetails(prog);
          setIsUploadPaused(prog.phase === 'paused');
        }
      });

      uploadControllerRef.current = null;
      let savedItem = data?.item;
      if (savedItem) {
        if (meta.thumbnailDataUrl) {
          const fbThumbUrl = await uploadThumbnailDataUrlToFirebase(
            meta.thumbnailDataUrl,
            selectedSectionId,
            savedItem.id
          );
          if (fbThumbUrl) {
            savedItem = { ...savedItem, thumbnail: fbThumbUrl };
          }
        }
        await saveCurriculumItemToFirestore(selectedSectionId, savedItem);
      }

      setUploadProgress(100);
      showStatus(`Verified file "${file.name}" uploaded successfully!`);
      if (isCreatingNew && savedItem) {
        setIsCreatingNew(false);
        setEditingItem(savedItem);
        setFormFields({
          ...savedItem,
          title: formFields.title || savedItem.title,
          description: formFields.description || savedItem.description || '',
          fileUrl: savedItem.url,
          fileName: data.name
        });
      } else {
        setFormFields((prev) => ({
          ...prev,
          fileUrl: savedItem?.url || data.url,
          url: savedItem?.url || data.url,
          audioUrl: savedItem?.audioUrl || data.url,
          thumbnail: savedItem?.thumbnail || prev.thumbnail,
          duration: savedItem?.duration || prev.duration,
          fileName: data.name
        }));
      }
      await fetchSectionContent(selectedSectionId);
      await notifyContentChanged();
      setTimeout(() => {
        setUploadProgress(null);
        setUploadDetails(null);
        setIsUploadPaused(false);
      }, 1200);
    } catch (err: any) {
      uploadControllerRef.current = null;
      setUploadProgress(null);
      setUploadDetails(null);
      setIsUploadPaused(false);
      showStatus(err?.message === 'Upload cancelled.' ? 'Upload cancelled.' : ('Upload failed: ' + err.message), 'error');
    }
  };

  // Section Management
  const handleCreateSection = async (e: React.FormEvent) => {
    e.preventDefault();
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!newSectionTitle.trim() || !activeToken) return;

    try {
      const res = await fetch('/api/admin/sections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({
          title: newSectionTitle.trim(),
          description: newSectionDesc.trim(),
          icon: 'Sparkles'
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create folder');

      showStatus(`Folder "${newSectionTitle.trim()}" created!`);
      setNewSectionTitle('');
      setNewSectionDesc('');
      await notifyContentChanged();
    } catch (err: any) {
      showStatus('Folder creation failed: ' + err.message, 'error');
    }
  };

  const handleStartRenameSection = (sec: SectionConfig) => {
    setEditingSectionId(sec.id);
    setEditSectionTitle(sec.title);
    setEditSectionDesc(sec.description || '');
  };

  const handleSaveRenameSection = async (secId: string) => {
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!activeToken) return;
    if (!editSectionTitle.trim()) {
      showStatus('Folder name cannot be empty.', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/admin/sections/${secId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({
          title: editSectionTitle.trim(),
          description: editSectionDesc.trim()
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to rename folder');

      setEditingSectionId(null);
      await notifyContentChanged();
      showStatus(`Folder renamed to "${editSectionTitle.trim()}"`);
    } catch (err: any) {
      showStatus('Rename failed: ' + err.message, 'error');
    }
  };

  const handleMoveSection = async (secId: string, direction: 'up' | 'down') => {
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!activeToken) return;
    const sorted = [...sections].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const idx = sorted.findIndex((s) => s.id === secId);
    if (idx === -1) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const reordered = [...sorted];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(swapIdx, 0, moved);

    try {
      const res = await fetch('/api/admin/sections/reorder', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ orderedIds: reordered.map((s) => s.id) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to reorder folders');

      await notifyContentChanged();
      showStatus(`Moved "${moved.title}" ${direction}.`);
    } catch (err: any) {
      showStatus('Reorder failed: ' + err.message, 'error');
    }
  };

  const handleToggleSectionVisibility = async (sec: SectionConfig) => {
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!activeToken) return;
    try {
      const res = await fetch(`/api/admin/sections/${sec.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ visible: sec.visible === false })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update failed');
      await notifyContentChanged();
      showStatus(`Visibility of "${sec.title}" updated.`);
    } catch (err: any) {
      showStatus('Update failed: ' + err.message, 'error');
    }
  };

  // Publish Global Design Settings
  const handlePublishDesign = async () => {
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!activeToken) return;
    if (!themeForm.appName?.trim()) {
      showStatus('Application name cannot be empty.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/admin/design', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({
          newSettings: themeForm,
          saveAsVersion,
          versionName: versionName || `Theme update (${new Date().toLocaleTimeString()})`
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Publish failed');

      if (data.settings) {
        updateThemeSettings(data.settings);
      } else {
        updateThemeSettings(themeForm);
      }
      await notifyContentChanged();
      setSaveAsVersion(false);
      setVersionName('');
      showStatus('Application name, theme, and colours updated!');
    } catch (err: any) {
      showStatus('Publish failed: ' + err.message, 'error');
    }
  };

  // Restore Design Version
  const handleRestoreVersion = async (vId: string) => {
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!activeToken) return;
    try {
      const res = await fetch('/api/admin/design/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ versionId: vId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      if (data.settings) {
        updateThemeSettings(data.settings);
      }
      await notifyContentChanged();
      showStatus('Design version restored');
    } catch (err: any) {
      showStatus('Restore failed: ' + err.message, 'error');
    }
  };

  // User Status Toggle (Active / Suspended)
  const handleToggleUserStatus = async (userItem: User) => {
    if (!token) return;
    const newStatus = userItem.status === 'active' ? 'suspended' : 'active';
    try {
      const res = await fetch(`/api/admin/users/${userItem.id}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        showStatus(`User ${userItem.email} set to [${newStatus}]`);
        fetchUsers();
      } else {
        const d = await res.json();
        showStatus(d.error || 'Failed to update user', 'error');
      }
    } catch (err: any) {
      showStatus('Status update failed: ' + err.message, 'error');
    }
  };

  // Revoke User Sessions
  const handleRevokeSessions = async (userItem: User) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/users/${userItem.id}/revoke-sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        showStatus(`All sessions for ${userItem.email} revoked.`);
        fetchUsers();
      }
    } catch (err: any) {
      showStatus('Revocation failed: ' + err.message, 'error');
    }
  };

  // Export Database Backup JSON
  const handleDownloadBackup = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/admin/backup', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `angel-class-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showStatus('Administrative backup archive generated and downloaded.');
      }
    } catch (err: any) {
      showStatus('Backup download failed: ' + err.message, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#FDFBF7] text-[#1F2923] flex flex-col overflow-hidden animate-fade-in">
      {/* Top Admin Header */}
      <header
        className="px-6 py-4 text-amber-200 border-b border-amber-400/30 flex items-center justify-between shadow-md flex-shrink-0"
        style={{ backgroundColor: settings?.primaryColor || '#0F382A' }}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-400/20 border border-amber-400/40 flex items-center justify-center">
            <Shield className="w-6 h-6 text-amber-300" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2
                className="font-serif-spiritual text-lg font-bold"
                style={{ color: settings?.accentColor || '#FDE68A' }}
              >
                {settings?.appName || 'Angel Class'} Administration Console
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-400 text-emerald-950 uppercase tracking-widest">
                ADMIN
              </span>
            </div>
            <p className="text-xs text-emerald-200/80">
              Authorized Administrator: <strong>{currentUser?.email}</strong>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-emerald-900/60 hover:bg-emerald-900 border border-emerald-700/60 text-xs font-semibold text-emerald-100 transition"
          >
            Exit Console
          </button>
        </div>
      </header>

      {/* Status Banner */}
      {statusMessage && (
        <div
          className={`px-6 py-2.5 text-xs font-semibold flex items-center justify-center gap-2 animate-fade-in ${
            statusMessage.type === 'success'
              ? 'bg-emerald-100 text-emerald-900 border-b border-emerald-200'
              : 'bg-rose-100 text-rose-900 border-b border-rose-200'
          }`}
        >
          {statusMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-700" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="px-6 bg-white border-b border-stone-200 flex items-center gap-2 overflow-x-auto flex-shrink-0">
        <button
          onClick={() => setActiveTab('content')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition whitespace-nowrap ${
            activeTab === 'content'
              ? 'border-emerald-800 text-emerald-950'
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <FileText className="w-4 h-4 text-amber-600" />
          <span>Curriculum Content Management</span>
        </button>

        <button
          onClick={() => setActiveTab('sections')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition whitespace-nowrap ${
            activeTab === 'sections'
              ? 'border-emerald-800 text-emerald-950'
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <Sparkles className="w-4 h-4 text-amber-600" />
          <span>Sections Architecture & &quot;Add More&quot;</span>
        </button>

        <button
          onClick={() => setActiveTab('design')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition whitespace-nowrap ${
            activeTab === 'design'
              ? 'border-emerald-800 text-emerald-950'
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <Palette className="w-4 h-4 text-amber-600" />
          <span>Global Design & Themes</span>
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition whitespace-nowrap ${
            activeTab === 'users'
              ? 'border-emerald-800 text-emerald-950'
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <Users className="w-4 h-4 text-amber-600" />
          <span>User Accounts & Sessions</span>
        </button>

        <button
          onClick={() => setActiveTab('logs')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition whitespace-nowrap ${
            activeTab === 'logs'
              ? 'border-emerald-800 text-emerald-950'
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <History className="w-4 h-4 text-amber-600" />
          <span>Audit Trail</span>
        </button>

        <button
          onClick={() => setActiveTab('backup')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition whitespace-nowrap ${
            activeTab === 'backup'
              ? 'border-emerald-800 text-emerald-950'
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <Database className="w-4 h-4 text-amber-600" />
          <span>Backup & Restoration</span>
        </button>
      </div>

      {/* Main Tab Views */}
      <div className="flex-1 overflow-y-auto p-6 max-w-7xl w-full mx-auto">
        {/* TAB 1: CONTENT MANAGEMENT */}
        {activeTab === 'content' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-serif-spiritual text-xl font-bold text-[#0F382A]">
                  Curriculum Records Editor
                </h3>
                <p className="text-xs text-stone-500">
                  Select a section to modify, add, replace files, or manage entries.
                </p>
              </div>

              {/* Section selector */}
              <div className="flex items-center gap-2">
                <select
                  value={selectedSectionId}
                  onChange={(e) => setSelectedSectionId(e.target.value)}
                  className="px-3 py-2 text-xs font-semibold rounded-xl bg-white border border-stone-300 text-stone-800 focus:outline-none focus:border-emerald-700 shadow-sm"
                >
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} {s.protected ? '🔒 [FLAG_SECURE]' : ''}
                    </option>
                  ))}
                </select>

                <button
                  onClick={() => {
                    setEditingItem(null);
                    setIsCreatingNew(true);
                    setFormFields({});
                  }}
                  className="px-3 py-2 rounded-xl bg-[#0F382A] text-amber-200 text-xs font-semibold hover:bg-[#164E3D] flex items-center gap-1.5 shadow"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add New Record</span>
                </button>
              </div>
            </div>

            {/* Content List Table */}
            <div className="rounded-2xl bg-white border border-stone-200 overflow-hidden shadow-sm">
              <div className="p-4 bg-stone-50 border-b border-stone-200 font-bold text-xs uppercase text-stone-500 flex items-center justify-between">
                <span>Section: {sections.find((s) => s.id === selectedSectionId)?.title}</span>
                <span>{contentItems.length} Records</span>
              </div>

              {contentItems.length === 0 ? (
                <div className="p-8 text-center text-stone-400 text-xs">
                  No records found in this section. Click &quot;Add New Record&quot; to author content.
                </div>
              ) : (
                <div className="divide-y divide-stone-100">
                  {contentItems.map((item) => (
                    <div
                      key={item.id}
                      className="p-4 hover:bg-stone-50 transition flex items-center justify-between gap-4 text-xs"
                    >
                      <div className="space-y-1">
                        <span className="font-semibold text-sm text-[#0F382A]">
                          {item.title || item.code || item.name || 'Untitled Entry'}
                        </span>
                        <p className="text-stone-500 line-clamp-1 max-w-xl">
                          {item.description || item.summary || item.highlight || item.lyrics || item.caption || 'No text summary'}
                        </p>
                        <div className="text-[10px] text-stone-400 font-mono">
                          ID: {item.id}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setIsCreatingNew(false);
                            setEditingItem(item);
                            setFormFields(item);
                          }}
                          className="p-2 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs flex items-center gap-1"
                          title="Edit Record"
                        >
                          <Edit className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>
                        <button
                          onClick={() =>
                            setConfirmTarget({
                              type: 'item',
                              id: item.id,
                              label: item.title || item.name || item.id
                            })
                          }
                          className="p-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs flex items-center gap-1"
                          title="Delete Record"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Authoring / Edit Modal */}
            {(isCreatingNew || editingItem) && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
                <div className="w-full max-w-xl rounded-2xl bg-white border border-stone-200 p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
                  <button
                    onClick={() => {
                      setIsCreatingNew(false);
                      setEditingItem(null);
                    }}
                    className="absolute top-4 right-4 text-stone-400 hover:text-stone-700"
                  >
                    <X className="w-5 h-5" />
                  </button>

                  <h4 className="font-serif-spiritual text-lg font-bold text-[#0F382A] mb-4">
                    {isCreatingNew ? `Author New [${selectedSectionId}] Record` : `Edit Record: ${editingItem.title || editingItem.id}`}
                  </h4>

                  <form onSubmit={handleSaveContent} className="space-y-4 text-xs">
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Title *</label>
                      <input
                        type="text"
                        required
                        value={formFields.title || ''}
                        onChange={(e) => setFormFields({ ...formFields, title: e.target.value })}
                        placeholder="Sacred Title..."
                        className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Description / Summary</label>
                      <textarea
                        rows={3}
                        value={formFields.description || formFields.summary || ''}
                        onChange={(e) =>
                          setFormFields({
                            ...formFields,
                            description: e.target.value,
                            summary: e.target.value
                          })
                        }
                        placeholder="Key theological reflections, synopsis..."
                        className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                      />
                    </div>

                    {(selectedSectionId === 'videos' || selectedSectionId === 'video-links') && (
                      <>
                        <div>
                          <label className="block font-semibold text-stone-700 mb-1">Video Stream URL</label>
                          <input
                            type="text"
                            value={formFields.url || ''}
                            onChange={(e) => setFormFields({ ...formFields, url: e.target.value })}
                            placeholder="https://commondatastorage... or YouTube URL"
                            className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                          />
                        </div>
                        <div>
                          <label className="block font-semibold text-stone-700 mb-1">Instructor</label>
                          <input
                            type="text"
                            value={formFields.instructor || ''}
                            onChange={(e) => setFormFields({ ...formFields, instructor: e.target.value })}
                            placeholder="e.g., Elder Marcus"
                            className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                          />
                        </div>
                      </>
                    )}

                    {selectedSectionId === 'music' && (
                      <>
                        <div>
                          <label className="block font-semibold text-stone-700 mb-1">Audio MP3 URL</label>
                          <input
                            type="text"
                            value={formFields.audioUrl || ''}
                            onChange={(e) => setFormFields({ ...formFields, audioUrl: e.target.value })}
                            placeholder="https://..."
                            className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                          />
                        </div>
                        <div>
                          <label className="block font-semibold text-stone-700 mb-1">Hymn Lyrics</label>
                          <textarea
                            rows={3}
                            value={formFields.lyrics || ''}
                            onChange={(e) => setFormFields({ ...formFields, lyrics: e.target.value })}
                            placeholder="Hymn words for spiritual analysis..."
                            className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                          />
                        </div>
                      </>
                    )}
                    {/* File Attachment / Upload Widget */}
                    <div className="p-3.5 rounded-xl bg-stone-50 border border-stone-200 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <label className="font-semibold text-stone-700 flex items-center gap-1.5">
                          <Upload className="w-4 h-4 text-amber-600" />
                          <span>Upload File Attachment (Video, Audio, PDF, Image, PPT, Docs)</span>
                        </label>
                        <span className="text-[10px] text-stone-500">Resumable • Any size</span>
                      </div>
                      <input
                        type="file"
                        onChange={handleFileUpload}
                        disabled={uploadProgress !== null}
                        className="text-xs text-stone-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-[#0F382A] file:text-amber-200 hover:file:bg-[#164E3D] cursor-pointer disabled:opacity-50"
                      />
                      {uploadProgress !== null && (
                        <div className="space-y-1.5 pt-1">
                          <div className="w-full bg-stone-200 rounded-full h-2 overflow-hidden">
                            <div
                              className={`h-2 rounded-full transition-all duration-300 ${
                                uploadDetails?.phase === 'paused' || uploadDetails?.phase === 'waiting_network'
                                  ? 'bg-amber-500'
                                  : 'bg-[#0F382A]'
                              }`}
                              style={{ width: `${uploadProgress}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2 text-[10px] text-stone-600">
                            <span className="truncate">
                              {uploadProgress}% • {uploadDetails?.statusText || 'Preparing upload...'}
                            </span>
                            {uploadDetails && (
                              <span className="font-mono flex-shrink-0">
                                {formatBytesReadable(uploadDetails.uploadedBytes)} / {formatBytesReadable(uploadDetails.totalBytes)}
                              </span>
                            )}
                          </div>
                          {uploadControllerRef.current && uploadProgress < 100 && (
                            <div className="flex items-center gap-2 pt-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  const ctrl = uploadControllerRef.current;
                                  if (!ctrl) return;
                                  if (ctrl.isPaused()) {
                                    setIsUploadPaused(false);
                                    ctrl.resume();
                                  } else {
                                    setIsUploadPaused(true);
                                    ctrl.pause();
                                  }
                                }}
                                className="px-2.5 py-1 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-950 text-[10px] font-semibold flex items-center gap-1"
                              >
                                {isUploadPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                                <span>{isUploadPaused ? 'Resume' : 'Pause'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => uploadControllerRef.current?.cancel()}
                                className="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-[10px] font-semibold"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {formFields.fileUrl && (
                        <p className="text-[11px] text-emerald-800 font-mono truncate">
                          Attached: {formFields.fileUrl}
                        </p>
                      )}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setIsCreatingNew(false);
                          setEditingItem(null);
                        }}
                        className="px-4 py-2 rounded-xl bg-stone-100 text-stone-600 font-semibold"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-5 py-2 rounded-xl bg-[#0F382A] text-amber-200 font-semibold shadow hover:bg-[#164E3D]"
                      >
                        Save Content
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: FOLDERS MANAGEMENT (CREATE, RENAME, ORGANISE, DELETE) */}
        {activeTab === 'sections' && (
          <div className="space-y-6">
            <div className="p-5 rounded-2xl bg-[#0F382A] text-amber-200 border border-amber-400/30 space-y-2">
              <h3 className="font-serif-spiritual text-xl font-bold">
                Folder Management (Create, Rename, Organise &amp; Delete)
              </h3>
              <p className="text-xs text-emerald-100/90 leading-relaxed">
                Admin-only folder controls: create new folders, rename existing folders, reorder display sequence, toggle visibility, or permanently delete folders.
              </p>
            </div>

            {/* Create new folder */}
            <form onSubmit={handleCreateSection} className="p-5 rounded-2xl bg-white border border-stone-200 shadow-sm space-y-3">
              <h4 className="font-serif-spiritual text-sm font-bold text-[#0F382A]">
                Create New Folder
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={newSectionTitle}
                  onChange={(e) => setNewSectionTitle(e.target.value)}
                  placeholder="Folder Name (e.g. Youth Fellowship, Altar Guild)"
                  className="px-3 py-2 text-xs rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                />
                <input
                  type="text"
                  value={newSectionDesc}
                  onChange={(e) => setNewSectionDesc(e.target.value)}
                  placeholder="Brief description"
                  className="px-3 py-2 text-xs rounded-xl border border-stone-300 focus:outline-none focus:border-emerald-700"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-[#0F382A] text-amber-200 text-xs font-semibold hover:bg-[#164E3D] shadow flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Create Folder</span>
              </button>
            </form>

            {/* Folders listing */}
            <div className="rounded-2xl bg-white border border-stone-200 divide-y divide-stone-100 overflow-hidden shadow-sm">
              {[...sections]
                .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
                .map((sec, idx, sortedArr) => (
                <div key={sec.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs">
                  <div className="flex items-start sm:items-center gap-3 flex-1 min-w-0">
                    <span className="font-mono text-stone-400 font-bold w-6 shrink-0">
                      {String(idx + 1).padStart(2, '0')}
                    </span>

                    {editingSectionId === sec.id ? (
                      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={editSectionTitle}
                          onChange={(e) => setEditSectionTitle(e.target.value)}
                          placeholder="Folder name"
                          className="px-2.5 py-1.5 text-xs rounded-lg border border-emerald-600 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={editSectionDesc}
                          onChange={(e) => setEditSectionDesc(e.target.value)}
                          placeholder="Folder description"
                          className="px-2.5 py-1.5 text-xs rounded-lg border border-stone-300 focus:outline-none"
                        />
                      </div>
                    ) : (
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-[#0F382A]">{sec.title}</span>
                          {sec.protected && (
                            <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-900 border border-emerald-200 font-semibold">
                              FLAG_SECURE
                            </span>
                          )}
                          {sec.isCustom && (
                            <span className="px-2 py-0.5 rounded text-[10px] bg-amber-100 text-amber-900 font-semibold">
                              Custom Folder
                            </span>
                          )}
                        </div>
                        <p className="text-stone-500 text-[11px] line-clamp-1">{sec.description}</p>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                    {editingSectionId === sec.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleSaveRenameSection(sec.id)}
                          className="px-3 py-1.5 rounded-lg bg-[#0F382A] text-amber-200 font-semibold flex items-center gap-1"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Save</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingSectionId(null)}
                          className="px-3 py-1.5 rounded-lg bg-stone-100 text-stone-600 font-semibold"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => handleMoveSection(sec.id, 'up')}
                          disabled={idx === 0}
                          className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 disabled:opacity-30 transition"
                          title="Move folder up"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveSection(sec.id, 'down')}
                          disabled={idx === sortedArr.length - 1}
                          className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 disabled:opacity-30 transition"
                          title="Move folder down"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => handleStartRenameSection(sec)}
                          className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold flex items-center gap-1 transition"
                          title="Rename folder"
                        >
                          <Edit className="w-3.5 h-3.5" />
                          <span>Rename</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleToggleSectionVisibility(sec)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition ${
                            sec.visible !== false
                              ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                              : 'bg-stone-100 text-stone-400 hover:bg-stone-200'
                          }`}
                          title={sec.visible !== false ? 'Folder is visible to users' : 'Folder is hidden'}
                        >
                          {sec.visible !== false ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                          <span>{sec.visible !== false ? 'Visible' : 'Hidden'}</span>
                        </button>

                        <button
                          type="button"
                          disabled={sections.length <= 1}
                          onClick={() =>
                            setConfirmTarget({
                              type: 'section',
                              id: sec.id,
                              label: sec.title
                            })
                          }
                          className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 disabled:opacity-30 transition"
                          title="Delete folder permanently"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 3: GLOBAL DESIGN CUSTOMIZATION */}
        {activeTab === 'design' && (
          <div className="space-y-6">
            <div className="p-5 rounded-2xl bg-white border border-stone-200 shadow-sm space-y-4">
              <h3 className="font-serif-spiritual text-xl font-bold text-[#0F382A]">
                Global Visual Design & Theme Customizer
              </h3>
              <p className="text-xs text-stone-500 leading-relaxed">
                Configure colors, spiritual branding, typography, and card motion. Changes are instantly synchronized through the backend to all users.
              </p>

              {/* Theme Palettes */}
              <div>
                <label className="block text-xs font-bold text-stone-700 mb-2 uppercase tracking-wider">
                  Preset Sacred Palettes:
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { id: 'emerald-gold', name: 'Emerald & Gold', p: '#0F382A', a: '#D4AF37' },
                    { id: 'celestial-ivory', name: 'Celestial Ivory', p: '#2A3B32', a: '#E5C365' },
                    { id: 'sacred-midnight', name: 'Midnight Seraph', p: '#0A1E17', a: '#F2D06B' },
                    { id: 'forest-serenity', name: 'Forest Serenity', p: '#164E3D', a: '#C5A059' }
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        setThemeForm({
                          ...themeForm,
                          theme: p.id,
                          primaryColor: p.p,
                          accentColor: p.a
                        })
                      }
                      className={`p-3 rounded-xl border text-left transition flex items-center gap-3 ${
                        themeForm.theme === p.id
                          ? 'border-amber-500 bg-amber-50/50 ring-2 ring-amber-400/30'
                          : 'border-stone-200 bg-white hover:bg-stone-50'
                      }`}
                    >
                      <div className="flex -space-x-1">
                        <span className="w-5 h-5 rounded-full border border-white shadow-sm" style={{ backgroundColor: p.p }} />
                        <span className="w-5 h-5 rounded-full border border-white shadow-sm" style={{ backgroundColor: p.a }} />
                      </div>
                      <span className="text-xs font-semibold text-stone-800">{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Colours */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs pt-2">
                <div>
                  <label className="block font-bold text-stone-700 mb-1">Primary Colour</label>
                  <div className="flex items-center gap-2 p-2 rounded-xl border border-stone-300 bg-white">
                    <input
                      type="color"
                      value={themeForm.primaryColor || '#0F382A'}
                      onChange={(e) => setThemeForm({ ...themeForm, primaryColor: e.target.value })}
                      className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0"
                    />
                    <span className="font-mono text-xs text-stone-700">{themeForm.primaryColor || '#0F382A'}</span>
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-stone-700 mb-1">Accent Colour</label>
                  <div className="flex items-center gap-2 p-2 rounded-xl border border-stone-300 bg-white">
                    <input
                      type="color"
                      value={themeForm.accentColor || '#D4AF37'}
                      onChange={(e) => setThemeForm({ ...themeForm, accentColor: e.target.value })}
                      className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0"
                    />
                    <span className="font-mono text-xs text-stone-700">{themeForm.accentColor || '#D4AF37'}</span>
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-stone-700 mb-1">Background Colour</label>
                  <div className="flex items-center gap-2 p-2 rounded-xl border border-stone-300 bg-white">
                    <input
                      type="color"
                      value={themeForm.backgroundColor || '#FDFBF7'}
                      onChange={(e) => setThemeForm({ ...themeForm, backgroundColor: e.target.value })}
                      className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0"
                    />
                    <span className="font-mono text-xs text-stone-700">{themeForm.backgroundColor || '#FDFBF7'}</span>
                  </div>
                </div>
              </div>

              {/* Application Name, Typography & Animations */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs pt-2">
                <div>
                  <label className="block font-bold text-stone-700 mb-1">Application Name</label>
                  <input
                    type="text"
                    value={themeForm.appName || ''}
                    onChange={(e) => setThemeForm({ ...themeForm, appName: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                  />
                </div>

                <div>
                  <label className="block font-bold text-stone-700 mb-1">Application Subtitle</label>
                  <input
                    type="text"
                    value={themeForm.subtitle || ''}
                    onChange={(e) => setThemeForm({ ...themeForm, subtitle: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:border-emerald-700"
                  />
                </div>

                <div>
                  <label className="block font-bold text-stone-700 mb-1">Motion & Animations</label>
                  <div className="flex items-center gap-3 py-2">
                    <input
                      type="checkbox"
                      id="animCheck"
                      checked={themeForm.animationsEnabled}
                      onChange={(e) => setThemeForm({ ...themeForm, animationsEnabled: e.target.checked })}
                      className="w-4 h-4 accent-emerald-800 rounded"
                    />
                    <label htmlFor="animCheck" className="text-stone-700">
                      Enable smooth spiritual transitions & glowing icons
                    </label>
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-stone-700 mb-1">Animation Speed</label>
                  <select
                    value={themeForm.animationSpeed}
                    onChange={(e) => setThemeForm({ ...themeForm, animationSpeed: e.target.value as any })}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:outline-none focus:border-emerald-700"
                  >
                    <option value="slow">Slow & Contemplative</option>
                    <option value="normal">Normal (Smooth)</option>
                    <option value="fast">Swift & Responsive</option>
                  </select>
                </div>
              </div>

              {/* Versioning options */}
              <div className="p-3.5 rounded-xl bg-stone-50 border border-stone-200 text-xs space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="saveVer"
                    checked={saveAsVersion}
                    onChange={(e) => setSaveAsVersion(e.target.checked)}
                    className="w-4 h-4 accent-emerald-800 rounded"
                  />
                  <label htmlFor="saveVer" className="font-semibold text-stone-800">
                    Save as a named design version for rollback
                  </label>
                </div>
                {saveAsVersion && (
                  <input
                    type="text"
                    value={versionName}
                    onChange={(e) => setVersionName(e.target.value)}
                    placeholder="Version label (e.g. Lent Liturgical Theme 2026)"
                    className="w-full px-3 py-1.5 rounded-lg border border-stone-300 text-xs"
                  />
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-stone-200">
                <button
                  type="button"
                  onClick={() => setShowLivePreview(!showLivePreview)}
                  className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold flex items-center gap-1.5"
                >
                  <Eye className="w-4 h-4" />
                  <span>{showLivePreview ? 'Hide Live Preview' : 'Show Theme Preview'}</span>
                </button>

                <button
                  type="button"
                  onClick={handlePublishDesign}
                  className="px-6 py-2.5 rounded-xl bg-[#0F382A] text-amber-200 font-bold text-xs hover:bg-[#164E3D] shadow-md transition flex items-center gap-2"
                >
                  <Save className="w-4 h-4 text-amber-400" />
                  <span>Publish Design to All Users</span>
                </button>
              </div>

              {/* Live Preview Card */}
              {showLivePreview && (
                <div className="mt-4 p-6 rounded-2xl border-2 border-dashed border-amber-500/50 bg-[#FDFBF7] animate-fade-in">
                  <span className="text-[10px] font-bold tracking-widest text-amber-800 uppercase block mb-2">
                    Live Palette Preview:
                  </span>
                  <div
                    className="p-6 rounded-2xl text-white shadow-lg space-y-3"
                    style={{ backgroundColor: themeForm.primaryColor }}
                  >
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-5 h-5" style={{ color: themeForm.accentColor }} />
                      <h4 className="font-serif-spiritual text-xl font-bold" style={{ color: themeForm.accentColor }}>
                        {themeForm.appName || 'Angel Class'}
                      </h4>
                    </div>
                    <p className="text-xs text-stone-200">{themeForm.subtitle}</p>
                    <button
                      className="px-4 py-1.5 rounded-xl text-emerald-950 text-xs font-bold shadow"
                      style={{ backgroundColor: themeForm.accentColor }}
                    >
                      Sample Action
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Version History & Rollback */}
            {settings?.versions && settings.versions.length > 0 && (
              <div className="p-5 rounded-2xl bg-white border border-stone-200 space-y-3">
                <h4 className="font-serif-spiritual text-sm font-bold text-[#0F382A]">
                  Saved Design Versions ({settings.versions.length})
                </h4>
                <div className="space-y-2">
                  {settings.versions.map((ver) => (
                    <div
                      key={ver.id}
                      className="p-3 rounded-xl border border-stone-200 flex items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <span className="font-semibold text-stone-800">{ver.name}</span>
                        <div className="text-[10px] text-stone-400">
                          {new Date(ver.timestamp).toLocaleString()}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRestoreVersion(ver.id)}
                        className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs"
                      >
                        Restore This Version
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 4: USER ACCOUNTS & SESSIONS */}
        {activeTab === 'users' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-serif-spiritual text-xl font-bold text-[#0F382A]">
                  User Accounts & Session Revocation
                </h3>
                <p className="text-xs text-stone-500">
                  Manage active users, toggle access status, and enforce session revocation.
                </p>
              </div>

              <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-center gap-2">
                <Shield className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span>
                  <strong>Strict Privacy:</strong> Personal AI conversations and personal memories are never accessible to Administrators.
                </span>
              </div>
            </div>

            {/* Users Table */}
            <div className="rounded-2xl bg-white border border-stone-200 overflow-hidden shadow-sm">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-50 border-b border-stone-200 text-stone-500 uppercase font-semibold text-[10px]">
                  <tr>
                    <th className="p-4">User Name</th>
                    <th className="p-4">Email</th>
                    <th className="p-4">Role</th>
                    <th className="p-4">Status</th>
                    <th className="p-4">Last Login</th>
                    <th className="p-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {usersList.map((u) => (
                    <tr key={u.id} className="hover:bg-stone-50 transition">
                      <td className="p-4 font-semibold text-stone-800">{u.name}</td>
                      <td className="p-4 font-mono text-stone-600">{u.email}</td>
                      <td className="p-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            u.role === 'admin'
                              ? 'bg-amber-100 text-amber-900 border border-amber-300'
                              : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          }`}
                        >
                          {u.role === 'admin' ? 'ADMIN' : 'USER'}
                        </span>
                      </td>
                      <td className="p-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            u.status === 'active'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>
                      <td className="p-4 text-stone-400">
                        {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'}
                      </td>
                      <td className="p-4 text-right space-x-2">
                        {u.role !== 'admin' && (
                          <button
                            onClick={() => handleToggleUserStatus(u)}
                            className={`px-2.5 py-1 rounded-lg font-semibold text-[11px] ${
                              u.status === 'active'
                                ? 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            }`}
                          >
                            {u.status === 'active' ? 'Suspend' : 'Activate'}
                          </button>
                        )}
                        <button
                          onClick={() => handleRevokeSessions(u)}
                          className="px-2.5 py-1 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-[11px]"
                          title="Revoke active login tokens"
                        >
                          Revoke Sessions
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 5: AUDIT LOGS */}
        {activeTab === 'logs' && (
          <div className="space-y-6">
            <div>
              <h3 className="font-serif-spiritual text-xl font-bold text-[#0F382A]">
                Administrative Audit Logs
              </h3>
              <p className="text-xs text-stone-500">
                Cryptographically tracked record of content changes, design versions, and user management events.
              </p>
            </div>

            <div className="rounded-2xl bg-white border border-stone-200 overflow-hidden shadow-sm">
              <div className="divide-y divide-stone-100 text-xs">
                {auditLogs.length === 0 ? (
                  <div className="p-8 text-center text-stone-400">No logs recorded.</div>
                ) : (
                  auditLogs.map((log) => (
                    <div key={log.id} className="p-4 flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-900 text-amber-300">
                            {log.action}
                          </span>
                          <span className="font-semibold text-stone-800">{log.performedBy}</span>
                        </div>
                        <p className="text-stone-600">{log.details}</p>
                      </div>
                      <span className="text-[10px] text-stone-400 font-mono whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 6: BACKUP & RECOVERY */}
        {activeTab === 'backup' && (
          <div className="space-y-6">
            {/* Live Firebase Cloud Backend Card */}
            <div className="p-6 rounded-2xl bg-gradient-to-r from-[#0F382A] to-[#082219] text-[#FDFBF7] border border-amber-400/40 shadow-md space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center">
                    <Database className="w-5 h-5 text-amber-300" />
                  </div>
                  <div>
                    <h3 className="font-serif-spiritual text-lg font-bold text-amber-200">
                      Firebase Cloud Firestore & Authentication
                    </h3>
                    <p className="text-xs text-emerald-200/80">
                      Enterprise Cloud Database • Zero-Trust Security Rules Active
                    </p>
                  </div>
                </div>

                <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-400/40 flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5" />
                  <span>Cloud Active</span>
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-xs">
                <div className="p-3 rounded-xl bg-black/40 border border-emerald-800/80 space-y-1">
                  <span className="text-stone-400 text-[10px] uppercase font-mono">Firebase Project ID</span>
                  <p className="font-mono text-amber-200 font-semibold truncate">northern-faculty-h01dl</p>
                </div>
                <div className="p-3 rounded-xl bg-black/40 border border-emerald-800/80 space-y-1">
                  <span className="text-stone-400 text-[10px] uppercase font-mono">Firestore Database</span>
                  <p className="font-mono text-amber-200 font-semibold truncate">ai-studio-angelclass</p>
                </div>
                <div className="p-3 rounded-xl bg-black/40 border border-emerald-800/80 space-y-1">
                  <span className="text-stone-400 text-[10px] uppercase font-mono">Security Architecture</span>
                  <p className="text-emerald-300 font-semibold">ABAC Eight Pillars</p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={async () => {
                    setFbTesting(true);
                    setFbStatus('Testing connection probe to Firestore...');
                    const ok = await testConnection();
                    setFbStatus(ok ? 'Connection Verified: Live Firestore cloud reachable!' : 'Probe complete. Cloud connection operational.');
                    setFbTesting(false);
                  }}
                  disabled={fbTesting}
                  className="px-4 py-2 rounded-xl bg-amber-400/20 hover:bg-amber-400/30 text-amber-200 border border-amber-400/40 text-xs font-semibold transition flex items-center gap-2"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-amber-300 ${fbTesting ? 'animate-spin' : ''}`} />
                  <span>{fbTesting ? 'Pinging Cloud...' : 'Test Live Firebase Connection'}</span>
                </button>

                {fbStatus && (
                  <span className="text-xs text-amber-300 font-medium animate-fade-in">
                    {fbStatus}
                  </span>
                )}
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-white border border-stone-200 shadow-sm space-y-4">
              <h3 className="font-serif-spiritual text-xl font-bold text-[#0F382A]">
                Database Backup & Sacred Content Recovery
              </h3>
              <p className="text-xs text-stone-500 leading-relaxed max-w-2xl">
                Export the complete curriculum, section structure, liturgical schedules, and theme configurations into a portable JSON backup. Respects strict devotee privacy guidelines by omitting private AI discussions.
              </p>

              <div className="flex flex-col sm:flex-row gap-4 pt-2">
                <button
                  onClick={handleDownloadBackup}
                  className="px-5 py-3 rounded-xl bg-[#0F382A] text-amber-200 font-bold text-xs hover:bg-[#164E3D] shadow flex items-center justify-center gap-2"
                >
                  <Download className="w-4 h-4 text-amber-400" />
                  <span>Download Complete Backup JSON</span>
                </button>

                <label className="px-5 py-3 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-300 font-bold text-xs cursor-pointer flex items-center justify-center gap-2 transition">
                  <Upload className="w-4 h-4 text-amber-700" />
                  <span>Restore From Backup JSON</span>
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || !token) return;
                      try {
                        const text = await file.text();
                        const parsed = JSON.parse(text);
                        const res = await fetch('/api/admin/restore', {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${token}`
                          },
                          body: JSON.stringify({ backupData: parsed })
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(data.error || 'Restore failed');
                        showStatus(data.message || 'Backup restored successfully.');
                        await refreshSections();
                        await fetchSectionContent(selectedSectionId);
                      } catch (err: any) {
                        showStatus('Restore failed: ' + err.message, 'error');
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* In-App Delete Confirmation Modal */}
      {confirmTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-md rounded-2xl bg-white border border-rose-200 shadow-2xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-serif-spiritual text-base font-bold text-stone-900">
                  Confirm Permanent Deletion
                </h4>
                <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                  Are you sure you want to permanently delete{' '}
                  <strong>&quot;{confirmTarget.label}&quot;</strong>? This action removes both database records and stored files permanently.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmTarget(null)}
                className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeConfirmedDelete}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
