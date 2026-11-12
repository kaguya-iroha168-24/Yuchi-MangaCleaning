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
  imagePaths?: string[];
  lastActivePage?: string;
  preset: string;
  isMissing?: boolean;
}

const STORAGE_KEY = 'mangaclean_atelier_recent_projects_v2';

export function normalizePath(path?: string): string {
  if (!path) return '';
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function deduplicateProjects(list: MangaProject[]): MangaProject[] {
  const seenPaths = new Set<string>();
  const seenSeries = new Set<string>();
  const seenIds = new Set<string>();
  const deduplicated: MangaProject[] = [];

  // Sort by latest timestamp first so the most recent edit wins
  const sorted = [...list].sort((a, b) => (b.lastEditedTimestamp || 0) - (a.lastEditedTimestamp || 0));

  for (const p of sorted) {
    if (seenIds.has(p.id)) continue;

    const normPath = normalizePath(p.folderPath);
    const seriesKey = `${(p.seriesTitle || '').trim().toLowerCase()}__ch_${p.chapterNumber || 1}`;

    if (normPath && seenPaths.has(normPath)) {
      continue;
    }
    if (seriesKey && seenSeries.has(seriesKey)) {
      continue;
    }

    seenIds.add(p.id);
    if (normPath) seenPaths.add(normPath);
    if (seriesKey) seenSeries.add(seriesKey);
    deduplicated.push(p);
  }

  return deduplicated;
}

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
    const formatted = parsed.map((item: any) => ({
      ...item,
      pagesCount: Number(item.pagesCount) || 0,
      progressPercent: Number(item.progressPercent) || 0,
      lastEdited: formatRelativeTime(item.lastEditedTimestamp || Date.now()),
      isMissing: Boolean(item.isMissing)
    }));
    const deduped = deduplicateProjects(formatted);
    if (deduped.length !== parsed.length) {
      saveRecentProjects(deduped);
    }
    return deduped;
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
  projectData: Partial<MangaProject> & { seriesTitle: string }
): MangaProject[] {
  const current = loadRecentProjects();
  const id = projectData.id || `proj_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = Date.now();
  const normFolder = normalizePath(projectData.folderPath);

  const existingIndex = current.findIndex(p => {
    if (projectData.id && p.id === projectData.id) return true;
    if (normFolder && p.folderPath && normalizePath(p.folderPath) === normFolder) return true;
    if (
      p.seriesTitle &&
      projectData.seriesTitle &&
      p.seriesTitle.trim().toLowerCase() === projectData.seriesTitle.trim().toLowerCase() &&
      p.chapterNumber === projectData.chapterNumber
    ) {
      return true;
    }
    return false;
  });

  const existing = existingIndex >= 0 ? current[existingIndex] : null;

  const updatedItem: MangaProject = {
    id: existing ? existing.id : id,
    seriesTitle: projectData.seriesTitle || (existing ? existing.seriesTitle : 'Untitled Series'),
    chapterTitle: projectData.chapterTitle || (existing ? existing.chapterTitle : `Chapter ${projectData.chapterNumber || 1}`),
    chapterNumber: projectData.chapterNumber ?? (existing ? existing.chapterNumber : 1),
    coverImage: projectData.coverImage || (existing ? existing.coverImage : undefined),
    pagesCount: (projectData.pagesCount !== undefined && projectData.pagesCount > 0)
      ? projectData.pagesCount
      : (existing && existing.pagesCount > 0 ? existing.pagesCount : (projectData.pagesCount ?? 0)),
    completedPages: projectData.completedPages ?? (existing ? existing.completedPages : 0),
    progressPercent: projectData.progressPercent ?? (existing ? existing.progressPercent : 0),
    status: projectData.status || (existing ? existing.status : 'detected'),
    statusLabel: projectData.statusLabel || (existing ? existing.statusLabel : 'Detected / Pending Review'),
    sourceLang: projectData.sourceLang || (existing ? existing.sourceLang : 'JA'),
    targetLang: projectData.targetLang || (existing ? existing.targetLang : 'ID'),
    lastEdited: 'Just now',
    lastEditedTimestamp: now,
    folderPath: projectData.folderPath || (existing ? existing.folderPath : ''),
    imagePaths: projectData.imagePaths || (existing ? existing.imagePaths : undefined),
    lastActivePage: projectData.lastActivePage || (existing ? existing.lastActivePage : undefined),
    preset: projectData.preset || (existing ? existing.preset : 'Seinen High-Detail'),
    isMissing: false
  };

  let nextList: MangaProject[];
  if (existingIndex >= 0) {
    nextList = [updatedItem, ...current.filter((_, idx) => idx !== existingIndex)];
  } else {
    nextList = [updatedItem, ...current];
  }

  nextList = deduplicateProjects(nextList);
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
  info: Partial<MangaProject>
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
