import type {
  ChangeResponse,
  ChangeResponseStatus,
  Comparison,
  DefaultOriginalAgreement,
  Note,
  Project,
  ProjectColor,
} from '../types';

const PROJECTS_KEY = 'supplier-agreement-projects';
const API_CONFIG_KEY = 'supplier-agreement-api-config';
const LEGACY_API_CONFIG_KEYS = ['supplier-agreement-config', 'openai-config'];
const DEFAULT_ORIGINAL_KEY = 'supplier-agreement-default-original';
const BACKEND_STORAGE_URL = '/api/storage';

const LEGACY_CUSTOMERS_KEY = 'supplier-agreement-customers';
const LEGACY_COMPARISONS_KEY = 'supplier-agreement-comparisons';
const LEGACY_NOTES_KEY = 'supplier-agreement-notes';
const LEGACY_CHANGE_RESPONSES_KEY = 'supplier-agreement-change-responses';

const PROJECT_COMPARISONS_PREFIX = 'supplier-agreement-comparisons:project:';
const PROJECT_NOTES_PREFIX = 'supplier-agreement-notes:project:';
const PROJECT_CHANGE_RESPONSES_PREFIX = 'supplier-agreement-change-responses:project:';

const PROJECT_COLORS: ProjectColor[] = ['blue', 'emerald', 'violet', 'orange', 'rose', 'cyan'];
const memoryStore: Record<string, string> = {};
let storageModelInitialized = false;
let storageModelInitializationInProgress = false;

type NotesByComparison = Record<string, Note[]>;
type ChangeResponsesByComparison = Record<string, ChangeResponse[]>;

function getStoredValue(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
}

function setStoredValue(key: string, value: string): void {
  memoryStore[key] = value;
}

function removeStoredValue(key: string): void {
  delete memoryStore[key];
}

function parseDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function normalizeComparison(raw: Comparison | Record<string, unknown>): Comparison {
  const comparison = raw as Comparison;
  const projectId =
    (typeof comparison.projectId === 'string' && comparison.projectId.trim()) ||
    (typeof comparison.customerId === 'string' && comparison.customerId.trim()) ||
    '';

  return {
    ...comparison,
    projectId,
    title: typeof comparison.title === 'string' && comparison.title.trim().length > 0
      ? comparison.title
      : null,
    createdAt: parseDate(comparison.createdAt),
    originalDocument: comparison.originalDocument
      ? {
          ...comparison.originalDocument,
          uploadedAt: parseDate(comparison.originalDocument.uploadedAt),
        }
      : null,
    proposedDocument: comparison.proposedDocument
      ? {
          ...comparison.proposedDocument,
          uploadedAt: parseDate(comparison.proposedDocument.uploadedAt),
        }
      : null,
    riskAnalyses: (comparison.riskAnalyses || []).map((risk) => ({
      ...risk,
      analyzedAt: parseDate(risk.analyzedAt),
      manualOverrideAt: risk.manualOverrideAt ? parseDate(risk.manualOverrideAt) : undefined,
    })),
    groupingReviews: comparison.groupingReviews || [],
    groupingActionLogs: (comparison.groupingActionLogs || []).map((log) => ({
      ...log,
      runAt: parseDate(log.runAt),
    })),
    notes: (comparison.notes || []).map((note) => ({
      ...note,
      createdAt: parseDate(note.createdAt),
      updatedAt: parseDate(note.updatedAt),
    })),
    changeResponses: (comparison.changeResponses || []).map((response) => ({
      ...response,
      excludeFromExport: !!response.excludeFromExport,
      createdAt: parseDate(response.createdAt),
      updatedAt: parseDate(response.updatedAt),
    })),
  };
}

function parseComparisonList(raw: string | null): Comparison[] {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Comparison[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeComparison(entry))
      .filter((entry) => entry.projectId);
  } catch {
    return [];
  }
}

function parseProjectList(raw: string | null): Project[] {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Project[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((project) => ({
        ...project,
        createdAt: parseDate(project.createdAt),
      }))
      .filter((project) => typeof project.id === 'string' && typeof project.name === 'string');
  } catch {
    return [];
  }
}

