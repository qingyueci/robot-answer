import type { RecallEvidence } from "./grounding";

export const RECALL_ROUTES = [
  "keyword",
  "semantic",
  "temporal",
  "topic",
  "relationship",
] as const;

export type RecallRoute = (typeof RECALL_ROUTES)[number];

export type RecallCandidate = RecallEvidence & {
  id: string;
  content: string;
  route: RecallRoute;
  sourceType: string;
  baseScore: number;
  reliability: number;
  routeRank: number;
  updatedAt?: string | null;
};

export type RankedRecall = RecallCandidate & {
  score: number;
  relevance: number;
  routes: RecallRoute[];
};

function compact(value: string) {
  return value
    .toLocaleLowerCase("zh-CN")
    .replace(
      /观棋|用户|Home Robot|目前|现在|正在|表示|提到|觉得|认为|希望|想要|准备|考虑|决定/g,
      "",
    )
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function bigrams(value: string) {
  const normalized = compact(value);
  if (!normalized) return new Set<string>();
  if (normalized.length < 2) return new Set([normalized]);
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

/** 中文短句相关度，采用包含判断和双字重叠，避免只按空格分词。 */
export function recallTextSimilarity(left: string, right: string) {
  const normalizedLeft = compact(left);
  const normalizedRight = compact(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return 1;
  }

  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  const smaller = Math.min(leftGrams.size, rightGrams.size);
  if (smaller === 0) return 0;
  let overlap = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) overlap += 1;
  }
  return overlap / smaller;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function recencyScore(updatedAt?: string | null) {
  if (!updatedAt) return 0.35;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 0.35;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.exp(-ageDays / 30);
}

function candidateScore(query: string, candidate: RecallCandidate) {
  const relevance = recallTextSimilarity(query, candidate.content);
  // RRF 项让每一路排在前面的候选都有机会进入统一排序。
  const reciprocalRank = 61 / (60 + Math.max(1, candidate.routeRank));
  const score =
    relevance * 0.38 +
    clamp(candidate.baseScore) * 0.26 +
    recencyScore(candidate.updatedAt) * 0.14 +
    clamp(candidate.reliability) * 0.12 +
    reciprocalRank * 0.1;
  return { score, relevance };
}

function groundingStrength(candidate: RecallCandidate) {
  const assertion =
    candidate.assertionMode === "fact"
      ? 3
      : candidate.assertionMode === "qualified"
        ? 2
        : 1;
  const evidence = {
    user_confirmed: 5,
    user_statement: 4,
    derived_summary: 3,
    topic_state: 2,
    model_inference: 1,
  }[candidate.evidenceKind];
  return assertion * 10 + evidence + clamp(candidate.reliability);
}

/**
 * 五路候选统一打分、跨路去重，再取全局 Top K。
 * 同一事实被多路命中会小幅加分，但不会因为重复出现占多个位置。
 */
export function rankRecallCandidates(
  query: string,
  candidates: RecallCandidate[],
  limit = 6,
): RankedRecall[] {
  const scored = candidates
    .filter((candidate) => candidate.content.trim())
    .map((candidate) => {
      const { score, relevance } = candidateScore(query, candidate);
      return {
        ...candidate,
        content: candidate.content.trim(),
        score,
        relevance,
        routes: [candidate.route],
      } satisfies RankedRecall;
    })
    .sort((left, right) => right.score - left.score);

  const merged: RankedRecall[] = [];
  for (const candidate of scored) {
    const existing = merged.find(
      (item) => recallTextSimilarity(item.content, candidate.content) >= 0.82,
    );
    if (!existing) {
      merged.push(candidate);
      continue;
    }
    if (!existing.routes.includes(candidate.route)) {
      existing.routes.push(candidate.route);
    }
    const replaceGrounding =
      groundingStrength(candidate) > groundingStrength(existing) ||
      (groundingStrength(candidate) === groundingStrength(existing) &&
        candidate.score > existing.score);
    const bestScore = Math.max(existing.score, candidate.score);
    const bestRelevance = Math.max(existing.relevance, candidate.relevance);
    if (replaceGrounding) {
      existing.id = candidate.id;
      existing.route = candidate.route;
      existing.sourceType = candidate.sourceType;
      existing.evidenceKind = candidate.evidenceKind;
      existing.assertionMode = candidate.assertionMode;
      existing.confidence = candidate.confidence;
      existing.memoryType = candidate.memoryType;
      existing.source = candidate.source;
      existing.baseScore = candidate.baseScore;
      existing.reliability = candidate.reliability;
      existing.routeRank = candidate.routeRank;
      existing.updatedAt = candidate.updatedAt;
      // 证据元数据与正文必须来自同一候选，避免把推断正文标成强事实。
      existing.content = candidate.content;
    }
    existing.relevance = bestRelevance;
    existing.score = bestScore;
  }

  return merged
    .map((item) => ({
      ...item,
      score: Math.min(1, item.score + Math.min(0.12, (item.routes.length - 1) * 0.04)),
    }))
    .filter((item) => item.score >= 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}
