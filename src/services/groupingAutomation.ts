import type {
  Difference,
  GroupingActionLog,
  GroupingActionLogItem,
  GroupingReview,
} from '../types';

const AUTO_APPLY_MIN_CONFIDENCE = 0.72;
const CLAUSE_START_REGEX = /^\s*\d+(?:\.\d+)*\.?(?:\s|$)/;

interface ApplyGroupingSuggestionsResult {
  differences: Difference[];
  anchorMap: Record<string, string>;
  actionLog: GroupingActionLog;
}

export function applyGroupingSuggestions(
  differences: Difference[],
  reviews: GroupingReview[]
): ApplyGroupingSuggestionsResult {
  const anchorMap: Record<string, string> = {};
  differences.forEach((diff) => {
    anchorMap[diff.id] = diff.id;
  });

  const actionableById = new Map(
    reviews
      .filter(
        (review) =>
          review.status !== 'error' &&
          review.confidence >= AUTO_APPLY_MIN_CONFIDENCE &&
          (review.suggestedAction === 'split' ||
            review.suggestedAction === 'merge_with_previous' ||
            review.suggestedAction === 'merge_with_next')
      )
      .map((review) => [review.differenceId, review] as const)
  );

  const actions: GroupingActionLogItem[] = [];
  const improved: Difference[] = [];

  let index = 0;
  while (index < differences.length) {
    const current = differences[index];
    const currentReview = actionableById.get(current.id);

    if (currentReview?.suggestedAction === 'merge_with_next' && index < differences.length - 1) {
      const next = differences[index + 1];
      if (canMerge(current, next)) {
        const merged = mergeDifferences(current, next, current.id);
        improved.push(merged);
        anchorMap[next.id] = current.id;

        actions.push({
          sourceDifferenceId: current.id,
          appliedAction: 'merge_with_next',
          confidence: currentReview.confidence,
          quality: currentReview.quality,
          section: currentReview.section,
          summary: currentReview.summary,
          resultDifferenceIds: [merged.id],
        });

        index += 2;
        continue;
      }
    }

    if (currentReview?.suggestedAction === 'merge_with_previous' && improved.length > 0) {
      const previous = improved[improved.length - 1];
      if (canMerge(previous, current)) {
        const merged = mergeDifferences(previous, current, previous.id);
        improved[improved.length - 1] = merged;
        anchorMap[current.id] = previous.id;

        actions.push({
          sourceDifferenceId: current.id,
          appliedAction: 'merge_with_previous',
          confidence: currentReview.confidence,
          quality: currentReview.quality,
          section: currentReview.section,
          summary: currentReview.summary,
          resultDifferenceIds: [merged.id],
        });

        index++;
        continue;
      }
    }

    if (currentReview?.suggestedAction === 'split') {
      const splitParts = splitDifferenceByStructure(current);
      if (splitParts.length > 1) {
        splitParts.forEach((part, partIndex) => {
          const partId = partIndex === 0 ? current.id : `${current.id}__s${partIndex + 1}`;
          const partDiff: Difference = {
            ...part,
            id: partId,
          };
          improved.push(partDiff);
          anchorMap[partId] = current.id;
        });

        actions.push({
          sourceDifferenceId: current.id,
          appliedAction: 'split',
          confidence: currentReview.confidence,
          quality: currentReview.quality,
          section: currentReview.section,
          summary: currentReview.summary,
          resultDifferenceIds: splitParts.map((_, partIndex) =>
            partIndex === 0 ? current.id : `${current.id}__s${partIndex + 1}`
          ),
        });

        index++;
        continue;
      }
    }

    improved.push(current);
    index++;
  }

  return {
    differences: improved,
    anchorMap,
    actionLog: {
      id: generateLogId(),
      runAt: new Date(),
      totalReviews: reviews.length,
      appliedCount: actions.length,
      actions,
    },
  };
}

function canMerge(left: Difference, right: Difference): boolean {
  const leftClause = detectClauseId(left.originalText || left.proposedText || '');
  const rightClause = detectClauseId(right.originalText || right.proposedText || '');

  if (leftClause && rightClause && leftClause !== rightClause) {
    return false;
  }

  return true;
}

function mergeDifferences(left: Difference, right: Difference, mergedId: string): Difference {
  const mergedOriginal = concatNullable(left.originalText, right.originalText);
  const mergedProposed = concatNullable(left.proposedText, right.proposedText);

  return {
    id: mergedId,
    type: mergedType(left, right),
    originalText: mergedOriginal,
    proposedText: mergedProposed,
    originalPosition: mergePosition(left.originalPosition, right.originalPosition),
    proposedPosition: mergePosition(left.proposedPosition, right.proposedPosition),
    context: [left.context, right.context].filter(Boolean).join(' ... '),
  };
}

