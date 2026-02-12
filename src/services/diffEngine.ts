import DiffMatchPatch from 'diff-match-patch';
import type { Difference } from '../types';

const dmp = new DiffMatchPatch();
const CLAUSE_START_REGEX = /^\s*\d+(?:\.\d+)*\.?(?:\s|$)/;

export type DiffMode = 'character' | 'word' | 'sentence' | 'paragraph';

interface DiffResult {
  differences: Difference[];
  summary: {
    additions: number;
    deletions: number;
    modifications: number;
    total: number;
  };
}

interface DiffUnitEqual {
  kind: 'equal';
  text: string;
}

interface DiffUnitChange {
  kind: 'change';
  id: string;
  type: 'addition' | 'deletion' | 'modification';
  originalText: string | null;
  proposedText: string | null;
  originalStart: number;
  originalEnd: number;
  proposedStart: number;
  proposedEnd: number;
}

type DiffUnit = DiffUnitEqual | DiffUnitChange;

interface ChangePart {
  type: 'addition' | 'deletion' | 'modification';
  originalText: string | null;
  proposedText: string | null;
}

/**
 * Computes differences between two texts using diff-match-patch
 * This is a deterministic algorithm - no AI/LLM involved
 * Guarantees finding ALL differences without hallucination
 */
export function computeDiff(
  originalText: string,
  proposedText: string,
  mode: DiffMode = 'word'
): DiffResult {
  const diffs = getDiffs(originalText, proposedText, mode);
  const units = buildDiffUnits(diffs);
  const differences = convertUnitsToDifferences(units);

  // Calculate summary
  const summary = {
    additions: differences.filter((d) => d.type === 'addition').length,
    deletions: differences.filter((d) => d.type === 'deletion').length,
    modifications: differences.filter((d) => d.type === 'modification').length,
    total: differences.length,
  };

  return { differences, summary };
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function adjustDiffGranularity(
  diffs: [number, string][],
  mode: DiffMode
): [number, string][] {
  // For word-level, we use diff_linesToWords approach
  if (mode === 'word') {
    return adjustToWordLevel(diffs);
  }

  // For sentence/paragraph, we split by the appropriate delimiter
  if (mode === 'sentence') {
    return adjustToSentenceLevel(diffs);
  }

  if (mode === 'paragraph') {
    return adjustToParagraphLevel(diffs);
  }

  return diffs;
}

function adjustToWordLevel(diffs: [number, string][]): [number, string][] {
  // Group changes by word boundaries
  const result: [number, string][] = [];

  for (const [op, text] of diffs) {
    // Split into words while preserving whitespace
    const words = text.match(/\S+|\s+/g) || [];

    for (const word of words) {
      if (word.trim()) {
        // Only add non-whitespace
        if (result.length > 0 && result[result.length - 1][0] === op) {
          result[result.length - 1][1] += word;
        } else {
          result.push([op, word]);
        }
      } else if (result.length > 0) {
        // Append whitespace to previous
        result[result.length - 1][1] += word;
      }
    }
  }

  return result;
}

function adjustToSentenceLevel(diffs: [number, string][]): [number, string][] {
  // Combine diffs into full text with markers, then re-split by sentences
  // This is a simplified approach
  return diffs;
}

function adjustToParagraphLevel(diffs: [number, string][]): [number, string][] {
  // Similar approach for paragraphs
  return diffs;
}

function convertUnitsToDifferences(units: DiffUnit[]): Difference[] {
  const differences: Difference[] = [];

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.kind !== 'change') {
      continue;
    }

    const difference: Difference = {
      id: unit.id,
      type: unit.type,
      originalText: unit.originalText,
      proposedText: unit.proposedText,
      context: getContextFromUnits(units, i),
    };

    if (unit.originalText !== null) {
      difference.originalPosition = {
        start: unit.originalStart,
        end: unit.originalEnd,
      };
    }

    if (unit.proposedText !== null) {
      difference.proposedPosition = {
        start: unit.proposedStart,
        end: unit.proposedEnd,
      };
    }

    differences.push(difference);
  }

  return differences;
}

/**
 * Generate HTML representation of the diff for display
 */
