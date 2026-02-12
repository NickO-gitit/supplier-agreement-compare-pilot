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
  analyzedAt: Date;
  status?: 'ok' | 'error';
  error?: string;
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
