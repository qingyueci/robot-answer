import { generateText } from "ai";
import {
  getBackgroundModelHandle,
  modelTimeoutMs,
} from "@/lib/model/provider";
import {
  createMemoryRecord,
  getMemoryRecord,
  getMemoryRecordByMem0Id,
  markMemoryConfirmed,
  rejectMemoryRecord,
  setMemoryGovernanceReason,
  softDeleteMemoryRecord,
  updateMemoryRecord,
} from "@/lib/memory/local-store";
import {
  addConfirmedMemory,
  deleteConfirmedMemory,
  findSimilarConfirmedMemory,
  updateConfirmedMemory,
} from "@/lib/memory/service";
import { MEMORY_CATEGORIES, type MemoryCategory } from "@/lib/memory/types";
import {
  conflictsWithCurrentFactCorrection,
  isTrivialUserTurn,
  looksContradictory,
  reflectsCurrentFactCorrection,
} from "@/lib/governance/text";
import {
  completeOpenTopicByContent,
  hasRecentAutoJournalEntry,
  isMeaninglessMomentText,
  recordRelationshipEvent,
  setEmotionState,
  upsertJournalEntryForDay,
  upsertOpenTopic,
} from "./store";

/**
 * 每轮对话结束后的统一后台提取。
 *
 * 每轮最多一次模型调用，一次输出记忆 / 日记 / 未完结话题 / 关系事件四路结果。
 * 没有可用模型或模型调用失败时返回 null —— 绝不用宽松 fallback 自动补日记。
 */

export type MemoryCandidateOut = {
  content: string;
  category: MemoryCategory;
  sensitive: boolean;
  confidence: number;
  aboutThirdParty: boolean;
};

export type JournalCandidateOut = {
  worthSaving: boolean;
  title: string;
  summary: string;
  mood: string;
  important: boolean;
};

export type OpenTopicCandidateOut = {
  content: string;
  action: "upsert" | "complete";
};

export type RelationshipEventOut = {
  kind:
    | "correction_adopted"
    | "topic_revisited"
    | "boundary_respected"
    | "meaningful_moment";
  description: string;
};

export type PostTurnExtraction = {
  memories: MemoryCandidateOut[];
  journal: JournalCandidateOut | null;
  openTopics: OpenTopicCandidateOut[];
  relationshipEvent: RelationshipEventOut | null;
  turnSummary: string;
};

export type ConversationLine = { role: "user" | "assistant"; content: string };

const RELATIONSHIP_KINDS = new Set<RelationshipEventOut["kind"]>([
  "correction_adopted",
  "topic_revisited",
  "boundary_respected",
  "meaningful_moment",
]);

const ALLOWED_CATEGORIES = new Set<string>(MEMORY_CATEGORIES);

const PROMPT = `你是「Home Robot」的后台整理器。阅读用户与 Home Robot 的一轮对话，一次性输出结构化整理结果。

硬性规则：
1. 只根据用户明确说出的内容提取，不得把 Home Robot 的话当作用户事实，不得虚构。
2. 普通闲聊、问候、一次性选择（如「点外卖还是煮云吞」）、临时吃饭计划，默认不产生 memories、journal、openTopics。
3. 同一话题只输出一个 openTopic（禁止「点外卖」和「煮云吞」两条并存）。
4. 第三方（非用户本人）的财务、房产、家庭、健康和身份信息：如确需记录，sensitive=true 且 aboutThirdParty=true；用户前任及其关系对象的详细资料默认不输出。
5. journal：只有明确情绪变化、重要经历、决定、关系修复时才 worthSaving=true；标题用朴素措辞（不超过16字，避免「陪你慢慢读」「远程饭搭子之约」这类过度浪漫化表达）；summary 用第三人称写 1 到 3 句，不虚构。用户明确表达短期情绪时，即使 worthSaving=false 也返回 journal 对象，并用 mood 写 2 到 6 个字；没有明确情绪则 mood 为空。
6. relationshipEvent：只在有可解释事件时输出（用户的纠正被采纳、重要话题被回访、边界被尊重、真正有信息量的时刻）；「ok/yes/好/嗯/哈哈」类应答禁止成为事件。
7. memories 分类只用这六类：
   - ordinary_preference：稳定偏好、表达习惯
   - stable_fact：相对稳定的个人事实
   - personality_inference：需要以后验证的性格推断
   - sensitive：健康、亲密关系、身份、财务等敏感事实
   - open_loop：承诺、待办、尚未结束的话题（应同时反映到 openTopics）
   - temporary_state：短期状态（会按 24 小时过期处理）
8. turnSummary：用 1 到 3 句记录本轮新增的事实、决定、情绪变化、未完话题或用户纠正；普通寒暄则输出空字符串。不要记录套话。
9. memories 最多 5 条，openTopics 最多 3 条；没有值得提取的内容就输出空数组和 null。

只输出一个 JSON 对象，不要 Markdown，不要任何额外文字：
{"memories":[{"content":"一条独立、简短、第三人称中文事实","category":"分类","sensitive":false,"confidence":0.0,"aboutThirdParty":false}],"journal":{"worthSaving":false,"title":"","summary":"","mood":"","important":false} 或 null,"openTopics":[{"content":"话题","action":"upsert 或 complete"}],"relationshipEvent":{"kind":"correction_adopted|topic_revisited|boundary_respected|meaningful_moment","description":"一句话"} 或 null,"turnSummary":"本轮摘要或空字符串"}

对话：
`;

