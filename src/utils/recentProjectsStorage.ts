import { convertFileSrc } from '@tauri-apps/api/core';
import type { Api } from '../api';

export type ProjectStatus = 'detected' | 'in_progress' | 'approved';

export interface MangaProject {
  id: string;
  seriesTitle: string;
  chapterTitle: string;
  chapterNumber: number;
  coverImage?: string; // can be absolute disk path or data:image/... url
  pagesCount: number;
  completedPages: number;
  progressPercent: number;
  status: ProjectStatus;
  statusLabel: string;
  sourceLang: string;
  targetLang: string;
  lastEdited: string;
  lastEditedTimestamp: number;
  folderPath: string;
  preset: string;
  isMissing?: boolean;
}

const STORAGE_KEY = 'mangaclean_atelier_recent_projects_v2';

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'Recently';
  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min${diffMin > 1 ? 's' : ''} ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function resolveCoverUrl(cover?: string): string | null {
  if (!cover) return null;
  if (
    cover.startsWith('data:') ||
    cover.startsWith('blob:') ||
    cover.startsWith('http://') ||
    cover.startsWith('https://')
  ) {
    return cover;
  }
  try {
    return convertFileSrc(cover);
  } catch {
    return cover;
  }
}

export async function createThumbnailDataUrl(file: File, maxWidth = 480, maxHeight = 720): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.max(1, Math.round(width * ratio));
          height = Math.max(1, Math.round(height * ratio));
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

export function loadRecentProjects(): MangaProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: any) => ({
      ...item,
      lastEdited: formatRelativeTime(item.lastEditedTimestamp || Date.now()),
      isMissing: Boolean(item.isMissing)
    }));
  } catch {
    return [];
  }
}

export function saveRecentProjects(projects: MangaProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (e) {
    console.error('Failed to save recent projects to localStorage', e);
  }
}

export function addOrUpdateRecentProject(
  projectData: Partial<MangaProject> & { seriesTitle: string; folderPath: string }
): MangaProject[] {
  const current = loadRecentProjects();
  const id = projectData.id || `proj_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = Date.now();

  const existingIndex = current.findIndex(
    p => p.id === id || (p.folderPath && p.folderPath.toLowerCase() === projectData.folderPath.toLowerCase())
  );

  const updatedItem: MangaProject = {
    id: existingIndex >= 0 ? current[existingIndex].id : id,
    seriesTitle: projectData.seriesTitle,
    chapterTitle: projectData.chapterTitle || 'Chapter 1',
    chapterNumber: projectData.chapterNumber || 1,
    coverImage: projectData.coverImage || (existingIndex >= 0 ? current[existingIndex].coverImage : undefined),
    pagesCount: projectData.pagesCount ?? (existingIndex >= 0 ? current[existingIndex].pagesCount : 1),
    completedPages: projectData.completedPages ?? (existingIndex >= 0 ? current[existingIndex].completedPages : 0),
    progressPercent: projectData.progressPercent ?? (existingIndex >= 0 ? current[existingIndex].progressPercent : 0),
    status: projectData.status || (existingIndex >= 0 ? current[existingIndex].status : 'detected'),
    statusLabel: projectData.statusLabel || (existingIndex >= 0 ? current[existingIndex].statusLabel : 'Detected / Pending Review'),
    sourceLang: projectData.sourceLang || 'JA',
    targetLang: projectData.targetLang || 'ID',
    lastEdited: 'Just now',
    lastEditedTimestamp: now,
    folderPath: projectData.folderPath,
    preset: projectData.preset || 'Seinen High-Detail',
    isMissing: false
  };

  let nextList: MangaProject[];
  if (existingIndex >= 0) {
    nextList = [updatedItem, ...current.filter((_, idx) => idx !== existingIndex)];
  } else {
    nextList = [updatedItem, ...current];
  }

  // Limit to 50 most recent items
  if (nextList.length > 50) {
    nextList = nextList.slice(0, 50);
  }

  saveRecentProjects(nextList);
  return nextList;
}

export function updateProjectCover(id: string, coverImage: string): MangaProject[] {
  const current = loadRecentProjects();
  const updated = current.map(p => {
    if (p.id === id) {
      return { ...p, coverImage, lastEditedTimestamp: Date.now(), lastEdited: 'Just now' };
    }
    return p;
  });
  saveRecentProjects(updated);
  return updated;
}

export function updateProjectInfo(
  id: string,
  info: Partial<Pick<MangaProject, 'seriesTitle' | 'chapterNumber' | 'chapterTitle' | 'sourceLang' | 'targetLang' | 'preset'>>
): MangaProject[] {
  const current = loadRecentProjects();
  const updated = current.map(p => {
    if (p.id === id) {
      return {
        ...p,
        ...info,
        lastEditedTimestamp: Date.now(),
        lastEdited: 'Just now'
      };
    }
    return p;
  });
  saveRecentProjects(updated);
  return updated;
}

export function removeRecentProject(id: string): MangaProject[] {
  const current = loadRecentProjects();
  const filtered = current.filter(p => p.id !== id);
  saveRecentProjects(filtered);
  return filtered;
}

export async function validateRecentProjects(
  projects: MangaProject[],
  api: Api | null
): Promise<MangaProject[]> {
  if (!projects.length || !api) return projects;
  try {
    const pathsToCheck = projects.map(p => p.folderPath).filter(Boolean);
    if (!pathsToCheck.length) return projects;
    const validationMap = await api.validatePaths(pathsToCheck);
    
    let hasChanges = false;
    const validated = projects.map(p => {
      if (!p.folderPath) return p;
      const exists = validationMap[p.folderPath];
      const isMissing = exists === false;
      if (p.isMissing !== isMissing) {
        hasChanges = true;
        return { ...p, isMissing };
      }
      return p;
    });

    if (hasChanges) {
      saveRecentProjects(validated);
    }
    return validated;
  } catch {
    return projects;
  }
}
