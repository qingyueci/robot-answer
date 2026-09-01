import type { UIMessage } from "ai";

export const EMOTION_TTL_MS = 12 * 60 * 60 * 1000;
export const AUTO_TOPIC_DELAY_MS = 30 * 60 * 1000;
export const PROACTIVE_CANDIDATE_TTL_MS = 2 * 60 * 1000;

export type ProactiveThreadState =
  | "active"
  | "open"
  | "settled"
  | "departing";

export const ROBOT_POLICY_DATA_PART_TYPE = "data-robot-policy" as const;

export type PersistedRobotPolicy = {
  threadState?: ProactiveThreadState;
  conversationMove?: string;
  bubbleLayout?: "single" | "split";
};

const CONVERSATION_MOVES = new Set([
  "participate",
  "continue_thread",
  "support",
  "answer",
  "close",
]);

function normalizedRobotPolicy(
  value: unknown,
  requireVersion: boolean,
): PersistedRobotPolicy | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (requireVersion && record.version !== 1) return null;

  const threadState =
    record.threadState === "active" ||
    record.threadState === "open" ||
    record.threadState === "settled" ||
    record.threadState === "departing"
      ? record.threadState
      : undefined;
  const conversationMove =
    typeof record.conversationMove === "string" &&
    CONVERSATION_MOVES.has(record.conversationMove)
      ? record.conversationMove
      : undefined;
  const bubbleLayout =
    record.bubbleLayout === "single" || record.bubbleLayout === "split"
      ? record.bubbleLayout
      : undefined;
  if (!threadState && !conversationMove && !bubbleLayout) return null;
  return { threadState, conversationMove, bubbleLayout };
}

/**
 * Message metadata 不会进入现有 Supabase 行；同一份策略状态同时保存在 data part，
 * 让它沿用已有 parts JSON 持久化，不引入数据库字段。
 */
export function readPersistedRobotPolicy(
  message: Pick<UIMessage, "metadata" | "parts"> | undefined,
) {
  if (!message) return null;
  const metadataPolicy = normalizedRobotPolicy(message.metadata, false);
  const part = message.parts.find(
    (candidate) => candidate.type === ROBOT_POLICY_DATA_PART_TYPE,
  );
  const partPolicy = part && "data" in part
    ? normalizedRobotPolicy(part.data, true)
    : null;
  if (!metadataPolicy) return partPolicy;
  if (!partPolicy) return metadataPolicy;
  return {
    threadState: metadataPolicy.threadState ?? partPolicy.threadState,
    conversationMove:
      metadataPolicy.conversationMove ?? partPolicy.conversationMove,
    bubbleLayout: metadataPolicy.bubbleLayout ?? partPolicy.bubbleLayout,
  };
}

export function withPersistedRobotPolicy(message: UIMessage): UIMessage {
  const policy = readPersistedRobotPolicy(message);
  if (!policy) return message;
  const part: UIMessage["parts"][number] = {
    type: ROBOT_POLICY_DATA_PART_TYPE,
    data: { version: 1, ...policy },
  };
  return {
    ...message,
    parts: [
      ...message.parts.filter(
        (candidate) => candidate.type !== ROBOT_POLICY_DATA_PART_TYPE,
      ),
      part,
    ],
  };
}

export type ProactiveSendGateSnapshot = {
  candidateEpoch: number;
  currentEpoch: number;
  candidateConversationId: string | null;
  currentConversationId: string | null;
  basedOnMessageId: string | null;
  latestMessageId: string | null;
  inputEmpty: boolean;
  visible: boolean;
  busy: boolean;
  threadState: ProactiveThreadState;
  allowActiveAfterIdle?: boolean;
};

const MEANINGLESS_MOMENT_PATTERN =
  /^(ok+|yes|no|好(的)?|嗯+|哈+|可以|知道了|行(吧)?|在吗|在)[\s。.!！,，、~～?？…]*$/i;

/** 短不等于无信息；只过滤空文本与明确的 ACK。 */
export function isMeaninglessMomentText(text: string) {
  const trimmed = text.trim();
  return !trimmed || MEANINGLESS_MOMENT_PATTERN.test(trimmed);
}

export function emotionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + EMOTION_TTL_MS).toISOString();
}

export function isFollowUpQuietHours(now = new Date()) {
  const hour = now.getHours();
  return hour < 9 || hour > 23 || (hour === 23 && now.getMinutes() >= 30);
}

export function followUpMessage(content: string, count: number) {
  const topic = content
    .replace(/^观棋(?:正在|准备|计划|想要|希望|决定)?/, "")
    .replace(/[。；;]+$/, "")
    .trim()
    .slice(0, 72);
  return count <= 1
    ? `你前面提到「${topic}」，后来有一点新进展吗？没有也没关系。`
    : `关于「${topic}」，我再轻轻问一次。现在还想继续就告诉我；不想的话，我先放下。`;
}

export function shouldScheduleAutoTopic(
  userText: string,
  assistantText: string,
  threadState: ProactiveThreadState = "settled",
) {
  const user = userText.trim();
  const assistant = assistantText.trim();
  if (!user || !assistant) return false;
  if (threadState === "departing") return false;
  if (/晚安|睡了|去忙|先忙|不聊了|下次再聊|回头再聊|先这样/.test(user)) {
    return false;
  }
  // active 只阻止最近交互窗口内插话；30 分钟 timer 到期后交给模型仲裁。
  if (threadState === "active") return true;
  return !/[？?]\s*$/.test(assistant);
}

/**
 * 生成前的 active 表示“这一轮需要认真处理”，不必然表示回复完成后仍未闭合。
 * 普通 answer 已完整落地且没有留下问题时降为 open；深度推理和
 * continue_thread 继续保持 active。
 */
export function postTurnThreadState(input: {
  declaredState: ProactiveThreadState;
  conversationMove?: string;
  assistantText: string;
  hasDeepReasoning: boolean;
}): ProactiveThreadState {
  if (
    input.declaredState === "active" &&
    input.conversationMove === "answer" &&
    !input.hasDeepReasoning &&
    !/[？?]\s*$/.test(input.assistantText.trim())
  ) {
    return "open";
  }
  return input.declaredState;
}

/**
 * 主动消息的客户端最终闸门。候选生成只说明“可以考虑说”，这里的所有
 * 快照仍一致，才说明“此刻可以发送”。保持为纯函数，方便覆盖竞态回归。
 */
export function canSendProactiveCandidate(
  snapshot: ProactiveSendGateSnapshot,
) {
  return (
    snapshot.candidateEpoch === snapshot.currentEpoch &&
    snapshot.candidateConversationId === snapshot.currentConversationId &&
    snapshot.basedOnMessageId === snapshot.latestMessageId &&
    snapshot.inputEmpty &&
    snapshot.visible &&
    !snapshot.busy &&
    (snapshot.threadState !== "active" ||
      snapshot.allowActiveAfterIdle === true) &&
    snapshot.threadState !== "departing"
  );
}

export function isProactiveCandidateFresh(
  generatedAt: string,
  now = new Date(),
) {
  const generatedTime = Date.parse(generatedAt);
  const age = now.getTime() - generatedTime;
  return (
    Number.isFinite(generatedTime) &&
    age >= 0 &&
    age <= PROACTIVE_CANDIDATE_TTL_MS
  );
}
