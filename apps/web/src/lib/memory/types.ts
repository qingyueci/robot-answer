export const MEMORY_CATEGORIES = [
  "ordinary_preference",
  "stable_fact",
  "personality_inference",
  "sensitive",
  "open_loop",
  "temporary_state",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryStatus = "candidate" | "confirmed" | "rejected";

export type MemoryRecord = {
  id: string;
  content: string;
  category: MemoryCategory;
  status: MemoryStatus;
  sensitive: boolean;
  confidence: number;
  sourceConversationId: string | null;
  sourceExcerpt: string;
  expiresAt: string | null;
  mem0Id: string | null;
  aboutThirdParty: boolean;
  governanceReason: string;
  createdAt: string;
  updatedAt: string;
};

export type ExtractedMemory = {
  content: string;
  category: MemoryCategory;
  sensitive: boolean;
  confidence: number;
};
