import DiffMatchPatch from 'diff-match-patch';
import type { Difference } from '../types';

const dmp = new DiffMatchPatch();

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

  // Convert diff-match-patch format to our Difference format
  const differences = convertToDifferences(diffs);

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

function convertToDifferences(diffs: [number, string][]): Difference[] {
  const differences: Difference[] = [];
  let originalPosition = 0;
  let proposedPosition = 0;
  let diffIndex = 0;

  while (diffIndex < diffs.length) {
    const [op, text] = diffs[diffIndex];

    // Skip unchanged parts
    if (op === 0) {
      originalPosition += text.length;
      proposedPosition += text.length;
      diffIndex++;
      continue;
    }

    // Check if this is a modification (deletion followed by addition)
    if (
      op === -1 &&
      diffIndex + 1 < diffs.length &&
      diffs[diffIndex + 1][0] === 1
    ) {
      // This is a modification
      const deletedText = text;
      const addedText = diffs[diffIndex + 1][1];

      differences.push({
        id: `diff-${differences.length}`,
        type: 'modification',
        originalText: deletedText,
        proposedText: addedText,
        originalPosition: {
          start: originalPosition,
          end: originalPosition + deletedText.length,
        },
        proposedPosition: {
          start: proposedPosition,
          end: proposedPosition + addedText.length,
        },
        context: getContext(diffs, diffIndex),
      });

      originalPosition += deletedText.length;
      proposedPosition += addedText.length;
      diffIndex += 2;
    } else if (op === -1) {
      // Pure deletion
      differences.push({
        id: `diff-${differences.length}`,
        type: 'deletion',
        originalText: text,
        proposedText: null,
        originalPosition: {
          start: originalPosition,
          end: originalPosition + text.length,
        },
        context: getContext(diffs, diffIndex),
      });

      originalPosition += text.length;
      diffIndex++;
    } else if (op === 1) {
      // Pure addition
      differences.push({
        id: `diff-${differences.length}`,
        type: 'addition',
        originalText: null,
        proposedText: text,
        proposedPosition: {
          start: proposedPosition,
          end: proposedPosition + text.length,
        },
        context: getContext(diffs, diffIndex),
      });

      proposedPosition += text.length;
      diffIndex++;
    } else {
      diffIndex++;
    }
  }

  return differences;
}

function getContext(diffs: [number, string][], currentIndex: number): string {
  const contextParts: string[] = [];

  // Get some text before
  for (let i = Math.max(0, currentIndex - 2); i < currentIndex; i++) {
    if (diffs[i][0] === 0) {
      const text = diffs[i][1];
      contextParts.push(text.slice(-50));
    }
  }

  // Get some text after
  for (
    let i = currentIndex + 1;
    i < Math.min(diffs.length, currentIndex + 3);
    i++
  ) {
    if (diffs[i][0] === 0) {
      const text = diffs[i][1];
      contextParts.push(text.slice(0, 50));
      break;
    }
  }

  return contextParts.join('...').trim();
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
  let originalHTML = '';
  let proposedHTML = '';
  let diffId = 0;

  for (let i = 0; i < diffs.length; i++) {
    const [op, text] = diffs[i];
    const escapedText = escapeHTML(text);

    if (op === 0) {
      originalHTML += escapedText;
      proposedHTML += escapedText;
      continue;
    }

    if (op === -1 && i + 1 < diffs.length && diffs[i + 1][0] === 1) {
      const currentId = `diff-${diffId++}`;
      const deletedText = escapeHTML(diffs[i][1]);
      const addedText = escapeHTML(diffs[i + 1][1]);
      originalHTML += wrapDiffSpan(deletedText, 'diff-removed', currentId);
      proposedHTML += wrapDiffSpan(addedText, 'diff-added', currentId);
      i++;
      continue;
    }

    if (op === -1) {
      const currentId = `diff-${diffId++}`;
      originalHTML += wrapDiffSpan(escapedText, 'diff-removed', currentId);
      continue;
    }

    if (op === 1) {
      const currentId = `diff-${diffId++}`;
      proposedHTML += wrapDiffSpan(escapedText, 'diff-added', currentId);
      continue;
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

  let html = '';
  let diffId = 0;

  for (let i = 0; i < diffs.length; i++) {
    const [op, text] = diffs[i];
    const escapedText = escapeHTML(text);

    if (op === 0) {
      html += escapedText;
      continue;
    }

    if (op === -1 && i + 1 < diffs.length && diffs[i + 1][0] === 1) {
      const currentId = `diff-${diffId++}`;
      const deletedText = escapeHTML(diffs[i][1]);
      const addedText = escapeHTML(diffs[i + 1][1]);
      html += wrapDiffSpan(deletedText, 'diff-removed', currentId);
      html += wrapDiffSpan(addedText, 'diff-added', currentId);
      i++;
      continue;
    }

    if (op === -1) {
      const currentId = `diff-${diffId++}`;
      html += wrapDiffSpan(escapedText, 'diff-removed', currentId);
      continue;
    }

    if (op === 1) {
      const currentId = `diff-${diffId++}`;
      html += wrapDiffSpan(escapedText, 'diff-added', currentId);
      continue;
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

function wrapDiffSpan(text: string, className: string, diffId: string): string {
  return `<span class="diff-segment ${className}" data-diff-id="${diffId}">${text}</span>`;
}
