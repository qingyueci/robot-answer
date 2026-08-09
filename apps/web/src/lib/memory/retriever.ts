import {
  getRelationshipState,
  isMeaninglessMomentText,
  listJournalEntries,
  listOpenTopics,
} from "@/lib/companion/store";
import { listMemoryRecords } from "./local-store";
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
      ({ memory, relevance }) =>
        relevance >= 0.1 || memory.category === "ordinary_preference",
    )
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 12);
  keywordMatches.forEach(({ memory, relevance }, index) => {
    addCandidate(candidates, generated, {
      id: memory.id,
      content: memory.content,
      route: "keyword",
      sourceType: `memory:${memory.category}`,
      baseScore: Math.max(
        relevance,
        memory.category === "ordinary_preference" ? 0.52 : 0,
      ),
      reliability: Math.max(0.7, memory.confidence),
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
      addCandidate(candidates, generated, {
        id: typeof item.id === "string" ? item.id : `semantic:${index}`,
        content,
        route: "semantic",
        sourceType: "mem0",
        baseScore: Number(item.score) || 0.45,
        reliability: 1,
        routeRank: index + 1,
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
    if (relevance < 0.05 && memory.category !== "ordinary_preference") continue;
    addCandidate(candidates, generated, {
      id: memory.id,
      content: memory.content,
      route: "temporal",
      sourceType: `recent-memory:${memory.category}`,
      baseScore: 0.35 + relevance * 0.65,
      reliability: Math.max(0.7, memory.confidence),
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
        baseScore: 0.3 + relevance * 0.7,
        reliability: journal.important ? 0.9 : 0.68,
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
      baseScore: 0.9,
      reliability: 1,
      routeRank: topicRank++,
      updatedAt: new Date().toISOString(),
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
        baseScore: 0.4 + relevance * 0.6,
        reliability: 0.82,
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
        content: `最近一次用户提到：${lastMoment}`,
        route: "relationship",
        sourceType: "relationship-state",
        baseScore: 0.42 + relevance * 0.58,
        reliability: 0.78,
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