export function generateDiffHTML(
  originalText: string,
  proposedText: string,
  mode: DiffMode = 'word'
): { originalHTML: string; proposedHTML: string } {
  const diffs = getDiffs(originalText, proposedText, mode);
  const units = buildDiffUnits(diffs);
  let originalHTML = '';
  let proposedHTML = '';

  for (const unit of units) {
    if (unit.kind === 'equal') {
      const escaped = escapeHTML(unit.text);
      originalHTML += escaped;
      proposedHTML += escaped;
      continue;
    }

    if (unit.type === 'modification') {
      originalHTML += wrapDiffSpan(
        escapeHTML(unit.originalText || ''),
        'diff-removed',
        unit.id
      );
      proposedHTML += wrapDiffSpan(
        escapeHTML(unit.proposedText || ''),
        'diff-added',
        unit.id
      );
      continue;
    }

    if (unit.type === 'deletion') {
      originalHTML += wrapDiffSpan(
        escapeHTML(unit.originalText || ''),
        'diff-removed',
        unit.id
      );
      continue;
    }

    if (unit.type === 'addition') {
      proposedHTML += wrapDiffSpan(
        escapeHTML(unit.proposedText || ''),
        'diff-added',
        unit.id
      );
    }
  }

  return { originalHTML, proposedHTML };
}

function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

/**
 * Generate inline diff view (single document with all changes shown)
 */
export function generateInlineDiffHTML(
  originalText: string,
  proposedText: string,
  mode: DiffMode = 'word'
): string {
  const diffs = getDiffs(originalText, proposedText, mode);
  const units = buildDiffUnits(diffs);

  let html = '';

  for (const unit of units) {
    if (unit.kind === 'equal') {
      html += escapeHTML(unit.text);
      continue;
    }

    if (unit.type === 'modification') {
      html += wrapDiffSpan(
        escapeHTML(unit.originalText || ''),
        'diff-removed',
        unit.id
      );
      html += wrapDiffSpan(
        escapeHTML(unit.proposedText || ''),
        'diff-added',
        unit.id
      );
      continue;
    }

    if (unit.type === 'deletion') {
      html += wrapDiffSpan(
        escapeHTML(unit.originalText || ''),
        'diff-removed',
        unit.id
      );
      continue;
    }

    if (unit.type === 'addition') {
      html += wrapDiffSpan(
        escapeHTML(unit.proposedText || ''),
        'diff-added',
        unit.id
      );
    }
  }

  return html;
}

function getDiffs(
  originalText: string,
  proposedText: string,
  mode: DiffMode
): [number, string][] {
  const original = normalizeText(originalText);
  const proposed = normalizeText(proposedText);

  let diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);

  if (mode !== 'character') {
    diffs = adjustDiffGranularity(diffs, mode);
  }

  return diffs;
}

function buildDiffUnits(diffs: [number, string][]): DiffUnit[] {
  const units: DiffUnit[] = [];
  let originalPosition = 0;
  let proposedPosition = 0;
  let diffIndex = 0;
  let diffCounter = 0;

  while (diffIndex < diffs.length) {
    const [op, text] = diffs[diffIndex];

    if (op === 0) {
      units.push({ kind: 'equal', text });
      originalPosition += text.length;
      proposedPosition += text.length;
      diffIndex++;
      continue;
    }

    if (op === -1) {
      const deletionRun = collectRun(diffs, diffIndex, -1);
      diffIndex = deletionRun.nextIndex;

      if (diffIndex < diffs.length && diffs[diffIndex][0] === 1) {
        const additionRun = collectRun(diffs, diffIndex, 1);
        diffIndex = additionRun.nextIndex;

        const parts = splitChangeRun(deletionRun.text, additionRun.text);
        for (const part of parts) {
          const originalStart = originalPosition;
          const proposedStart = proposedPosition;

          if (part.originalText !== null) {
            originalPosition += part.originalText.length;
          }
          if (part.proposedText !== null) {
            proposedPosition += part.proposedText.length;
          }

          units.push({
            kind: 'change',
            id: `diff-${diffCounter++}`,
            type: part.type,
            originalText: part.originalText,
            proposedText: part.proposedText,
            originalStart,
            originalEnd: originalPosition,
            proposedStart,
            proposedEnd: proposedPosition,
          });
        }
      } else {
        const parts = splitChangeRun(deletionRun.text, '');
        for (const part of parts) {
          const originalStart = originalPosition;
          const proposedStart = proposedPosition;

          if (part.originalText !== null) {
            originalPosition += part.originalText.length;
          }
          if (part.proposedText !== null) {
            proposedPosition += part.proposedText.length;
          }

          units.push({
            kind: 'change',
            id: `diff-${diffCounter++}`,
            type: part.type,
            originalText: part.originalText,
            proposedText: part.proposedText,
            originalStart,
            originalEnd: originalPosition,
            proposedStart,
            proposedEnd: proposedPosition,
          });
        }
      }
      continue;
    }

    if (op === 1) {
      const additionRun = collectRun(diffs, diffIndex, 1);
      diffIndex = additionRun.nextIndex;
      const parts = splitChangeRun('', additionRun.text);

      for (const part of parts) {
        const originalStart = originalPosition;
        const proposedStart = proposedPosition;

        if (part.originalText !== null) {
          originalPosition += part.originalText.length;
        }
        if (part.proposedText !== null) {
          proposedPosition += part.proposedText.length;
        }

        units.push({
          kind: 'change',
          id: `diff-${diffCounter++}`,
          type: part.type,
          originalText: part.originalText,
          proposedText: part.proposedText,
          originalStart,
          originalEnd: originalPosition,
          proposedStart,
          proposedEnd: proposedPosition,
        });
      }
      continue;
    }

    diffIndex++;
  }

  return units;
}

