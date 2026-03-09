export interface Document {
  id: string;
  name: string;
  type: 'original' | 'proposed';
  fileType: string;
  text: string;
  uploadedAt: Date;
  sizeBytes?: number;
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
  aiConfidence?: number; // 0-100
  category: string;
  manualOverride?: boolean;
  manualOverrideAt?: Date;
  autoRiskLevel?: 'low' | 'medium' | 'high';
  autoAiConfidence?: number;
  autoCategory?: string;
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
  customerId: string;
  originalDocument: Document | null;
  proposedDocument: Document | null;
  differences: Difference[];
  riskAnalyses: RiskAnalysis[];
  groupingReviews: GroupingReview[];
  groupingActionLogs: GroupingActionLog[];
  notes: Note[];
  changeResponses?: ChangeResponse[];
  createdAt: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'pending_review' | 'reviewed';
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

export type CustomerColor = 'blue' | 'emerald' | 'violet' | 'orange' | 'rose' | 'cyan';

export interface Customer {
  id: string;
  name: string;
  color: CustomerColor;
  initials: string;
  createdAt: Date;
}

export type ChangeResponseStatus = 'pending' | 'accepted' | 'countered' | 'rejected' | 'ignored';

export interface ChangeResponse {
  id: string;
  comparisonId: string;
  changeId: string;
  status: ChangeResponseStatus;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DefaultOriginalAgreement {
  id: string;
  name: string;
  fileType: string;
  text: string;
  sizeBytes?: number;
  uploadedAt: Date;
}
