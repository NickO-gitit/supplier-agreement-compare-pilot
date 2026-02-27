export interface Document {
  id: string;
  name: string;
  type: 'original' | 'proposed';
  fileType: string;
  text: string;
  uploadedAt: Date;
}

export interface Difference {
  id: string;
  type: 'addition' | 'deletion' | 'modification';
  originalText: string | null;
  proposedText: string | null;
  originalPosition?: { start: number; end: number };
  proposedPosition?: { start: number; end: number };
  context: string;
}

export interface RiskAnalysis {
  differenceId: string;
  riskLevel: 'low' | 'medium' | 'high';
  category: string;
  explanation: string;
  legalImplication: string;
  recommendation: string;
  analysisDetailLevel?: 'standard' | 'expanded';
  analysisTrace?: {
    provider: 'proxy' | 'direct';
    prompt: string;
    rawResponse: string;
    route?: string;
    model?: string;
    timestamp: string;
  };
  analyzedAt: Date;
  status?: 'ok' | 'error';
  error?: string;
}

export interface GroupingReview {
  differenceId: string;
  quality: 'good' | 'over_grouped' | 'over_split' | 'unclear';
  suggestedAction: 'keep' | 'split' | 'merge_with_previous' | 'merge_with_next';
  section: string;
  summary: string;
  rationale: string;
  confidence: number;
  reviewedAt: Date;
  status?: 'ok' | 'error';
  error?: string;
}

export interface GroupingActionLogItem {
  sourceDifferenceId: string;
  appliedAction: 'split' | 'merge_with_previous' | 'merge_with_next';
  confidence: number;
  quality: GroupingReview['quality'];
  section: string;
  summary: string;
  resultDifferenceIds: string[];
}

export interface GroupingActionLog {
  id: string;
  runAt: Date;
  totalReviews: number;
  appliedCount: number;
  actions: GroupingActionLogItem[];
}

export interface Note {
  id: string;
  differenceId: string | null;
  content: string;
  category: 'question' | 'concern' | 'approved' | 'rejected' | 'general';
  createdAt: Date;
  updatedAt: Date;
}

export interface Comparison {
  id: string;
  originalDocument: Document | null;
  proposedDocument: Document | null;
  differences: Difference[];
  riskAnalyses: RiskAnalysis[];
  groupingReviews: GroupingReview[];
  groupingActionLogs: GroupingActionLog[];
  notes: Note[];
  createdAt: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export interface ComparisonSummary {
  totalChanges: number;
  additions: number;
  deletions: number;
  modifications: number;
  highRiskCount: number;
  mediumRiskCount: number;
  lowRiskCount: number;
}