function parseNotesByComparison(raw: string | null): NotesByComparison {
  try {
    if (!raw) return {};
    const parsed = JSON.parse(raw) as NotesByComparison;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function parseChangeResponsesByComparison(raw: string | null): ChangeResponsesByComparison {
  try {
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ChangeResponsesByComparison;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function projectsComparisonsKey(projectId: string): string {
  return `${PROJECT_COMPARISONS_PREFIX}${projectId}`;
}

function projectsNotesKey(projectId: string): string {
  return `${PROJECT_NOTES_PREFIX}${projectId}`;
}

function projectsChangeResponsesKey(projectId: string): string {
  return `${PROJECT_CHANGE_RESPONSES_PREFIX}${projectId}`;
}

function extractProjectIdFromScopedKey(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const projectId = key.slice(prefix.length).trim();
  return projectId || null;
}

function getKnownProjectIds(): string[] {
  const ids = new Set<string>();

  parseProjectList(getStoredValue(PROJECTS_KEY)).forEach((project) => ids.add(project.id));

  Object.keys(memoryStore).forEach((key) => {
    const fromComparisons = extractProjectIdFromScopedKey(key, PROJECT_COMPARISONS_PREFIX);
    if (fromComparisons) ids.add(fromComparisons);

    const fromNotes = extractProjectIdFromScopedKey(key, PROJECT_NOTES_PREFIX);
    if (fromNotes) ids.add(fromNotes);

    const fromResponses = extractProjectIdFromScopedKey(key, PROJECT_CHANGE_RESPONSES_PREFIX);
    if (fromResponses) ids.add(fromResponses);
  });

  return Array.from(ids);
}

function getProjectComparisons(projectId: string): Comparison[] {
  return parseComparisonList(getStoredValue(projectsComparisonsKey(projectId)));
}

function saveProjectComparisons(projectId: string, comparisons: Comparison[]): void {
  setStoredValue(projectsComparisonsKey(projectId), JSON.stringify(comparisons));
  syncKeyToBackend(projectsComparisonsKey(projectId));
}

function getNotesByComparisonForKey(key: string): NotesByComparison {
  return parseNotesByComparison(getStoredValue(key));
}

function saveNotesByComparisonForKey(key: string, payload: NotesByComparison): void {
  setStoredValue(key, JSON.stringify(payload));
  syncKeyToBackend(key);
}

function getChangeResponsesForKey(key: string): ChangeResponsesByComparison {
  return parseChangeResponsesByComparison(getStoredValue(key));
}

function saveChangeResponsesForKey(key: string, payload: ChangeResponsesByComparison): void {
  setStoredValue(key, JSON.stringify(payload));
  syncKeyToBackend(key);
}

function parseLegacyComparisons(): Comparison[] {
  return parseComparisonList(getStoredValue(LEGACY_COMPARISONS_KEY));
}

function dedupeComparisons(entries: Comparison[]): Comparison[] {
  const byId = new Map<string, Comparison>();
  entries.forEach((entry) => {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      return;
    }

    const existingTime = new Date(existing.createdAt).getTime();
    const nextTime = new Date(entry.createdAt).getTime();
    if (nextTime >= existingTime) {
      byId.set(entry.id, entry);
    }
  });

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

function buildComparisonProjectMap(): Record<string, string> {
  const map: Record<string, string> = {};

  getKnownProjectIds().forEach((projectId) => {
    getProjectComparisons(projectId).forEach((comparison) => {
      if (!map[comparison.id]) {
        map[comparison.id] = projectId;
      }
    });
  });

  parseLegacyComparisons().forEach((comparison) => {
    if (!map[comparison.id] && comparison.projectId) {
      map[comparison.id] = comparison.projectId;
    }
  });

  return map;
}

function findProjectIdForComparison(comparisonId: string): string | null {
  const map = buildComparisonProjectMap();
  return map[comparisonId] || null;
}

function ensureStorageModelInitialized(force = false): void {
  if (storageModelInitialized && !force) {
    return;
  }
  if (storageModelInitializationInProgress) {
    return;
  }

  storageModelInitializationInProgress = true;
  try {
    migrateLegacyProjects();
    migrateLegacyComparisons();
    migrateLegacyNotes();
    migrateLegacyChangeResponses();
    storageModelInitialized = true;
  } finally {
    storageModelInitializationInProgress = false;
  }
}

function migrateLegacyProjects(): void {
  const currentProjects = parseProjectList(getStoredValue(PROJECTS_KEY));
  const legacyProjects = parseProjectList(getStoredValue(LEGACY_CUSTOMERS_KEY));

  if (legacyProjects.length === 0) {
    return;
  }

  const merged = [...currentProjects];
  legacyProjects.forEach((legacyProject) => {
    if (!merged.some((project) => project.id === legacyProject.id)) {
      merged.push(legacyProject);
    }
  });

  if (merged.length !== currentProjects.length) {
    setStoredValue(PROJECTS_KEY, JSON.stringify(merged));
    syncKeyToBackend(PROJECTS_KEY);
  }
}

function migrateLegacyComparisons(): void {
  const legacyComparisons = parseLegacyComparisons();
  if (legacyComparisons.length === 0) {
    return;
  }

  const groupedByProject: Record<string, Comparison[]> = {};
  legacyComparisons.forEach((comparison) => {
    if (!comparison.projectId) return;
    if (!groupedByProject[comparison.projectId]) {
      groupedByProject[comparison.projectId] = [];
    }
    groupedByProject[comparison.projectId].push(comparison);
  });

  Object.entries(groupedByProject).forEach(([projectId, legacyEntries]) => {
    const current = getProjectComparisons(projectId);
    const map = new Map<string, Comparison>();
    current.forEach((comparison) => map.set(comparison.id, comparison));
    legacyEntries.forEach((comparison) => {
      if (!map.has(comparison.id)) {
        map.set(comparison.id, comparison);
      }
    });

    if (map.size !== current.length) {
      saveProjectComparisons(projectId, dedupeComparisons(Array.from(map.values())));
    }
  });
}

function migrateLegacyNotes(): void {
  const legacy = getNotesByComparisonForKey(LEGACY_NOTES_KEY);
  const comparisonProjectMap = buildComparisonProjectMap();
  const groupedByProject: Record<string, NotesByComparison> = {};

  Object.entries(legacy).forEach(([comparisonId, notes]) => {
    const projectId = comparisonProjectMap[comparisonId];
    if (!projectId) return;
    groupedByProject[projectId] = groupedByProject[projectId] || {};
    groupedByProject[projectId][comparisonId] = notes;
  });

  Object.entries(groupedByProject).forEach(([projectId, notesByComparison]) => {
    const key = projectsNotesKey(projectId);
    const current = getNotesByComparisonForKey(key);
    let changed = false;

    Object.entries(notesByComparison).forEach(([comparisonId, notes]) => {
      if (!current[comparisonId]) {
        current[comparisonId] = notes;
        changed = true;
      }
    });

    if (changed) {
      saveNotesByComparisonForKey(key, current);
    }
  });
}

function migrateLegacyChangeResponses(): void {
  const legacy = getChangeResponsesForKey(LEGACY_CHANGE_RESPONSES_KEY);
  const comparisonProjectMap = buildComparisonProjectMap();
  const groupedByProject: Record<string, ChangeResponsesByComparison> = {};

  Object.entries(legacy).forEach(([comparisonId, responses]) => {
    const projectId = comparisonProjectMap[comparisonId];
    if (!projectId) return;
    groupedByProject[projectId] = groupedByProject[projectId] || {};
    groupedByProject[projectId][comparisonId] = responses;
  });

  Object.entries(groupedByProject).forEach(([projectId, responsesByComparison]) => {
    const key = projectsChangeResponsesKey(projectId);
    const current = getChangeResponsesForKey(key);
    let changed = false;

    Object.entries(responsesByComparison).forEach(([comparisonId, responses]) => {
      if (!current[comparisonId]) {
        current[comparisonId] = responses;
        changed = true;
      }
    });

    if (changed) {
      saveChangeResponsesForKey(key, current);
    }
  });
}

export function saveComparison(comparison: Comparison): void {
  ensureStorageModelInitialized();

  const projectId =
    (comparison.projectId || comparison.customerId || '').trim();
  if (!projectId) {
    throw new Error('Comparison is missing projectId.');
  }

  const normalized = normalizeComparison({
    ...comparison,
    projectId,
  });

  const projectComparisons = getProjectComparisons(projectId);
  const next = [normalized, ...projectComparisons.filter((entry) => entry.id !== normalized.id)].slice(
    0,
    50
  );

  saveProjectComparisons(projectId, next);
}

export function getComparisons(): Comparison[] {
  ensureStorageModelInitialized();

  const projectIds = getKnownProjectIds();
  const scopedComparisons = projectIds.flatMap((projectId) => getProjectComparisons(projectId));
  if (scopedComparisons.length > 0) {
    return dedupeComparisons(scopedComparisons);
  }

  return dedupeComparisons(parseLegacyComparisons());
}

export function getComparison(id: string): Comparison | null {
  const comparisons = getComparisons();
  return comparisons.find((c) => c.id === id) || null;
}

export function deleteComparison(id: string): void {
  ensureStorageModelInitialized();

  const projectIds = getKnownProjectIds();
  projectIds.forEach((projectId) => {
    const current = getProjectComparisons(projectId);
    const filtered = current.filter((entry) => entry.id !== id);
    if (filtered.length !== current.length) {
      saveProjectComparisons(projectId, filtered);
    }
  });

  const legacyComparisons = parseLegacyComparisons();
  const filteredLegacy = legacyComparisons.filter((entry) => entry.id !== id);
  if (filteredLegacy.length !== legacyComparisons.length) {
    setStoredValue(LEGACY_COMPARISONS_KEY, JSON.stringify(filteredLegacy));
    syncKeyToBackend(LEGACY_COMPARISONS_KEY);
  }

  deleteNotesForComparison(id);
  clearChangeResponsesForComparison(id);
}

// Notes storage
export function saveNote(comparisonId: string, note: Note): void {
  ensureStorageModelInitialized();

  const projectId = findProjectIdForComparison(comparisonId);
  const storageKey = projectId ? projectsNotesKey(projectId) : LEGACY_NOTES_KEY;
  const allNotes = getNotesByComparisonForKey(storageKey);
  const comparisonNotes = allNotes[comparisonId] || [];

  const existingIndex = comparisonNotes.findIndex((n) => n.id === note.id);
  if (existingIndex >= 0) {
    comparisonNotes[existingIndex] = note;
  } else {
    comparisonNotes.push(note);
  }

  allNotes[comparisonId] = comparisonNotes;
  saveNotesByComparisonForKey(storageKey, allNotes);
}

export function getNotesForComparison(comparisonId: string): Note[] {
  ensureStorageModelInitialized();

  const projectId = findProjectIdForComparison(comparisonId);
  const storageKey = projectId ? projectsNotesKey(projectId) : LEGACY_NOTES_KEY;
  const allNotes = getNotesByComparisonForKey(storageKey);
  const notes = allNotes[comparisonId] || [];

  return notes.map((n) => ({
    ...n,
    createdAt: parseDate(n.createdAt),
    updatedAt: parseDate(n.updatedAt),
  }));
}

export function deleteNote(comparisonId: string, noteId: string): void {
  ensureStorageModelInitialized();

  const projectId = findProjectIdForComparison(comparisonId);
  const storageKey = projectId ? projectsNotesKey(projectId) : LEGACY_NOTES_KEY;
  const allNotes = getNotesByComparisonForKey(storageKey);
  const existing = allNotes[comparisonId] || [];
  allNotes[comparisonId] = existing.filter((entry) => entry.id !== noteId);
  saveNotesByComparisonForKey(storageKey, allNotes);
}

export function deleteNotesForComparison(comparisonId: string): void {
  ensureStorageModelInitialized();

  getKnownProjectIds().forEach((projectId) => {
    const key = projectsNotesKey(projectId);
    const allNotes = getNotesByComparisonForKey(key);
    if (Object.prototype.hasOwnProperty.call(allNotes, comparisonId)) {
      delete allNotes[comparisonId];
      saveNotesByComparisonForKey(key, allNotes);
    }
  });

  const legacyNotes = getNotesByComparisonForKey(LEGACY_NOTES_KEY);
  if (Object.prototype.hasOwnProperty.call(legacyNotes, comparisonId)) {
    delete legacyNotes[comparisonId];
    saveNotesByComparisonForKey(LEGACY_NOTES_KEY, legacyNotes);
  }
}

// API Configuration storage
export interface APIConfig {
  apiKey: string;
  isAzure: boolean;
  endpoint?: string;
  deploymentName?: string;
  model?: string;
}

export function saveAPIConfig(config: APIConfig): void {
  // Note: In production, you'd want to encrypt this or use a more secure method
  const serialized = JSON.stringify(config);
  setStoredValue(API_CONFIG_KEY, serialized);
  // Write-through to legacy key for backwards compatibility across older builds.
  setStoredValue(LEGACY_API_CONFIG_KEYS[0], serialized);
  syncKeyToBackend(API_CONFIG_KEY);
  syncKeyToBackend(LEGACY_API_CONFIG_KEYS[0]);
}

export function getAPIConfig(): APIConfig | null {
  try {
    const candidates = [API_CONFIG_KEY, ...LEGACY_API_CONFIG_KEYS];
    for (const key of candidates) {
      const data = getStoredValue(key);
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && typeof parsed.apiKey === 'string') {
        return parsed as APIConfig;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function clearAPIConfig(): void {
  removeStoredValue(API_CONFIG_KEY);
  syncValueToBackend(API_CONFIG_KEY, null);
  for (const key of LEGACY_API_CONFIG_KEYS) {
    removeStoredValue(key);
    syncValueToBackend(key, null);
  }
}

export function deriveInitials(name: string): string {
  const tokens = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return `${tokens[0][0] || ''}${tokens[1][0] || ''}`.toUpperCase();
}

export function getProjects(): Project[] {
  ensureStorageModelInitialized();
  return parseProjectList(getStoredValue(PROJECTS_KEY));
}

export function saveProject(project: Project): void {
  const projects = getProjects();
  const index = projects.findIndex((entry) => entry.id === project.id);
  if (index >= 0) {
    projects[index] = project;
  } else {
    projects.push(project);
  }
  setStoredValue(PROJECTS_KEY, JSON.stringify(projects));
  syncKeyToBackend(PROJECTS_KEY);
}

export function createProject(name: string, initialsOverride?: string): Project {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Project name is required.');
  }

  const existing = getProjects();
  const duplicate = existing.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  if (duplicate) {
    return duplicate;
  }

  const color = PROJECT_COLORS[existing.length % PROJECT_COLORS.length];
  const initials = (initialsOverride?.trim() || deriveInitials(trimmed)).slice(0, 2).toUpperCase();
  const project: Project = {
    id: generateId(),
    name: trimmed,
    color,
    initials,
    createdAt: new Date(),
  };
  saveProject(project);
  return project;
}

export function updateProject(
  id: string,
  update: Partial<Pick<Project, 'name' | 'color' | 'initials'>>
): Project | null {
  const projects = getProjects();
  const index = projects.findIndex((entry) => entry.id === id);
  if (index < 0) return null;

  const current = projects[index];
  const next: Project = {
    ...current,
    ...update,
    initials: (update.initials || current.initials).slice(0, 2).toUpperCase(),
  };
  projects[index] = next;
  setStoredValue(PROJECTS_KEY, JSON.stringify(projects));
  syncKeyToBackend(PROJECTS_KEY);
  return next;
}

export function getChangeResponsesForComparison(comparisonId: string): ChangeResponse[] {
  ensureStorageModelInitialized();

  const projectId = findProjectIdForComparison(comparisonId);
  const storageKey = projectId ? projectsChangeResponsesKey(projectId) : LEGACY_CHANGE_RESPONSES_KEY;
  const all = getChangeResponsesForKey(storageKey);
  const responses = all[comparisonId] || [];
  return responses.map((entry) => ({
    ...entry,
    excludeFromExport: !!entry.excludeFromExport,
    createdAt: parseDate(entry.createdAt),
    updatedAt: parseDate(entry.updatedAt),
  }));
}

export function saveChangeResponse(
  comparisonId: string,
  changeId: string,
  status: ChangeResponseStatus,
  comment: string | null,
  options?: { excludeFromExport?: boolean }
): ChangeResponse {
  ensureStorageModelInitialized();

  const projectId = findProjectIdForComparison(comparisonId);
  const storageKey = projectId ? projectsChangeResponsesKey(projectId) : LEGACY_CHANGE_RESPONSES_KEY;
  const all = getChangeResponsesForKey(storageKey);
  const responses = (all[comparisonId] || []).map((entry) => ({
    ...entry,
    createdAt: parseDate(entry.createdAt),
    updatedAt: parseDate(entry.updatedAt),
  }));

  const index = responses.findIndex((entry) => entry.changeId === changeId);
  const now = new Date();

  if (index >= 0) {
    responses[index] = {
      ...responses[index],
      status,
      comment,
      excludeFromExport:
        status === 'ignored'
          ? !!options?.excludeFromExport
          : false,
      updatedAt: now,
    };
  } else {
    responses.push({
      id: generateId(),
      comparisonId,
      changeId,
      status,
      comment,
      excludeFromExport:
        status === 'ignored'
          ? !!options?.excludeFromExport
          : false,
      createdAt: now,
      updatedAt: now,
    });
  }

  all[comparisonId] = responses;
  saveChangeResponsesForKey(storageKey, all);
  return responses.find((entry) => entry.changeId === changeId)!;
}

export function clearChangeResponse(comparisonId: string, changeId: string): void {
  ensureStorageModelInitialized();

  const projectId = findProjectIdForComparison(comparisonId);
  const primaryStorageKey = projectId
    ? projectsChangeResponsesKey(projectId)
    : LEGACY_CHANGE_RESPONSES_KEY;

  const primary = getChangeResponsesForKey(primaryStorageKey);
  const primaryResponses = primary[comparisonId] || [];
  primary[comparisonId] = primaryResponses.filter((entry) => entry.changeId !== changeId);
  saveChangeResponsesForKey(primaryStorageKey, primary);

  if (primaryStorageKey !== LEGACY_CHANGE_RESPONSES_KEY) {
    const legacy = getChangeResponsesForKey(LEGACY_CHANGE_RESPONSES_KEY);
    const legacyResponses = legacy[comparisonId] || [];
    legacy[comparisonId] = legacyResponses.filter((entry) => entry.changeId !== changeId);
    saveChangeResponsesForKey(LEGACY_CHANGE_RESPONSES_KEY, legacy);
  }
}

function clearChangeResponsesForComparison(comparisonId: string): void {
  getKnownProjectIds().forEach((projectId) => {
    const key = projectsChangeResponsesKey(projectId);
    const all = getChangeResponsesForKey(key);
    if (Object.prototype.hasOwnProperty.call(all, comparisonId)) {
      delete all[comparisonId];
      saveChangeResponsesForKey(key, all);
    }
  });

  const legacy = getChangeResponsesForKey(LEGACY_CHANGE_RESPONSES_KEY);
  if (Object.prototype.hasOwnProperty.call(legacy, comparisonId)) {
    delete legacy[comparisonId];
    saveChangeResponsesForKey(LEGACY_CHANGE_RESPONSES_KEY, legacy);
  }
}

export function saveDefaultOriginalAgreement(document: DefaultOriginalAgreement): void {
  setStoredValue(DEFAULT_ORIGINAL_KEY, JSON.stringify(document));
  syncKeyToBackend(DEFAULT_ORIGINAL_KEY);
}

export function getDefaultOriginalAgreement(): DefaultOriginalAgreement | null {
  try {
    const data = getStoredValue(DEFAULT_ORIGINAL_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data) as DefaultOriginalAgreement;
    return {
      ...parsed,
      uploadedAt: parseDate(parsed.uploadedAt),
    };
  } catch {
    return null;
  }
}

export function clearDefaultOriginalAgreement(): void {
  removeStoredValue(DEFAULT_ORIGINAL_KEY);
  syncValueToBackend(DEFAULT_ORIGINAL_KEY, null);
}

export async function hydrateFromBackend(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return;
  }

  try {
    const response = await fetch(BACKEND_STORAGE_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (!data || typeof data !== 'object') {
      return;
    }

    Object.entries(data).forEach(([key, value]) => {
      if (typeof value === 'string') {
        setStoredValue(key, value);
      }
    });

    ensureStorageModelInitialized(true);
  } catch {
    // Backend unavailable, continue with local browser cache.
  }
}

function syncKeyToBackend(key: string): void {
  const value = getStoredValue(key);
  syncValueToBackend(key, value);
}

function syncValueToBackend(key: string, value: string | null): void {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return;
  }

  void fetch(BACKEND_STORAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).catch(() => {
    // Ignore transient sync errors.
  });
}

// Generate unique IDs
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Legacy aliases for older code paths.
export function getCustomers(): Project[] {
  return getProjects();
}

export function saveCustomer(project: Project): void {
  saveProject(project);
}

export function createCustomer(name: string, initialsOverride?: string): Project {
  return createProject(name, initialsOverride);
}

export function updateCustomer(
  id: string,
  update: Partial<Pick<Project, 'name' | 'color' | 'initials'>>
): Project | null {
  return updateProject(id, update);
}