function clampConfidence(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0.5;
}

function parseMemories(value: unknown): MemoryCandidateOut[] {
  if (!Array.isArray(value)) return [];
  const output: MemoryCandidateOut[] = [];
  for (const item of value) {
    if (output.length >= 5) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content =
      typeof record.content === "string" ? record.content.trim() : "";
    const category =
      typeof record.category === "string" ? record.category : "";
    if (!content || content.length > 240 || !ALLOWED_CATEGORIES.has(category)) {
      continue;
    }
    output.push({
      content,
      category: category as MemoryCategory,
      sensitive: Boolean(record.sensitive) || category === "sensitive",
      confidence: clampConfidence(record.confidence),
      aboutThirdParty: Boolean(record.aboutThirdParty),
    });
  }
  return output;
}

export function parseJournalCandidate(value: unknown): JournalCandidateOut | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const summary =
    typeof record.summary === "string" ? record.summary.trim().slice(0, 800) : "";
  const mood =
    typeof record.mood === "string" ? record.mood.trim().slice(0, 40) : "";
  const worthSaving = Boolean(record.worthSaving);
  // mood-only 不是日记，但必须继续进入短期 emotion_state。
  if (!worthSaving || !summary) {
    return mood
      ? {
          worthSaving: false,
          title: "",
          summary: "",
          mood,
          important: false,
        }
      : null;
  }
  return {
    worthSaving: true,
    title:
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim().slice(0, 16)
        : "今天的片段",
    summary,
    mood,
    important: Boolean(record.important),
  };
}

function parseOpenTopics(value: unknown): OpenTopicCandidateOut[] {
  if (!Array.isArray(value)) return [];
  const output: OpenTopicCandidateOut[] = [];
  for (const item of value) {
    if (output.length >= 3) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content =
      typeof record.content === "string" ? record.content.trim() : "";
    if (!content || content.length > 300) continue;
    output.push({
      content,
      action: record.action === "complete" ? "complete" : "upsert",
    });
  }
  return output;
}

function parseRelationshipEvent(value: unknown): RelationshipEventOut | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (!RELATIONSHIP_KINDS.has(kind as RelationshipEventOut["kind"])) return null;
  if (!description || description.length > 240) return null;
  // ok/yes/好/嗯/哈哈 类内容禁止成为事件。
  if (isMeaninglessMomentText(description)) return null;
  return { kind: kind as RelationshipEventOut["kind"], description };
}

function parseExtraction(text: string): PostTurnExtraction | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  return {
    memories: parseMemories(record.memories),
    journal: parseJournalCandidate(record.journal),
    openTopics: parseOpenTopics(record.openTopics),
    relationshipEvent: parseRelationshipEvent(record.relationshipEvent),
    turnSummary:
      typeof record.turnSummary === "string"
        ? record.turnSummary.trim().slice(0, 500)
        : "",
  };
}

/**
 * 每轮最多一次的后台模型调用。
 * 无可用模型或调用/解析失败时返回 null（调用方不得自动生成日记兜底）。
 */
