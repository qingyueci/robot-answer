export type RelationshipState = {
  stage: "established_partner";
  stageLabel: string;
  familiarityText: string;
  totalUserTurns: number;
  lastInteractionAt: string | null;
  lastMoment: string;
  updatedAt: string;
};

export type JournalEntry = {
  id: string;
  day: string;
  title: string;
  summary: string;
  mood: string;
  important: boolean;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Letter = {
  id: string;
  title: string;
  body: string;
  closing: string;
  contextSummary: string;
  sender: "robot" | "user";
  replyToId: string | null;
  createdAt: string;
};

export type TopicStatus = "active" | "completed" | "dismissed";

export type OpenTopic = {
  id: string;
  content: string;
  status: TopicStatus;
  followUpCount: number;
  lastFollowUpAt: string | null;
  sourceMemoryId: string | null;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type EmotionState = {
  mood: string;
  expiresAt: string;
  sourceMessageId: string | null;
  updatedAt: string;
};
