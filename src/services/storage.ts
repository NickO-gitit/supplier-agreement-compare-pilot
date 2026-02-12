import type { Comparison, Note } from '../types';

const STORAGE_KEY = 'supplier-agreement-comparisons';
const NOTES_KEY = 'supplier-agreement-notes';
const API_CONFIG_KEY = 'supplier-agreement-api-config';

export function saveComparison(comparison: Comparison): void {
  const comparisons = getComparisons();
  const existingIndex = comparisons.findIndex((c) => c.id === comparison.id);

  if (existingIndex >= 0) {
    comparisons[existingIndex] = comparison;
  } else {
    comparisons.unshift(comparison);
  }

  // Keep only last 50 comparisons
  const trimmed = comparisons.slice(0, 50);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

export function getComparisons(): Comparison[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];

    const parsed = JSON.parse(data);
    return parsed.map((c: Comparison) => ({
      ...c,
      createdAt: new Date(c.createdAt),
    }));
  } catch {
    return [];
  }
}

export function getComparison(id: string): Comparison | null {
  const comparisons = getComparisons();
  return comparisons.find((c) => c.id === id) || null;
}

export function deleteComparison(id: string): void {
  const comparisons = getComparisons();
  const filtered = comparisons.filter((c) => c.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));

  // Also delete associated notes
  deleteNotesForComparison(id);
}

// Notes storage
export function saveNote(comparisonId: string, note: Note): void {
  const allNotes = getAllNotes();
  const comparisonNotes = allNotes[comparisonId] || [];

  const existingIndex = comparisonNotes.findIndex((n) => n.id === note.id);
  if (existingIndex >= 0) {
    comparisonNotes[existingIndex] = note;
  } else {
    comparisonNotes.push(note);
  }

  allNotes[comparisonId] = comparisonNotes;
  localStorage.setItem(NOTES_KEY, JSON.stringify(allNotes));
}

export function getNotesForComparison(comparisonId: string): Note[] {
  const allNotes = getAllNotes();
  const notes = allNotes[comparisonId] || [];

  return notes.map((n) => ({
    ...n,
    createdAt: new Date(n.createdAt),
    updatedAt: new Date(n.updatedAt),
  }));
}

export function deleteNote(comparisonId: string, noteId: string): void {
  const allNotes = getAllNotes();
  const comparisonNotes = allNotes[comparisonId] || [];
  allNotes[comparisonId] = comparisonNotes.filter((n) => n.id !== noteId);
  localStorage.setItem(NOTES_KEY, JSON.stringify(allNotes));
}

export function deleteNotesForComparison(comparisonId: string): void {
  const allNotes = getAllNotes();
  delete allNotes[comparisonId];
  localStorage.setItem(NOTES_KEY, JSON.stringify(allNotes));
}

function getAllNotes(): Record<string, Note[]> {
  try {
    const data = localStorage.getItem(NOTES_KEY);
    if (!data) return {};
    return JSON.parse(data);
  } catch {
    return {};
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
  localStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
}

export function getAPIConfig(): APIConfig | null {
  try {
    const data = localStorage.getItem(API_CONFIG_KEY);
    if (!data) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function clearAPIConfig(): void {
  localStorage.removeItem(API_CONFIG_KEY);
}

// Generate unique IDs
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