export async function runPostTurnExtraction(
  lines: ConversationLine[],
): Promise<PostTurnExtraction | null> {
  const cleaned = lines
    .map((line) => ({ role: line.role, content: line.content.trim() }))
    .filter((line) => line.content)
    .slice(-8);
  if (cleaned.length === 0) return null;

  const handle = getBackgroundModelHandle();
  if (!handle) return null;

  const transcript = cleaned
    .map((line) => `${line.role === "user" ? "用户" : "Home Robot"}：${line.content}`)
    .join("\n");

  try {
    const result = await generateText({
      model: handle.model,
      // kimi-for-coding 仅接受 temperature=1。
      temperature: handle.providerLabel === "kimi-code" ? 1 : 0.1,
      maxOutputTokens: 1200,
      abortSignal: AbortSignal.timeout(modelTimeoutMs()),
      prompt: `${PROMPT}${transcript}`,
    });
    return parseExtraction(result.text);
  } catch {
    return null;
  }
}

// ---------- 落库 ----------

const RETENTION_THRESHOLD: Record<MemoryCategory, number> = {
  ordinary_preference: 0.78,
  stable_fact: 0.8,
  personality_inference: 0.9,
  sensitive: 0.94,
  open_loop: 0.76,
  temporary_state: 0.74,
};

/** 第三方「前任 / 前任对象」相关内容直接不保存（连 candidate 都不建）。 */
const EX_PARTNER_PATTERN = /前任|前男友|前女友|前夫|前妻|前对象|ex[-\s]?(男友|女友|伴侣)/i;

const TEMPORARY_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const JOURNAL_COOLDOWN_HOURS = 2;

export type ApplyPostTurnResult = {
  confirmed: number;
  candidates: number;
  journalSaved: boolean;
};

/**
 * 把提取结果按收紧后的规则落库。
 * 任何单条失败只影响该条，不抛出中断整轮处理。
 */
