import DiffMatchPatch from 'diff-match-patch';
import type { Difference } from '../types';

const dmp = new DiffMatchPatch();
const CLAUSE_START_REGEX = /^\s*\d+(?:\.\d+)*\.?(?:\s|$)/;
const INLINE_CLAUSE_BOUNDARY_REGEX = /(?<=[\].;:!?])\s+(?=\d+(?:\.\d+)+\.?\s)/g;
const INLINE_NUMBERED_HEADING_BOUNDARY_REGEX = /\s+(?=\d+\.\s+[A-Z(“"])/g;
const INLINE_NUMBERED_SUBCLAUSE_BOUNDARY_REGEX = /\s+(?=\d+\.\d+(?:\.\d+)*\.?\s+[A-Z(“"])/g;
const INLINE_MARKER_BOUNDARY_REGEX = /\s+(?=\[[A-Za-z][A-Za-z0-9 _-]{0,24}\s*:)/g;
const INLINE_BULLET_BOUNDARY_REGEX = /(?<=[.;!?])\s+(?=-\s+[A-Za-z\[])/g;

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

interface TextLineIndex {
  starts: number[];
  ends: number[];
  lines: string[];
}

interface NumberedHeadingInfo {
  id: string;
  level: number;
}

const MAX_SECTION_CONTEXT_CHARS = 3200;
const MAX_PARAGRAPH_CONTEXT_CHARS = 1800;

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
  const normalizedOriginal = normalizeText(originalText);
  const normalizedProposed = normalizeText(proposedText);
  const diffs = getDiffs(originalText, proposedText, mode);
  const units = buildDiffUnits(diffs);
  const differences = convertUnitsToDifferences(units, normalizedOriginal, normalizedProposed);

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
    .replace(INLINE_CLAUSE_BOUNDARY_REGEX, '\n')
    .replace(INLINE_NUMBERED_HEADING_BOUNDARY_REGEX, '\n')
    .replace(INLINE_NUMBERED_SUBCLAUSE_BOUNDARY_REGEX, '\n')
    .replace(INLINE_MARKER_BOUNDARY_REGEX, '\n')
    .replace(INLINE_BULLET_BOUNDARY_REGEX, '\n')
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

function convertUnitsToDifferences(
  units: DiffUnit[],
  originalText: string,
  proposedText: string
): Difference[] {
  const differences: Difference[] = [];
  const originalIndex = buildLineIndex(originalText);
  const proposedIndex = buildLineIndex(proposedText);

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.kind !== 'change') {
      continue;
    }

    if (isSuppressedNonMeaningfulChange(unit)) {
      continue;
    }

    const difference: Difference = {
      id: unit.id,
      type: unit.type,
      originalText: unit.originalText,
      proposedText: unit.proposedText,
      context: buildDifferenceContext(
        units,
        i,
        unit,
        originalText,
        proposedText,
        originalIndex,
        proposedIndex
      ),
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

    if (isSuppressedNonMeaningfulChange(unit)) {
      originalHTML += escapeHTML(unit.originalText || '');
      proposedHTML += escapeHTML(unit.proposedText || '');
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

    if (isSuppressedNonMeaningfulChange(unit)) {
      html += escapeHTML(unit.proposedText || unit.originalText || '');
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

  if (mode === 'word') {
    return getWordLevelDiffs(original, proposed);
  }

  let diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);

  if (mode !== 'character') {
    diffs = adjustDiffGranularity(diffs, mode);
  }

  return diffs;
}

function getWordLevelDiffs(original: string, proposed: string): [number, string][] {
  const lineAnchoredDiffs = getLineAnchoredDiffs(original, proposed);
  const refined: [number, string][] = [];

  for (let index = 0; index < lineAnchoredDiffs.length; index++) {
    const [op, text] = lineAnchoredDiffs[index];
    if (op === 0) {
      refined.push([0, text]);
      continue;
    }

    let deletedText = '';
    let addedText = '';
    let cursor = index;

    while (cursor < lineAnchoredDiffs.length && lineAnchoredDiffs[cursor][0] !== 0) {
      const [chunkOp, chunkText] = lineAnchoredDiffs[cursor];
      if (chunkOp === -1) {
        deletedText += chunkText;
      } else if (chunkOp === 1) {
        addedText += chunkText;
      }
      cursor++;
    }

    if (deletedText && addedText) {
      const deletedLines = splitLines(deletedText);
      const addedLines = splitLines(addedText);

      // For larger multi-line change blocks, keep line anchoring intact to avoid
      // long-distance token matches across sections/clauses.
      if (deletedLines.length === 1 && addedLines.length === 1) {
        refined.push(...getTokenWordDiffs(deletedText, addedText));
      } else {
        refined.push(...reanchorEquivalentLinesInBlock(deletedText, addedText));
      }
    } else if (deletedText) {
      refined.push([-1, deletedText]);
    } else if (addedText) {
      refined.push([1, addedText]);
    }

    index = cursor - 1;
  }

  return coalesceDiffs(refined);
}

function getLineAnchoredDiffs(original: string, proposed: string): [number, string][] {
  const internals = dmp as unknown as {
    diff_linesToChars_: (text1: string, text2: string) => {
      chars1: string;
      chars2: string;
      lineArray: string[];
    };
    diff_charsToLines_: (value: [number, string][], lines: string[]) => void;
  };

  const encoded = internals.diff_linesToChars_(original, proposed);
  let diffs = dmp.diff_main(encoded.chars1, encoded.chars2, false);
  dmp.diff_cleanupSemantic(diffs);
  internals.diff_charsToLines_(diffs, encoded.lineArray);
  return diffs;
}

function getTokenWordDiffs(original: string, proposed: string): [number, string][] {
  const tokenized = wordsToChars(original, proposed);
  if (!tokenized) {
    // Fallback for unusually large token maps.
    let fallback = dmp.diff_main(original, proposed);
    dmp.diff_cleanupSemantic(fallback);
    return fallback;
  }

  let diffs = dmp.diff_main(tokenized.chars1, tokenized.chars2, false);
  dmp.diff_cleanupSemantic(diffs);

  // diff-match-patch exposes this helper for line-mode internals.
  const internals = dmp as unknown as {
    diff_charsToLines_: (value: [number, string][], lines: string[]) => void;
  };
  internals.diff_charsToLines_(diffs, tokenized.tokenArray);
  return coalesceDiffs(diffs);
}

function wordsToChars(
  original: string,
  proposed: string
): { chars1: string; chars2: string; tokenArray: string[] } | null {
  const tokenArray: string[] = [''];
  const tokenLookup = new Map<string, number>();
  const MAX_TOKEN_CODEPOINT = 65535;

  const encode = (input: string): string | null => {
    const tokens = input.match(/\S+|\s+/g) || [];
    let encoded = '';

    for (const token of tokens) {
      const existing = tokenLookup.get(token);
      if (existing !== undefined) {
        encoded += String.fromCharCode(existing);
        continue;
      }

      if (tokenArray.length > MAX_TOKEN_CODEPOINT) {
        return null;
      }

      tokenArray.push(token);
      const tokenId = tokenArray.length - 1;
      tokenLookup.set(token, tokenId);
      encoded += String.fromCharCode(tokenId);
    }

    return encoded;
  };

  const chars1 = encode(original);
  if (chars1 === null) {
    return null;
  }

  const chars2 = encode(proposed);
  if (chars2 === null) {
    return null;
  }

  return { chars1, chars2, tokenArray };
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.match(/[^\n]*\n|[^\n]+$/g) || [text];
}

function reanchorEquivalentLinesInBlock(
  deletedText: string,
  addedText: string
): [number, string][] {
  const deletedLines = splitLines(deletedText);
  const addedLines = splitLines(addedText);
  const matches = buildNormalizedLineMatches(deletedLines, addedLines);

  if (matches.length === 0) {
    return coalesceDiffs([
      [-1, deletedText],
      [1, addedText],
    ]);
  }

  const output: [number, string][] = [];
  let deletedIndex = 0;
  let addedIndex = 0;

  for (const [matchedDeletedIndex, matchedAddedIndex] of matches) {
    if (deletedIndex < matchedDeletedIndex) {
      output.push([-1, deletedLines.slice(deletedIndex, matchedDeletedIndex).join('')]);
    }
    if (addedIndex < matchedAddedIndex) {
      output.push([1, addedLines.slice(addedIndex, matchedAddedIndex).join('')]);
    }

    const deletedLine = deletedLines[matchedDeletedIndex];
    const addedLine = addedLines[matchedAddedIndex];

    if (deletedLine === addedLine) {
      output.push([0, deletedLine]);
    } else {
      // Keep as change pair so position accounting stays accurate, then suppression
      // can remove non-meaningful variants.
      output.push([-1, deletedLine], [1, addedLine]);
    }

    deletedIndex = matchedDeletedIndex + 1;
    addedIndex = matchedAddedIndex + 1;
  }

  if (deletedIndex < deletedLines.length) {
    output.push([-1, deletedLines.slice(deletedIndex).join('')]);
  }
  if (addedIndex < addedLines.length) {
    output.push([1, addedLines.slice(addedIndex).join('')]);
  }

  return coalesceDiffs(output);
}

function buildNormalizedLineMatches(
  deletedLines: string[],
  addedLines: string[]
): Array<[number, number]> {
  const deletedNormalized = deletedLines.map((line) => normalizeForMeaningfulComparison(line));
  const addedNormalized = addedLines.map((line) => normalizeForMeaningfulComparison(line));
  const rows = deletedLines.length;
  const cols = addedLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols + 1 }, () => 0)
  );

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      if (
        areEquivalentLinesForAnchoring(
          deletedLines[i],
          addedLines[j],
          deletedNormalized[i],
          addedNormalized[j]
        )
      ) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (
      areEquivalentLinesForAnchoring(
        deletedLines[i],
        addedLines[j],
        deletedNormalized[i],
        addedNormalized[j]
      )
    ) {
      matches.push([i, j]);
      i++;
      j++;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return matches;
}

function areEquivalentLinesForAnchoring(
  deletedLine: string,
  addedLine: string,
  deletedNormalized: string,
  addedNormalized: string
): boolean {
  if (deletedLine === addedLine) {
    return true;
  }

  if (deletedNormalized !== addedNormalized) {
    return false;
  }

  // Avoid anchoring on very short normalized tokens, which can cause accidental
  // long-distance matches on punctuation-only lines.
  if (deletedNormalized.length < 6) {
    return false;
  }

  return true;
}

function coalesceDiffs(diffs: [number, string][]): [number, string][] {
  const result: [number, string][] = [];
  for (const [op, text] of diffs) {
    if (!text) {
      continue;
    }
    const previous = result[result.length - 1];
    if (previous && previous[0] === op) {
      previous[1] += text;
      continue;
    }
    result.push([op, text]);
  }
  return result;
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

  // If there is no plausible modification pairing between any deleted/added
  // segment, keep both sides separate to avoid interleaving unrelated clauses.
  if (!hasAnyModificationPairCandidate(deletedParts, addedParts)) {
    return [
      ...deletedParts.map((part) => ({
        type: 'deletion' as const,
        originalText: part,
        proposedText: null,
      })),
      ...addedParts.map((part) => ({
        type: 'addition' as const,
        originalText: null,
        proposedText: part,
      })),
    ];
  }

  if (deletedParts.length === 1 && addedParts.length === 1) {
    if (!shouldPairAsModification(deletedText, addedText)) {
      return [
        {
          type: 'deletion',
          originalText: deletedText,
          proposedText: null,
        },
        {
          type: 'addition',
          originalText: null,
          proposedText: addedText,
        },
      ];
    }

    return [
      {
        type: 'modification',
        originalText: deletedText,
        proposedText: addedText,
      },
    ];
  }

  const matches = buildPartPairMatches(deletedParts, addedParts);
  const parts: ChangePart[] = [];
  let deletedCursor = 0;
  let addedCursor = 0;

  for (const [matchedDeletedIndex, matchedAddedIndex] of matches) {
    appendOrderedGapParts(
      parts,
      deletedParts,
      addedParts,
      deletedCursor,
      matchedDeletedIndex,
      addedCursor,
      matchedAddedIndex
    );
    deletedCursor = matchedDeletedIndex;
    addedCursor = matchedAddedIndex;

    parts.push({
      type: 'modification',
      originalText: deletedParts[matchedDeletedIndex],
      proposedText: addedParts[matchedAddedIndex],
    });
    deletedCursor = matchedDeletedIndex + 1;
    addedCursor = matchedAddedIndex + 1;
  }

  while (deletedCursor < deletedParts.length) {
    parts.push({
      type: 'deletion',
      originalText: deletedParts[deletedCursor],
      proposedText: null,
    });
    deletedCursor++;
  }

  while (addedCursor < addedParts.length) {
    parts.push({
      type: 'addition',
      originalText: null,
      proposedText: addedParts[addedCursor],
    });
    addedCursor++;
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

function appendOrderedGapParts(
  parts: ChangePart[],
  deletedParts: string[],
  addedParts: string[],
  deletedStart: number,
  deletedEnd: number,
  addedStart: number,
  addedEnd: number
): void {
  let deletedIndex = deletedStart;
  let addedIndex = addedStart;

  while (deletedIndex < deletedEnd && addedIndex < addedEnd) {
    const deletedPart = deletedParts[deletedIndex];
    const addedPart = addedParts[addedIndex];

    if (shouldEmitAdditionBeforeDeletion(addedPart, deletedPart)) {
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
    deletedIndex++;
  }

  while (deletedIndex < deletedEnd) {
    parts.push({
      type: 'deletion',
      originalText: deletedParts[deletedIndex],
      proposedText: null,
    });
    deletedIndex++;
  }

  while (addedIndex < addedEnd) {
    parts.push({
      type: 'addition',
      originalText: null,
      proposedText: addedParts[addedIndex],
    });
    addedIndex++;
  }
}

function buildPartPairMatches(
  deletedParts: string[],
  addedParts: string[]
): Array<[number, number]> {
  const rows = deletedParts.length;
  const cols = addedParts.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols + 1 }, () => 0)
  );

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const skipDeletedScore = dp[i + 1][j];
      const skipAddedScore = dp[i][j + 1];
      let bestScore = Math.max(skipDeletedScore, skipAddedScore);

      if (shouldPairAsModification(deletedParts[i], addedParts[j])) {
        const pairScore =
          getModificationPairScore(deletedParts[i], addedParts[j]) + dp[i + 1][j + 1];
        if (pairScore > bestScore) {
          bestScore = pairScore;
        }
      }

      dp[i][j] = bestScore;
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (shouldPairAsModification(deletedParts[i], addedParts[j])) {
      const pairScore =
        getModificationPairScore(deletedParts[i], addedParts[j]) + dp[i + 1][j + 1];
      const skipDeletedScore = dp[i + 1][j];
      const skipAddedScore = dp[i][j + 1];

      if (pairScore >= skipDeletedScore && pairScore >= skipAddedScore) {
        matches.push([i, j]);
        i++;
        j++;
        continue;
      }
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return matches;
}

function shouldEmitAdditionBeforeDeletion(addedPart: string, deletedPart: string): boolean {
  const addedClause = extractLeadingClauseId(addedPart);
  const deletedClause = extractLeadingClauseId(deletedPart);

  if (!addedClause || !deletedClause) {
    return false;
  }

  return compareClauseIds(addedClause, deletedClause) < 0;
}

function compareClauseIds(left: string, right: string): number {
  const leftParts = left.split('.').filter(Boolean).map((part) => Number(part));
  const rightParts = right.split('.').filter(Boolean).map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const leftValue = leftParts[index] ?? -1;
    const rightValue = rightParts[index] ?? -1;
    if (leftValue < rightValue) {
      return -1;
    }
    if (leftValue > rightValue) {
      return 1;
    }
  }

  return 0;
}

function getModificationPairScore(deletedPart: string, addedPart: string): number {
  const deletedNormalized = normalizeForMeaningfulComparison(deletedPart);
  const addedNormalized = normalizeForMeaningfulComparison(addedPart);

  if (deletedNormalized.length > 0 && deletedNormalized === addedNormalized) {
    return 1000;
  }

  const deletedClause = extractLeadingClauseId(deletedPart);
  const addedClause = extractLeadingClauseId(addedPart);
  const similarityScore = Math.round(textSimilarity(deletedPart, addedPart) * 100);

  if (deletedClause && addedClause && deletedClause === addedClause) {
    return 700 + similarityScore;
  }

  return similarityScore;
}

function splitStructuredText(text: string): string[] {
  if (!text) {
    return [];
  }

  const lines = text
    .replace(INLINE_CLAUSE_BOUNDARY_REGEX, '\n')
    .replace(INLINE_NUMBERED_HEADING_BOUNDARY_REGEX, '\n')
    .replace(INLINE_NUMBERED_SUBCLAUSE_BOUNDARY_REGEX, '\n')
    .replace(INLINE_MARKER_BOUNDARY_REGEX, '\n')
    .replace(INLINE_BULLET_BOUNDARY_REGEX, '\n')
    .match(/[^\n]*\n|[^\n]+$/g);
  if (!lines || lines.length <= 1) {
    return [text];
  }

  const segments: string[] = [];
  let current = '';
  let foundBoundary = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const startsNewClause = CLAUSE_START_REGEX.test(trimmedLine);
    const startsMarkerDirective = startsWithMarker(trimmedLine);
    const isBlankLine = trimmedLine.length === 0;

    if ((startsNewClause || startsMarkerDirective) && current.length > 0) {
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

  const normalizedSegments = mergeWhitespaceOnlySegments(segments);
  const markerMergedSegments = mergeMarkerFragmentsWithFollowingContent(normalizedSegments);
  const clauseMergedSegments = mergeHeadingOnlySegmentsWithFollowingBody(markerMergedSegments);
  const labelValueMergedSegments = mergeLabelValueSegments(clauseMergedSegments);

  if (!foundBoundary || labelValueMergedSegments.length <= 1) {
    return [text];
  }

  return labelValueMergedSegments.filter((segment) => segment.length > 0);
}

function mergeWhitespaceOnlySegments(segments: string[]): string[] {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: string[] = [];
  let pendingWhitespace = '';

  for (const segment of segments) {
    if (segment.trim().length === 0) {
      pendingWhitespace += segment;
      continue;
    }

    merged.push(`${pendingWhitespace}${segment}`);
    pendingWhitespace = '';
  }

  if (pendingWhitespace.length > 0) {
    if (merged.length > 0) {
      merged[merged.length - 1] += pendingWhitespace;
    } else {
      merged.push(pendingWhitespace);
    }
  }

  return merged;
}

function mergeMarkerFragmentsWithFollowingContent(segments: string[]): string[] {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: string[] = [];

  for (let index = 0; index < segments.length; index++) {
    const current = segments[index];
    const next = segments[index + 1];

    if (next && isMarkerFragmentSegment(current)) {
      merged.push(`${current}${next}`);
      index++;
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function isMarkerFragmentSegment(value: string): boolean {
  const firstNonEmptyLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine || !startsWithMarker(firstNonEmptyLine)) {
    return false;
  }

  // Marker fragments like "[ADD:" should stay attached to their payload.
  return !/\]/.test(value);
}

function mergeHeadingOnlySegmentsWithFollowingBody(segments: string[]): string[] {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: string[] = [];

  for (let index = 0; index < segments.length; index++) {
    const current = segments[index];
    const next = segments[index + 1];

    if (
      next &&
      isHeadingOnlySegment(current) &&
      startsWithContinuationLine(next)
    ) {
      merged.push(`${current}${next}`);
      index++;
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function mergeLabelValueSegments(segments: string[]): string[] {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: string[] = [];

  for (let index = 0; index < segments.length; index++) {
    const current = segments[index];
    const next = segments[index + 1];

    if (next && isLabelOnlySegment(current) && startsWithValueLine(next)) {
      merged.push(`${current}${next}`);
      index++;
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function isHeadingOnlySegment(value: string): boolean {
  const nonEmptyLines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length !== 1) {
    return false;
  }

  const heading = nonEmptyLines[0];
  return CLAUSE_START_REGEX.test(heading) && !startsWithMarker(heading);
}

function isLabelOnlySegment(value: string): boolean {
  const nonEmptyLines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length !== 1) {
    return false;
  }

  const label = nonEmptyLines[0];
  if (startsWithMarker(label) || CLAUSE_START_REGEX.test(label)) {
    return false;
  }

  return /^[A-Za-z][^:\n]{0,80}:$/.test(label);
}

function startsWithValueLine(value: string): boolean {
  const firstNonEmptyLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) {
    return false;
  }

  // Values commonly found after labels (e.g., "Version:" + "1.0").
  return /^[\[\(]?[A-Za-z0-9]+(?:[.\- ][A-Za-z0-9]+){0,6}[\]\)]?$/.test(firstNonEmptyLine);
}

function startsWithContinuationLine(value: string): boolean {
  const firstNonEmptyLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) {
    return false;
  }

  if (startsWithMarker(firstNonEmptyLine)) {
    return false;
  }

  return !CLAUSE_START_REGEX.test(firstNonEmptyLine);
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

function buildDifferenceContext(
  units: DiffUnit[],
  currentIndex: number,
  unit: DiffUnitChange,
  originalText: string,
  proposedText: string,
  originalIndex: TextLineIndex,
  proposedIndex: TextLineIndex
): string {
  const originalSection =
    unit.originalText !== null
      ? extractSectionContext(originalText, originalIndex, unit.originalStart, unit.originalEnd)
      : '';
  const proposedSection =
    unit.proposedText !== null
      ? extractSectionContext(proposedText, proposedIndex, unit.proposedStart, unit.proposedEnd)
      : '';

  if (!originalSection && !proposedSection) {
    return getContextFromUnits(units, currentIndex);
  }

  return [
    originalSection ? `Original section context:\n${originalSection}` : 'Original section context:\n[Not available]',
    proposedSection ? `Proposed section context:\n${proposedSection}` : 'Proposed section context:\n[Not available]',
  ].join('\n\n');
}

function extractSectionContext(
  text: string,
  index: TextLineIndex,
  start: number,
  end: number
): string {
  if (!text || text.trim().length === 0) {
    return '';
  }

  const clampedStart = clampPosition(start, text.length);
  const clampedEnd = clampPosition(end, text.length);
  const anchorPosition = clampedStart <= clampedEnd ? clampedStart : clampedEnd;
  const anchorLine = findLineIndexForPosition(index, anchorPosition);

  const headingContext = extractByHeading(text, index, anchorLine, anchorPosition);
  if (headingContext) {
    return headingContext;
  }

  return extractByParagraphs(text, index, anchorLine, anchorPosition);
}

function extractByHeading(
  text: string,
  index: TextLineIndex,
  anchorLine: number,
  anchorPosition: number
): string {
  const headingLine = findNearestHeadingLine(index, anchorLine);
  if (headingLine < 0) {
    return '';
  }

  const headingInfo = getNumberedHeadingInfo(index.lines[headingLine]);
  let endLine = index.lines.length;

  for (let line = headingLine + 1; line < index.lines.length; line++) {
    if (!isHeadingLine(index.lines[line])) {
      continue;
    }

    if (!headingInfo) {
      endLine = line;
      break;
    }

    const candidateInfo = getNumberedHeadingInfo(index.lines[line]);
    if (!candidateInfo || candidateInfo.level <= headingInfo.level) {
      endLine = line;
      break;
    }
  }

  const sectionStart = index.starts[headingLine] ?? 0;
  const sectionEnd =
    endLine < index.lines.length
      ? index.starts[endLine]
      : index.ends[index.ends.length - 1] ?? text.length;

  const section = extractBoundedSlice(
    text,
    sectionStart,
    sectionEnd,
    anchorPosition,
    MAX_SECTION_CONTEXT_CHARS
  );

  return section.trim();
}

function extractByParagraphs(
  text: string,
  index: TextLineIndex,
  anchorLine: number,
  anchorPosition: number
): string {
  const paragraphStart = findParagraphStart(index, anchorLine);
  const paragraphEnd = findParagraphEnd(index, anchorLine);

  let startLine = paragraphStart;
  let endLine = paragraphEnd;

  // Expand by one neighboring paragraph on each side for better legal context.
  const previousParagraphStart = findPreviousParagraphStart(index, paragraphStart);
  if (previousParagraphStart >= 0) {
    startLine = previousParagraphStart;
  }

  const nextParagraphEnd = findNextParagraphEnd(index, paragraphEnd);
  if (nextParagraphEnd >= 0) {
    endLine = nextParagraphEnd;
  }

  const sliceStart = index.starts[startLine] ?? 0;
  const sliceEnd = index.ends[endLine] ?? text.length;
  const context = extractBoundedSlice(
    text,
    sliceStart,
    sliceEnd,
    anchorPosition,
    MAX_PARAGRAPH_CONTEXT_CHARS
  );

  return context.trim();
}

function buildLineIndex(text: string): TextLineIndex {
  const lines = text.split('\n');
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;

  for (let i = 0; i < lines.length; i++) {
    starts.push(cursor);
    const hasNewline = i < lines.length - 1;
    const lineLength = lines[i].length + (hasNewline ? 1 : 0);
    cursor += lineLength;
    ends.push(cursor);
  }

  return { starts, ends, lines };
}

function findLineIndexForPosition(index: TextLineIndex, position: number): number {
  const safePosition = clampPosition(position, index.ends[index.ends.length - 1] ?? 0);
  let low = 0;
  let high = index.starts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = index.starts[mid];
    const end = index.ends[mid];
    if (safePosition < start) {
      high = mid - 1;
      continue;
    }
    if (safePosition >= end) {
      low = mid + 1;
      continue;
    }
    return mid;
  }

  return Math.max(0, Math.min(index.starts.length - 1, low));
}

function findNearestHeadingLine(index: TextLineIndex, anchorLine: number): number {
  for (let line = anchorLine; line >= 0; line--) {
    if (isHeadingLine(index.lines[line])) {
      return line;
    }
  }
  return -1;
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (startsWithMarker(trimmed)) {
    return false;
  }

  if (getNumberedHeadingInfo(trimmed)) {
    return true;
  }

  // Uppercase title heading fallback for less structured files.
  return /^[A-Z][A-Z0-9\s,&()/'"\-]{4,}$/.test(trimmed);
}

function getNumberedHeadingInfo(line: string): NumberedHeadingInfo | null {
  const match = line.match(/^\s*(\d+(?:\.\d+){0,6})\.?\s+\S/);
  if (!match) {
    return null;
  }
  const id = match[1];
  const level = id.split('.').length;
  return { id, level };
}

function findParagraphStart(index: TextLineIndex, lineIndex: number): number {
  let line = lineIndex;
  while (line > 0 && index.lines[line - 1].trim().length > 0) {
    line--;
  }
  return line;
}

function findParagraphEnd(index: TextLineIndex, lineIndex: number): number {
  let line = lineIndex;
  while (line < index.lines.length - 1 && index.lines[line + 1].trim().length > 0) {
    line++;
  }
  return line;
}

function findPreviousParagraphStart(index: TextLineIndex, currentParagraphStart: number): number {
  let line = currentParagraphStart - 1;
  while (line >= 0 && index.lines[line].trim().length === 0) {
    line--;
  }
  if (line < 0) {
    return -1;
  }
  return findParagraphStart(index, line);
}

function findNextParagraphEnd(index: TextLineIndex, currentParagraphEnd: number): number {
  let line = currentParagraphEnd + 1;
  while (line < index.lines.length && index.lines[line].trim().length === 0) {
    line++;
  }
  if (line >= index.lines.length) {
    return -1;
  }
  return findParagraphEnd(index, line);
}

function extractBoundedSlice(
  text: string,
  start: number,
  end: number,
  anchorPosition: number,
  maxChars: number
): string {
  const safeStart = clampPosition(start, text.length);
  const safeEnd = clampPosition(end, text.length);
  if (safeEnd <= safeStart) {
    return '';
  }

  const spanLength = safeEnd - safeStart;
  if (spanLength <= maxChars) {
    return text.slice(safeStart, safeEnd);
  }

  const introLength = Math.min(900, Math.floor(maxChars * 0.35));
  const introEnd = safeStart + introLength;
  const anchor = clampPosition(anchorPosition, text.length);

  const tailBudget = Math.max(400, maxChars - introLength - 6);
  let tailStart = Math.max(introEnd, anchor - Math.floor(tailBudget / 2));
  let tailEnd = Math.min(safeEnd, tailStart + tailBudget);
  if (tailEnd - tailStart < tailBudget) {
    tailStart = Math.max(introEnd, tailEnd - tailBudget);
  }

  const intro = text.slice(safeStart, introEnd).trimEnd();
  const tail = text.slice(tailStart, tailEnd).trim();
  return `${intro}\n...\n${tail}`;
}

function clampPosition(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function shouldPairAsModification(deletedPart: string, addedPart: string): boolean {
  const deletedHasMarker = containsMarkerDirective(deletedPart);
  const addedHasMarker = containsMarkerDirective(addedPart);
  if (deletedHasMarker !== addedHasMarker) {
    return false;
  }

  const deletedClause = extractLeadingClauseId(deletedPart);
  const addedClause = extractLeadingClauseId(addedPart);

  if (deletedClause && addedClause && deletedClause === addedClause) {
    return true;
  }

  return textSimilarity(deletedPart, addedPart) >= 0.34;
}

function hasAnyModificationPairCandidate(
  deletedParts: string[],
  addedParts: string[]
): boolean {
  for (const deletedPart of deletedParts) {
    for (const addedPart of addedParts) {
      if (shouldPairAsModification(deletedPart, addedPart)) {
        return true;
      }
    }
  }

  return false;
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
  return /^\s*\[[A-Za-z][A-Za-z0-9 _-]{0,24}\s*:/.test(value);
}

function containsMarkerDirective(value: string): boolean {
  return /\[[A-Za-z][A-Za-z0-9 _-]{0,24}\s*:/.test(value);
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

function isSuppressedNonMeaningfulChange(unit: DiffUnit): boolean {
  if (unit.kind !== 'change') {
    return false;
  }

  if (unit.type === 'addition') {
    return normalizeForMeaningfulComparison(unit.proposedText || '').length === 0;
  }

  if (unit.type === 'deletion') {
    return normalizeForMeaningfulComparison(unit.originalText || '').length === 0;
  }

  const original = normalizeForMeaningfulComparison(unit.originalText ?? '');
  const proposed = normalizeForMeaningfulComparison(unit.proposedText ?? '');

  if (original.length === 0 && proposed.length === 0) {
    return true;
  }

  return original === proposed;
}

function normalizeForMeaningfulComparison(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/([A-Za-z0-9])\s*-\s*([A-Za-z0-9])/g, '$1-$2')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}
