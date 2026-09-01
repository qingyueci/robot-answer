import {
  getRelationshipState,
  isMeaninglessMomentText,
  listJournalEntries,
  listOpenTopics,
} from "@/lib/companion/store";
import { evidenceForMemory, type RecallEvidence } from "./grounding";
import {
  getMemoryRecord,
  getMemoryRecordByMem0Id,
  listMemoryRecords,
} from "./local-store";
import {
  rankRecallCandidates,
  recallTextSimilarity,
  RECALL_ROUTES,
  type RecallCandidate,
  type RecallRoute,
} from "./recall-ranking";
import { searchConfirmedMemories } from "./service";

type RouteCounts = Record<RecallRoute, number>;

function emptyRouteCounts(): RouteCounts {
  return Object.fromEntries(RECALL_ROUTES.map((route) => [route, 0])) as RouteCounts;
}

function recentEnough(value: string, withinDays: number) {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp >= Date.now() - withinDays * 86_400_000
  );
}

function clamp(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(0, Math.min(1, number))
    : fallback;
}

function reliabilityForEvidence(evidence: RecallEvidence) {
  if (evidence.evidenceKind === "user_confirmed") {
    return Math.max(0.95, evidence.confidence);
  }
  if (evidence.evidenceKind === "model_inference") {
    return Math.min(0.65, evidence.confidence);
  }
  return Math.max(0.55, evidence.confidence);
}

function semanticFallbackEvidence(
  id: string,
  metadata: Record<string, unknown> | undefined,
): RecallEvidence {
  const memoryType =
    typeof metadata?.category === "string" ? metadata.category : "unknown";
  const confidence = clamp(metadata?.confidence, 0.62);
  const userConfirmed = metadata?.userConfirmed === true;
  return {
    evidenceKind:
      memoryType === "personality_inference"
        ? "model_inference"
        : userConfirmed
          ? "user_confirmed"
          : "user_statement",
    // 缺少本地 confirmed 记录时保守降级，不能仅凭向量命中宣称确定事实。
    assertionMode:
      userConfirmed && memoryType !== "personality_inference"
        ? "fact"
        : "qualified",
    confidence,
    memoryType,
    source:
      typeof metadata?.sourceConversationId === "string"
        ? `conversation:${metadata.sourceConversationId}`
        : `mem0:${id}`,
  };
}

function addCandidate(
  candidates: RecallCandidate[],
  counts: RouteCounts,
  candidate: RecallCandidate,
) {
  candidates.push(candidate);
  counts[candidate.route] += 1;
}

/**
 * 五路召回：
 * 1. 关键词：本地已确认记忆；
 * 2. 语义：Mem0/Qdrant；
 * 3. 时间：近期记忆与日记；
 * 4. 话题：当前摘要与未完话题；
 * 5. 关系：最近一次有信息量的关系片段。
 */
