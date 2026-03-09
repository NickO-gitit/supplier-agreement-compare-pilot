import type {
  ChangeResponse,
  ChangeResponseStatus,
  Comparison,
  Customer,
  CustomerColor,
  DefaultOriginalAgreement,
  Note,
} from '../types';

const STORAGE_KEY = 'supplier-agreement-comparisons';
const NOTES_KEY = 'supplier-agreement-notes';
const API_CONFIG_KEY = 'supplier-agreement-api-config';
const LEGACY_API_CONFIG_KEYS = ['supplier-agreement-config', 'openai-config'];
const CUSTOMERS_KEY = 'supplier-agreement-customers';
const CHANGE_RESPONSES_KEY = 'supplier-agreement-change-responses';
const DEFAULT_ORIGINAL_KEY = 'supplier-agreement-default-original';
const CUSTOMER_COLORS: CustomerColor[] = ['blue', 'emerald', 'violet', 'orange', 'rose', 'cyan'];

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
      createdAt: parseDate(c.createdAt),
      customerId: c.customerId || '',
      originalDocument: c.originalDocument
        ? {
            ...c.originalDocument,
            uploadedAt: parseDate(c.originalDocument.uploadedAt),
          }
        : null,
      proposedDocument: c.proposedDocument
        ? {
            ...c.proposedDocument,
            uploadedAt: parseDate(c.proposedDocument.uploadedAt),
          }
        : null,
      riskAnalyses: (c.riskAnalyses || []).map((risk) => ({
        ...risk,
        analyzedAt: parseDate(risk.analyzedAt),
      })),
      groupingReviews: c.groupingReviews || [],
      groupingActionLogs: (c.groupingActionLogs || []).map((log) => ({
        ...log,
        runAt: parseDate(log.runAt),
      })),
      changeResponses: (c.changeResponses || []).map((response) => ({
        ...response,
        createdAt: parseDate(response.createdAt),
        updatedAt: parseDate(response.updatedAt),
      })),
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
    createdAt: parseDate(n.createdAt),
    updatedAt: parseDate(n.updatedAt),
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
  const serialized = JSON.stringify(config);
  localStorage.setItem(API_CONFIG_KEY, serialized);
  // Write-through to legacy key for backwards compatibility across older builds.
  localStorage.setItem(LEGACY_API_CONFIG_KEYS[0], serialized);
}

export function getAPIConfig(): APIConfig | null {
  try {
    const candidates = [API_CONFIG_KEY, ...LEGACY_API_CONFIG_KEYS];
    for (const key of candidates) {
      const data = localStorage.getItem(key);
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
  localStorage.removeItem(API_CONFIG_KEY);
  for (const key of LEGACY_API_CONFIG_KEYS) {
    localStorage.removeItem(key);
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

export function getCustomers(): Customer[] {
  try {
    const data = localStorage.getItem(CUSTOMERS_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data) as Customer[];
    return parsed.map((customer) => ({
      ...customer,
      createdAt: parseDate(customer.createdAt),
    }));
  } catch {
    return [];
  }
}

export function saveCustomer(customer: Customer): void {
  const customers = getCustomers();
  const index = customers.findIndex((entry) => entry.id === customer.id);
  if (index >= 0) {
    customers[index] = customer;
  } else {
    customers.push(customer);
  }
  localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(customers));
}

export function createCustomer(name: string, initialsOverride?: string): Customer {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Customer name is required.');
  }

  const existing = getCustomers();
  const duplicate = existing.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  if (duplicate) {
    return duplicate;
  }

  const color = CUSTOMER_COLORS[existing.length % CUSTOMER_COLORS.length];
  const initials = (initialsOverride?.trim() || deriveInitials(trimmed)).slice(0, 2).toUpperCase();
  const customer: Customer = {
    id: generateId(),
    name: trimmed,
    color,
    initials,
    createdAt: new Date(),
  };
  saveCustomer(customer);
  return customer;
}

export function updateCustomer(
  id: string,
  update: Partial<Pick<Customer, 'name' | 'color' | 'initials'>>
): Customer | null {
  const customers = getCustomers();
  const index = customers.findIndex((entry) => entry.id === id);
  if (index < 0) return null;

  const current = customers[index];
  const next: Customer = {
    ...current,
    ...update,
    initials: (update.initials || current.initials).slice(0, 2).toUpperCase(),
  };
  customers[index] = next;
  localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(customers));
  return next;
}

function getAllChangeResponses(): Record<string, ChangeResponse[]> {
  try {
    const data = localStorage.getItem(CHANGE_RESPONSES_KEY);
    if (!data) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveAllChangeResponses(payload: Record<string, ChangeResponse[]>): void {
  localStorage.setItem(CHANGE_RESPONSES_KEY, JSON.stringify(payload));
}

export function getChangeResponsesForComparison(comparisonId: string): ChangeResponse[] {
  const all = getAllChangeResponses();
  const responses = all[comparisonId] || [];
  return responses.map((entry) => ({
    ...entry,
    createdAt: parseDate(entry.createdAt),
    updatedAt: parseDate(entry.updatedAt),
  }));
}

export function saveChangeResponse(
  comparisonId: string,
  changeId: string,
  status: ChangeResponseStatus,
  comment: string | null
): ChangeResponse {
  const all = getAllChangeResponses();
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
      updatedAt: now,
    };
  } else {
    responses.push({
      id: generateId(),
      comparisonId,
      changeId,
      status,
      comment,
      createdAt: now,
      updatedAt: now,
    });
  }

  all[comparisonId] = responses;
  saveAllChangeResponses(all);
  return responses.find((entry) => entry.changeId === changeId)!;
}

export function clearChangeResponse(comparisonId: string, changeId: string): void {
  const all = getAllChangeResponses();
  const responses = all[comparisonId] || [];
  all[comparisonId] = responses.filter((entry) => entry.changeId !== changeId);
  saveAllChangeResponses(all);
}

export function saveDefaultOriginalAgreement(document: DefaultOriginalAgreement): void {
  localStorage.setItem(DEFAULT_ORIGINAL_KEY, JSON.stringify(document));
}

export function getDefaultOriginalAgreement(): DefaultOriginalAgreement | null {
  try {
    const data = localStorage.getItem(DEFAULT_ORIGINAL_KEY);
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
  localStorage.removeItem(DEFAULT_ORIGINAL_KEY);
}

// Generate unique IDs
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