export async function applyPostTurnExtraction(input: {
  extraction: PostTurnExtraction;
  conversationId: string | null;
  turnId: string;
  sourceExcerpt: string;
  userText: string;
}): Promise<ApplyPostTurnResult> {
  const { extraction, conversationId, turnId, sourceExcerpt, userText } = input;
  let confirmed = 0;
  let candidates = 0;

  for (const item of extraction.memories) {
    try {
      // 直接跳过：第三方敏感详细资料、第三方且涉及前任/前任对象。
      if (item.aboutThirdParty && item.category === "sensitive") continue;
      if (
        EX_PARTNER_PATTERN.test(item.content) &&
        (item.aboutThirdParty || item.sensitive || item.category === "sensitive")
      ) {
        continue;
      }

      const expiresAt =
        item.category === "temporary_state"
          ? new Date(Date.now() + TEMPORARY_STATE_TTL_MS).toISOString()
          : null;

      const { record } = createMemoryRecord({
        content: item.content,
        category: item.category,
        sensitive: item.sensitive,
        confidence: item.confidence,
        sourceConversationId: conversationId,
        sourceExcerpt,
        expiresAt,
        aboutThirdParty: item.aboutThirdParty,
      });

      const shouldRetain =
        !record.aboutThirdParty &&
        record.confidence >= RETENTION_THRESHOLD[record.category];

      // API 当轮决定确认、忽略，或把需要更多证据的内容保留为候选。
      if (record.status !== "candidate") {
        continue;
      }
      // 性格推断即使分数很高也只是模型假设，等待后续用户证据或人工确认。
      if (record.category === "personality_inference") {
        setMemoryGovernanceReason(
          record.id,
          "模型性格推断，等待后续证据确认",
        );
        candidates += 1;
        continue;
      }
      if (reflectsCurrentFactCorrection(record.content, userText)) {
        setMemoryGovernanceReason(
          record.id,
          "用户本轮纠正旧事实，等待冲突被确认",
        );
        candidates += 1;
        continue;
      }
      if (!shouldRetain) {
        rejectMemoryRecord(
          record.id,
          `API 自动忽略：置信度 ${record.confidence.toFixed(2)}，保留阈值 ${RETENTION_THRESHOLD[record.category].toFixed(2)}`,
        );
        continue;
      }

      // 语义去重：已有高度相似的 confirmed 记忆时，更新旧记录或跳过。
      const similar = await findSimilarConfirmedMemory(record.content);
      if (similar) {
        if (
          looksContradictory(similar.memory, record.content) ||
          conflictsWithCurrentFactCorrection(similar.memory, userText)
        ) {
          setMemoryGovernanceReason(
            record.id,
            "与已有记忆冲突，等待当前事实被确认",
          );
          candidates += 1;
          continue;
        }
        if (record.content.length > similar.memory.length) {
          try {
            await updateConfirmedMemory(similar.id, record.content);
            const local = getMemoryRecordByMem0Id(similar.id);
            if (local) {
              try {
                updateMemoryRecord(local.id, record.content);
              } catch {
                // 本地内容更新失败（如 fingerprint 冲突）不影响向量已更新的事实。
              }
            }
            confirmed += 1;
          } catch {
            rejectMemoryRecord(record.id, "API 自动忽略：向量更新失败");
            continue;
          }
        }
        // 新内容是重复的：移除刚建的 candidate，避免候选列表堆积噪音。
        softDeleteMemoryRecord(record.id);
        continue;
      }

      try {
        const mem0Id = await addConfirmedMemory(record.content, record.category, {
          localMemoryId: record.id,
          sourceConversationId: record.sourceConversationId,
          sourceExcerpt: record.sourceExcerpt,
          confidence: record.confidence,
          updatedAt: record.updatedAt,
          expiresAt: record.expiresAt,
          sensitive: record.sensitive,
          aboutThirdParty: record.aboutThirdParty,
        });
        markMemoryConfirmed(record.id, mem0Id);
        if (record.category === "open_loop") {
          upsertOpenTopic({
            content: record.content,
            sourceMemoryId: record.id,
            sourceConversationId: record.sourceConversationId,
          });
        }
        confirmed += 1;
      } catch {
        rejectMemoryRecord(record.id, "API 自动忽略：记忆服务暂时不可用");
      }
    } catch {
      // 单条记忆处理失败不影响其余条目。
    }
  }

  // 未完结话题（与 open_loop 记忆相互独立，重复 upsert 由 fingerprint 幂等）。
  for (const topic of extraction.openTopics) {
    try {
      if (topic.action === "complete") {
        const completed = completeOpenTopicByContent(topic.content);
        if (completed?.sourceMemoryId) {
          const memory = getMemoryRecord(completed.sourceMemoryId);
          if (memory?.mem0Id) {
            try {
              await deleteConfirmedMemory(memory.mem0Id);
            } catch {
              // 向量删除失败时，本地仍先停用；过期过滤会避免继续进入上下文。
            }
          }
          rejectMemoryRecord(
            completed.sourceMemoryId,
            "对应的未完成话题已经结束",
          );
        }
      } else {
        upsertOpenTopic({
          content: topic.content,
          sourceConversationId: conversationId,
        });
      }
    } catch {
      // 话题落库失败不影响整轮。
    }
  }

  // 日记：冷却 2 小时（important=true 不受限），同日非重要条目自动合并。
  let journalSaved = false;
  const journal = extraction.journal;
  if (journal?.mood && !isTrivialUserTurn(userText)) {
    try {
      setEmotionState({
        mood: journal.mood,
        sourceMessageId: `${turnId}:emotion`,
      });
    } catch {
      // 临时情绪写入失败不影响日记和记忆。
    }
  }
  if (
    journal?.worthSaving &&
    journal.summary &&
    !isTrivialUserTurn(userText)
  ) {
    try {
      const cooledDown =
        !journal.important && hasRecentAutoJournalEntry(JOURNAL_COOLDOWN_HOURS);
      if (!cooledDown) {
        const journalId = upsertJournalEntryForDay({
          title: journal.title,
          summary: journal.summary,
          mood: journal.mood,
          important: journal.important,
          sourceMessageId: turnId,
          sourceConversationId: conversationId,
        });
        journalSaved = Boolean(journalId);
      }
    } catch {
      journalSaved = false;
    }
  }

  // 关系事件。
  if (extraction.relationshipEvent) {
    try {
      recordRelationshipEvent({
        kind: extraction.relationshipEvent.kind,
        description: extraction.relationshipEvent.description,
        sourceMessageId: `${turnId}:relationship`,
      });
    } catch {
      // 事件落库失败不影响整轮。
    }
  }

  return { confirmed, candidates, journalSaved };
}