function collectRun(
  diffs: [number, string][],
  startIndex: number,
  operation: number
): { text: string; nextIndex: number } {
  let index = startIndex;
  let text = '';

  while (index < diffs.length && diffs[index][0] === operation) {
    text += diffs[index][1];
    index++;
  }

  return { text, nextIndex: index };
}

function splitChangeRun(deletedText: string, addedText: string): ChangePart[] {
  if (deletedText && addedText) {
    return splitModificationRun(deletedText, addedText);
  }

  if (deletedText) {
    return splitStructuredText(deletedText).map((part) => ({
      type: 'deletion',
      originalText: part,
      proposedText: null,
    }));
  }

  return splitStructuredText(addedText).map((part) => ({
    type: 'addition',
    originalText: null,
    proposedText: part,
  }));
}

function splitModificationRun(deletedText: string, addedText: string): ChangePart[] {
  const deletedParts = splitStructuredText(deletedText);
  const addedParts = splitStructuredText(addedText);

  if (deletedParts.length === 1 && addedParts.length === 1) {
    return [
      {
        type: 'modification',
        originalText: deletedText,
        proposedText: addedText,
      },
    ];
  }

  const parts: ChangePart[] = [];
  let deletedIndex = 0;
  let addedIndex = 0;

  while (deletedIndex < deletedParts.length || addedIndex < addedParts.length) {
    const deletedPart = deletedParts[deletedIndex] || null;
    const addedPart = addedParts[addedIndex] || null;

    if (deletedPart && addedPart) {
      if (shouldPairAsModification(deletedPart, addedPart)) {
        parts.push({
          type: 'modification',
          originalText: deletedPart,
          proposedText: addedPart,
        });
        deletedIndex++;
        addedIndex++;
        continue;
      }

      const nextDeletedPart = deletedParts[deletedIndex + 1] || null;
      const nextAddedPart = addedParts[addedIndex + 1] || null;

      if (nextDeletedPart && shouldPairAsModification(nextDeletedPart, addedPart)) {
        parts.push({
          type: 'deletion',
          originalText: deletedPart,
          proposedText: null,
        });
        deletedIndex++;
        continue;
      }

      if (nextAddedPart && shouldPairAsModification(deletedPart, nextAddedPart)) {
        parts.push({
          type: 'addition',
          originalText: null,
          proposedText: addedPart,
        });
        addedIndex++;
        continue;
      }

      parts.push({
        type: 'deletion',
        originalText: deletedPart,
        proposedText: null,
      });
      parts.push({
        type: 'addition',
        originalText: null,
        proposedText: addedPart,
      });
      deletedIndex++;
      addedIndex++;
      continue;
    }

    if (deletedPart) {
      parts.push({
        type: 'deletion',
        originalText: deletedPart,
        proposedText: null,
      });
      deletedIndex++;
      continue;
    }

    if (addedPart) {
      parts.push({
        type: 'addition',
        originalText: null,
        proposedText: addedPart,
      });
      addedIndex++;
    }
  }

  const compactedParts = coalesceAdjacentParts(parts);

  return compactedParts.length > 0
    ? compactedParts
    : [
        {
          type: 'modification',
          originalText: deletedText,
          proposedText: addedText,
        },
      ];
}