export async function retrieveUnifiedMemory(input: {
  query: string;
  summary?: string | null;
  summaryUpdatedAt?: string | null;
  limit?: number;
}) {
  const query = input.query.trim();
  const generated = emptyRouteCounts();
  const candidates: RecallCandidate[] = [];
  if (!query) {
    return { items: [], generated, selected: emptyRouteCounts() };
  }

  let memories: ReturnType<typeof listMemoryRecords> = [];
  try {
    memories = listMemoryRecords("confirmed").filter(
      (memory) => !memory.expiresAt || memory.expiresAt > new Date().toISOString(),
    );
  } catch {
    // 本地记忆库暂时不可读时，其余四路继续工作。
  }

  const keywordMatches = memories
    .map((memory) => ({
      memory,
      relevance: recallTextSimilarity(query, memory.content),
    }))
    .filter(
      ({ relevance }) => relevance >= 0.1,
    )
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 12);
  keywordMatches.forEach(({ memory, relevance }, index) => {
    const evidence = evidenceForMemory(memory);
    addCandidate(candidates, generated, {
      id: memory.id,
      content: memory.content,
      route: "keyword",
      sourceType: `memory:${memory.category}`,
      ...evidence,
      baseScore: relevance,
      reliability: reliabilityForEvidence(evidence),
      routeRank: index + 1,
      updatedAt: memory.updatedAt,
    });
  });

  try {
    const semantic = await searchConfirmedMemories(query);
    semantic.slice(0, 8).forEach((item, index) => {
      const content =
        typeof item.memory === "string" ? item.memory.trim() : "";
      if (!content) return;
      const vectorId =
        typeof item.id === "string" ? item.id : `semantic:${index}`;
      const metadata = item.metadata as Record<string, unknown> | undefined;
      let local: ReturnType<typeof getMemoryRecordByMem0Id> = null;
      try {
        local = getMemoryRecordByMem0Id(vectorId);
        if (!local && typeof metadata?.localMemoryId === "string") {
          local = getMemoryRecord(metadata.localMemoryId);
        }
      } catch {
        // 本地库异常时仍可使用带 confirmed metadata 的向量结果，但降低断言强度。
      }
      if (
        local &&
        (local.status !== "confirmed" ||
          Boolean(local.expiresAt && local.expiresAt <= new Date().toISOString()))
      ) {
        return;
      }
      const evidence = local
        ? evidenceForMemory(local)
        : semanticFallbackEvidence(vectorId, metadata);
      const metadataTimestamp =
        typeof metadata?.updatedAt === "string"
          ? metadata.updatedAt
          : typeof metadata?.createdAt === "string"
            ? metadata.createdAt
            : null;
      addCandidate(candidates, generated, {
        id: local?.id ?? vectorId,
        // 本地 confirmed 记录是当前真值；向量正文可能尚未同步更新。
        content: local?.content ?? content,
        route: "semantic",
        sourceType: "mem0",
        ...evidence,
        baseScore: Number(item.score) || 0.45,
        reliability: local
          ? reliabilityForEvidence(evidence)
          : Math.min(0.72, Math.max(0.5, evidence.confidence)),
        routeRank: index + 1,
        updatedAt: local?.updatedAt ?? metadataTimestamp,
      });
    });
  } catch {
    // 向量服务异常时保留本地四路召回，不阻断回复。
  }

  let temporalRank = 1;
  for (const memory of memories.filter((item) =>
    recentEnough(item.updatedAt, 45),
  ).slice(0, 8)) {
    const relevance = recallTextSimilarity(query, memory.content);
    if (relevance < 0.05) continue;
    const evidence = evidenceForMemory(memory);
    addCandidate(candidates, generated, {
      id: memory.id,
      content: memory.content,
      route: "temporal",
      sourceType: `recent-memory:${memory.category}`,
      ...evidence,
      baseScore: 0.35 + relevance * 0.65,
      reliability: reliabilityForEvidence(evidence),
      routeRank: temporalRank++,
      updatedAt: memory.updatedAt,
    });
  }
  try {
    for (const journal of listJournalEntries(12)) {
      const content = `${journal.title}：${journal.summary}`.trim();
      const relevance = recallTextSimilarity(query, content);
      if (relevance < 0.08 && !journal.important) continue;
      addCandidate(candidates, generated, {
        id: journal.id,
        content,
        route: "temporal",
        sourceType: "journal",
        evidenceKind: "derived_summary",
        assertionMode: "qualified",
        confidence: journal.important ? 0.8 : 0.62,
        memoryType: "journal",
        source: `journal:${journal.id}`,
        baseScore: 0.3 + relevance * 0.7,
        reliability: journal.important ? 0.82 : 0.62,
        routeRank: temporalRank++,
        updatedAt: journal.updatedAt,
      });
    }
  } catch {
    // 日记库不可读时静默降级。
  }

  let topicRank = 1;
  if (input.summary?.trim()) {
    addCandidate(candidates, generated, {
      id: "current-conversation-summary",
      content: `当前话题摘要：${input.summary.trim()}`,
      route: "topic",
      sourceType: "conversation-summary",
      evidenceKind: "derived_summary",
      assertionMode: "context_only",
      confidence: 0.72,
      memoryType: "conversation_summary",
      source: "current-conversation-summary",
      baseScore: 0.9,
      reliability: 0.72,
      routeRank: topicRank++,
      updatedAt: input.summaryUpdatedAt ?? null,
    });
  }
  try {
    for (const topic of listOpenTopics("active").slice(0, 12)) {
      const relevance = recallTextSimilarity(query, topic.content);
      if (relevance < 0.06) continue;
      addCandidate(candidates, generated, {
        id: topic.id,
        content: `仍可接续的话题：${topic.content}`,
        route: "topic",
        sourceType: "open-topic",
        evidenceKind: "topic_state",
        assertionMode: "context_only",
        confidence: 0.75,
        memoryType: "open_topic",
        source: `open-topic:${topic.id}`,
        baseScore: 0.4 + relevance * 0.6,
        reliability: 0.75,
        routeRank: topicRank++,
        updatedAt: topic.updatedAt,
      });
    }
  } catch {
    // 话题库不可读时静默降级。
  }

  try {
    const relationship = getRelationshipState();
    const lastMoment = relationship.lastMoment.trim();
    const relevance = recallTextSimilarity(query, lastMoment);
    if (
      lastMoment &&
      !isMeaninglessMomentText(lastMoment) &&
      relevance >= 0.05
    ) {
      addCandidate(candidates, generated, {
        id: "relationship:last-moment",
        content: `最近关系背景：${lastMoment}`,
        route: "relationship",
        sourceType: "relationship-state",
        evidenceKind: "derived_summary",
        assertionMode: "qualified",
        confidence: 0.62,
        memoryType: "relationship_state",
        source: "relationship:last-moment",
        baseScore: 0.42 + relevance * 0.58,
        reliability: 0.62,
        routeRank: 1,
        updatedAt: relationship.updatedAt,
      });
    }
  } catch {
    // 关系状态不可读时静默降级。
  }

  const items = rankRecallCandidates(query, candidates, input.limit ?? 6);
  const selected = emptyRouteCounts();
  for (const item of items) {
    for (const route of item.routes) selected[route] += 1;
  }
  return { items, generated, selected };
}