function mergedType(
  left: Difference,
  right: Difference
): 'addition' | 'deletion' | 'modification' {
  if (left.type === right.type) {
    return left.type;
  }
  return 'modification';
}

function concatNullable(left: string | null, right: string | null): string | null {
  if (left === null && right === null) {
    return null;
  }
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }

  const separator = left.endsWith('\n') || right.startsWith('\n') ? '' : '\n';
  return `${left}${separator}${right}`;
}

function mergePosition(
  left?: { start: number; end: number },
  right?: { start: number; end: number }
): { start: number; end: number } | undefined {
  if (!left && !right) {
    return undefined;
  }
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    start: Math.min(left.start, right.start),
    end: Math.max(left.end, right.end),
  };
}

function splitDifferenceByStructure(difference: Difference): Difference[] {
  if (difference.type === 'addition' && difference.proposedText) {
    const parts = splitStructuredText(difference.proposedText);
    return buildAdditionParts(difference, parts);
  }

  if (difference.type === 'deletion' && difference.originalText) {
    const parts = splitStructuredText(difference.originalText);
    return buildDeletionParts(difference, parts);
  }

  if (
    difference.type === 'modification' &&
    difference.originalText !== null &&
    difference.proposedText !== null
  ) {
    return buildModificationParts(difference);
  }

  return [difference];
}

function buildAdditionParts(difference: Difference, parts: string[]): Difference[] {
  if (parts.length <= 1) {
    return [difference];
  }

  const start = difference.proposedPosition?.start ?? 0;
  let offset = 0;

  return parts.map((part) => {
    const partStart = start + offset;
    offset += part.length;
    return {
      ...difference,
      proposedText: part,
      proposedPosition: {
        start: partStart,
        end: partStart + part.length,
      },
    };
  });
}

function buildDeletionParts(difference: Difference, parts: string[]): Difference[] {
  if (parts.length <= 1) {
    return [difference];
  }

  const start = difference.originalPosition?.start ?? 0;
  let offset = 0;

  return parts.map((part) => {
    const partStart = start + offset;
    offset += part.length;
    return {
      ...difference,
      originalText: part,
      originalPosition: {
        start: partStart,
        end: partStart + part.length,
      },
    };
  });
}

function buildModificationParts(difference: Difference): Difference[] {
  const originalParts = splitStructuredText(difference.originalText || '');
  const proposedParts = splitStructuredText(difference.proposedText || '');
  const max = Math.max(originalParts.length, proposedParts.length);

  if (max <= 1) {
    return [difference];
  }

  const originalStart = difference.originalPosition?.start ?? 0;
  const proposedStart = difference.proposedPosition?.start ?? 0;
  let originalOffset = 0;
  let proposedOffset = 0;

  const parts: Difference[] = [];
  for (let i = 0; i < max; i++) {
    const originalPart = originalParts[i] ?? null;
    const proposedPart = proposedParts[i] ?? null;
    const partType = deriveType(originalPart, proposedPart);

    const currentOriginalStart = originalStart + originalOffset;
    const currentProposedStart = proposedStart + proposedOffset;

    if (originalPart) {
      originalOffset += originalPart.length;
    }
    if (proposedPart) {
      proposedOffset += proposedPart.length;
    }

    parts.push({
      ...difference,
      type: partType,
      originalText: originalPart,
      proposedText: proposedPart,
      originalPosition: originalPart
        ? {
            start: currentOriginalStart,
            end: currentOriginalStart + originalPart.length,
          }
        : undefined,
      proposedPosition: proposedPart
        ? {
            start: currentProposedStart,
            end: currentProposedStart + proposedPart.length,
          }
        : undefined,
    });
  }

  return parts;
}

function deriveType(
  originalText: string | null,
  proposedText: string | null
): 'addition' | 'deletion' | 'modification' {
  if (originalText && proposedText) {
    return 'modification';
  }
  if (originalText) {
    return 'deletion';
  }
  return 'addition';
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
    const trimmed = line.trim();
    const startsClause = CLAUSE_START_REGEX.test(trimmed);
    const blank = trimmed.length === 0;

    if (startsClause && current.length > 0) {
      segments.push(current);
      current = line;
      foundBoundary = true;
      continue;
    }

    current += line;

    if (blank && current.length > 0) {
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

function detectClauseId(text: string): string {
  const match = text.match(/^\s*(\d+(?:\.\d+)*\.?)(?:\s|$)/);
  if (!match) {
    return '';
  }
  return match[1].replace(/\.$/, '');
}

function generateLogId(): string {
  return `grouping-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
