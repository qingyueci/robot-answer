import type { UIMessage } from "ai";
import { getEmotionState } from "@/lib/companion/store";
import { ROBOT_SYSTEM_PROMPT } from "@/lib/persona/system-prompt";
import { ROBOT_INTERACTION_PROFILE } from "@/lib/persona/interaction-profile";
import { voiceExamplesForMode } from "@/lib/persona/voice-examples";
import { retrieveUnifiedMemory } from "@/lib/memory/retriever";
import type { RecallRoute } from "@/lib/memory/recall-ranking";
import {
  detectConversationMode,
  modeInstruction,
  type ConversationMode,
} from "./mode";
import {
  detectAndRecordDirectives,
  listConversationDirectives,
} from "./directives";
import { conversationKey, getChatStateDb } from "./state-db";

/**
 * 统一 Context Builder。
 *
 * 上下文优先级（从高到低）：
 * 1. 安全和关系边界（ROBOT_SYSTEM_PROMPT 作为 base）
 * 2. 用户本轮明确要求 + 当场纠正（conversation_directives）
 * 3. 当前会话模式指令
 * 4. 五路召回的统一排序结果（关键词、语义、时间、话题、关系）
 * 5. 最近有效消息（token 预算裁剪，返回值里）
 */

export type BuiltChatContext = {
  system: string;
  /** 裁剪后的最近消息（保持原结构，供 convertToModelMessages）。 */
  messages: UIMessage[];
  debug: {
    mode: ConversationMode;
    memoryIds: string[];
    /** 裁剪后消息的估算 token。 */
    contextTokens: number;
    usedSummary: boolean;
    directives: string[];
    emotion: string | null;
    recallRoutes: {
      generated: Record<RecallRoute, number>;
      selected: Record<RecallRoute, number>;
    };
  };
};

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isCjkCodePoint(code: number) {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首补充、部首、符号、平片假名、CJK 统一表意文字等
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
    (code >= 0xff00 && code <= 0xffef) || // 全角字符
    (code >= 0x20000 && code <= 0x2a6df) // CJK 扩展 B
  );
}

/** 粗略 token 估算：CJK 字符计 1，ASCII 等其余字符计 0.3，向上取整。 */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const ch of text) {
    total += isCjkCodePoint(ch.codePointAt(0) ?? 0) ? 1 : 0.3;
  }
  return Math.max(1, Math.ceil(total));
}

function contextTokenBudget() {
  const budget = Number(process.env.ROBOT_CONTEXT_TOKEN_BUDGET ?? 2400);
  return Number.isFinite(budget) && budget >= 200 ? budget : 2400;
}

/** 从最新消息往前累加，超出预算即截断；至少保留最后一条（本轮用户消息）。 */
function trimMessagesByBudget(messages: UIMessage[], budget: number) {
  const kept: UIMessage[] = [];
  let usedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(messageText(messages[i]));
    if (kept.length > 0 && usedTokens + cost > budget) break;
    kept.unshift(messages[i]);
    usedTokens += cost;
  }
  return {
    kept,
    usedTokens,
    dropped: messages.slice(0, messages.length - kept.length),
  };
}

// ---------- 当前话题摘要 ----------

type SummaryRow = {
  conversation_id: string;
  summary: string;
  message_count: number;
  updated_at: string;
};

function readSummary(key: string): SummaryRow | undefined {
  try {
    return getChatStateDb()
      .prepare("select * from conversation_summaries where conversation_id = ?")
      .get(key) as SummaryRow | undefined;
  } catch {
    return undefined;
  }
}

// ---------- 主入口 ----------

export async function buildChatContext(input: {
  conversationId: string | null;
  /** 完整消息（含本轮用户消息）。 */
  messages: UIMessage[];
  /** 本轮用户文本。 */
  userText: string;
}): Promise<BuiltChatContext> {
  const key = conversationKey(input.conversationId);

  // 2. 当场纠正（最高优先级）：识别 + 入库，再取最近 5 条。
  detectAndRecordDirectives(key, input.userText, input.messages.at(-1)?.id ?? null);
  const directives = listConversationDirectives(key, 5);

  // 4. 会话模式（轻量规则）。
  const recentUserTexts = input.messages
    .filter((message) => message.role === "user")
    .slice(-4, -1)
    .map(messageText);
  const mode = detectConversationMode(input.userText, recentUserTexts);

  // 7. 最近消息 token 预算裁剪。
  const { kept, usedTokens } = trimMessagesByBudget(
    input.messages,
    contextTokenBudget(),
  );

  // 摘要由 post-turn 同一次后台提取调用维护，这里只读，不额外调用模型。
  const summary = readSummary(key)?.summary ?? null;
  // 五路召回统一去重和排序，任一路失败都由 retriever 内部降级。
  const recall = await retrieveUnifiedMemory({
    query: input.userText,
    summary,
    limit: 6,
  });
  let emotion: string | null = null;
  try {
    emotion = getEmotionState()?.mood ?? null;
  } catch {
    // 临时状态库不可读时不阻断聊天。
  }

  // 按优先级从高到低组装 system。
  const sections: string[] = [
    ROBOT_SYSTEM_PROMPT,
    ROBOT_INTERACTION_PROFILE,
  ];
  if (directives.length > 0) {
    sections.push(
      [
        "以下用户要求在本会话中具有最高优先级：",
        ...directives.map((directive) => `- ${directive}`),
      ].join("\n"),
    );
  }
  sections.push(modeInstruction(mode));
  sections.push(voiceExamplesForMode(mode));
  if (emotion) {
    sections.push(
      `用户近期的轻量情绪状态：${emotion}。这只是会自动过期的临时背景；本轮明确表达优先，不要据此给用户贴标签。`,
    );
  }
  if (recall.items.length > 0) {
    sections.push(
      [
        "以下背景已通过五路召回、跨路去重和统一排序；只在与当前话题有关时自然使用，不要逐条复述，也不要声称记得未列出的事实：",
        ...recall.items.map((item) => `- ${item.content}`),
      ].join("\n"),
    );
  }
  if (!ROBOT_SYSTEM_PROMPT.includes("不是语气范例")) {
    sections.push(
      "历史中的Home Robot 回复只代表已经发生过的对话，不是语气范例；若旧回复显得生硬，以当前要求为准。",
    );
  }

  return {
    system: sections.join("\n\n"),
    messages: kept,
    debug: {
      mode,
      memoryIds: recall.items.map((item) => item.id),
      contextTokens: usedTokens,
      usedSummary: Boolean(summary),
      directives,
      emotion,
      recallRoutes: {
        generated: recall.generated,
        selected: recall.selected,
      },
    },
  };
}
