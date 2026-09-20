export type Criteria = string | Record<string, unknown>; // passed to Jev as-is

export interface CategoryOption {
  label: string | null;
  criteria: Criteria;
}
export interface FlagConfig {
  label: string;
  threshold: number;
  instructions: string;
  criteria: Criteria;
}
export interface LabelConfig {
  model: string;
  body: { maxChars: number };
  category: {
    instructions: string;
    maxLabels: number;
    thresholds: { primary: number; secondary: number };
    options: Record<string, CategoryOption>;
  };
  flags: Record<string, FlagConfig>;
}

export interface MessageState {
  subject: string;
  from: { name: string | null; address: string | null; domain: string | null };
  to_me_directly: boolean;
  gmail_category: string | null; // labelId starting with CATEGORY_, else null
  bulk_signals: {
    list_unsubscribe: boolean; // List-Unsubscribe header present
    precedence: string | null; // lowercased header value
    auto_submitted: string | null; // lowercased header value
  };
  body: string; // plain text, truncated to maxChars
}

export type QuestionSpec =
  | { id: string; type: "choice"; instructions: string; options: Record<string, Criteria> }
  | { id: string; type: "noul"; instructions: string; criteria: Criteria };

export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: QuestionSpec[];
}
export interface SystemOneCaller {
  systemOne(request: SystemOneRequest): Promise<unknown>;
}

export interface ClassificationResult {
  model: string;
  category: { choice: string; probabilities: Record<string, number>; confidence: number };
  flags: Record<string, number>; // flag id -> noul value
}