function splitStructuredText(text: string): string[] {
  if (!text) {
    return [];
  }

  const lines = text.match(/[^\n]*\n|[^\n]+$/g);
  if (!lines || lines.length <= 1) {
    return [text];
  }

  const segments: string[] = [];
  let current = '';
  let foundBoundary = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const startsNewClause = CLAUSE_START_REGEX.test(trimmedLine);
    const isBlankLine = trimmedLine.length === 0;

    if (startsNewClause && current.length > 0) {
      segments.push(current);
      current = line;
      foundBoundary = true;
      continue;
    }

    current += line;

    if (isBlankLine && current.length > 0) {
      segments.push(current);
      current = '';
      foundBoundary = true;
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  if (!foundBoundary || segments.length <= 1) {
    return [text];
  }

  return segments.filter((segment) => segment.length > 0);
}

function getContextFromUnits(units: DiffUnit[], currentIndex: number): string {
  let before = '';
  let after = '';

  for (let i = currentIndex - 1; i >= 0; i--) {
    const unit = units[i];
    if (unit.kind === 'equal' && unit.text.trim().length > 0) {
      before = unit.text.slice(-50);
      break;
    }
  }

  for (let i = currentIndex + 1; i < units.length; i++) {
    const unit = units[i];
    if (unit.kind === 'equal' && unit.text.trim().length > 0) {
      after = unit.text.slice(0, 50);
      break;
    }
  }

  return [before, after].filter((part) => part.length > 0).join('...').trim();
}

function shouldPairAsModification(deletedPart: string, addedPart: string): boolean {
  const deletedClause = extractLeadingClauseId(deletedPart);
  const addedClause = extractLeadingClauseId(addedPart);

  if (deletedClause && addedClause && deletedClause === addedClause) {
    return true;
  }

  return textSimilarity(deletedPart, addedPart) >= 0.34;
}

function coalesceAdjacentParts(parts: ChangePart[]): ChangePart[] {
  if (parts.length <= 1) {
    return parts;
  }

  const merged: ChangePart[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];

    if (previous && canMergeParts(previous, part)) {
      merged[merged.length - 1] = {
        type: previous.type,
        originalText: concatNullable(previous.originalText, part.originalText),
        proposedText: concatNullable(previous.proposedText, part.proposedText),
      };
      continue;
    }

    merged.push(part);
  }

  return merged;
}

function canMergeParts(previous: ChangePart, current: ChangePart): boolean {
  if (previous.type !== current.type) {
    return false;
  }

  const previousText = previous.originalText ?? previous.proposedText ?? '';
  const currentText = current.originalText ?? current.proposedText ?? '';
  const previousClause = extractLeadingClauseId(previousText);
  const currentClause = extractLeadingClauseId(currentText);

  if (previousClause && currentClause) {
    return previousClause === currentClause;
  }

  if (previousClause && !currentClause) {
    return !startsWithMarker(currentText);
  }

  if (!previousClause && currentClause) {
    return !startsWithMarker(previousText);
  }

  return !startsWithMarker(previousText) && !startsWithMarker(currentText);
}

function startsWithMarker(value: string): boolean {
  return /^\s*\[(ADD|REP|DEL|REMOVE|INSERT|CHANGE)\b/i.test(value);
}

function concatNullable(left: string | null, right: string | null): string | null {
  if (left === null && right === null) {
    return null;
  }
  return `${left ?? ''}${right ?? ''}`;
}

function extractLeadingClauseId(value: string): string {
  const match = value.match(/^\s*(\d+(?:\.\d+)*\.?)(?:\s|$)/);
  if (!match) {
    return '';
  }
  return match[1].replace(/\.$/, '');
}

function textSimilarity(left: string, right: string): number {
  const leftWords = toWordSet(left);
  const rightWords = toWordSet(right);

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  let intersectionCount = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      intersectionCount++;
    }
  }

  const unionCount = new Set([...leftWords, ...rightWords]).size;
  return unionCount > 0 ? intersectionCount / unionCount : 0;
}

function toWordSet(value: string): Set<string> {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3);
  return new Set(words);
}

function wrapDiffSpan(text: string, className: string, diffId: string): string {
  return `<span class="diff-segment ${className}" data-diff-id="${diffId}">${text}</span>`;
}
