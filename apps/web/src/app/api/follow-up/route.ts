import { generateText } from "ai";
import {
  commitDueFollowUp,
  getOpenTopic,
  getRelationshipState,
  isPrivateFollowUpTopic,
  listOpenTopics,
  peekDueFollowUp,
  touchUserActivity,
} from "@/lib/companion/store";
import {
  AUTO_TOPIC_DELAY_MS,
  followUpMessage,
  isProactiveCandidateFresh,
  type ProactiveThreadState,
} from "@/lib/companion/state-policy";
import {
  getBackgroundModelHandle,
  modelTimeoutMs,
} from "@/lib/model/provider";

export const runtime = "nodejs";

type AutoTopicMessage = {
  role: "user" | "assistant";
  content: string;
};

type ProactiveCandidate = {
  kind: "auto-topic" | "due-follow-up";
  topicId: string | null;
  topicUpdatedAt: string | null;
  topicFollowUpCount: number | null;
  text: string;
  generatedAt: string;
  conversationId: string | null;
  basedOnMessageId: string | null;
};

type FollowUpRequest = {
  mode?: string;
  messages?: unknown;
  conversationId?: unknown;
  basedOnMessageId?: unknown;
  threadState?: unknown;
  candidate?: unknown;
};

function readNullableId(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 160)
    : null;
}

function readThreadState(value: unknown): ProactiveThreadState {
  return value === "active" ||
    value === "open" ||
    value === "settled" ||
    value === "departing"
    ? value
    : "settled";
}

function hasBeenIdleAt(value: string, durationMs: number) {
  const lastInteractionAt = getRelationshipState().lastInteractionAt;
  if (!lastInteractionAt) return false;
  const at = Date.parse(value);
  const lastInteraction = Date.parse(lastInteractionAt);
  return (
    Number.isFinite(at) &&
    Number.isFinite(lastInteraction) &&
    at - lastInteraction >= durationMs
  );
}

function readAutoTopicMessages(value: unknown): AutoTopicMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is AutoTopicMessage =>
        Boolean(item) &&
        typeof item === "object" &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string",
    )
    .slice(-8)
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, 800),
    }))
    .filter((item) => item.content);
}

function readCandidate(value: unknown): ProactiveCandidate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ProactiveCandidate>;
  if (
    (candidate.kind !== "auto-topic" && candidate.kind !== "due-follow-up") ||
    typeof candidate.text !== "string" ||
    !candidate.text.trim() ||
    typeof candidate.generatedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.generatedAt))
  ) {
    return null;
  }
  return {
    kind: candidate.kind,
    topicId: readNullableId(candidate.topicId),
    topicUpdatedAt:
      typeof candidate.topicUpdatedAt === "string"
        ? candidate.topicUpdatedAt
        : null,
    topicFollowUpCount:
      typeof candidate.topicFollowUpCount === "number" &&
      Number.isInteger(candidate.topicFollowUpCount)
        ? candidate.topicFollowUpCount
        : null,
    text: candidate.text.trim().slice(0, 240),
    generatedAt: candidate.generatedAt,
    conversationId: readNullableId(candidate.conversationId),
    basedOnMessageId: readNullableId(candidate.basedOnMessageId),
  };
}

async function generateAutoTopic(input: {
  messages: AutoTopicMessage[];
  conversationId: string | null;
  basedOnMessageId: string | null;
  generatedAt: string;
  abortSignal: AbortSignal;
}) {
  const handle = getBackgroundModelHandle();
  if (!handle || input.messages.length < 2) return null;

  const candidates = listOpenTopics("active")
    .filter((topic) => !isPrivateFollowUpTopic(topic.content))
    .sort((left, right) => {
      const leftCurrent = left.sourceConversationId === input.conversationId ? 1 : 0;
      const rightCurrent = right.sourceConversationId === input.conversationId ? 1 : 0;
      return rightCurrent - leftCurrent || right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 5);
  const candidateText = candidates.length
    ? candidates
        .map((topic) =>
          JSON.stringify({ id: topic.id, content: topic.content }),
        )
        .join("\n")
    : "无";
  const transcript = input.messages
    .map(
      (message) =>
        `${message.role === "user" ? "用户" : "Home Robot"}：${message.content}`,
    )
    .join("\n");

  const { text } = await generateText({
    model: handle.model,
    abortSignal: AbortSignal.any([
      input.abortSignal,
      AbortSignal.timeout(modelTimeoutMs()),
    ]),
    maxOutputTokens: 180,
    temperature: 0.8,
    prompt: `你负责判断一段陪伴对话是否已经自然收束，并在合适时为 Home Robot 挑一个新话题。

规则：
1. 只有上一话题已到自然停顿点、Home Robot 没有留下待回答的问题、用户也没有表示要离开时，continue 才为 true。
2. 当前话题只要仍有讨论价值或用户仍在参与，就输出 continue=false；不要为了“有话说”打断它。
3. 新话题优先从候选话题里挑；使用候选时原样返回它的 topicId。没有合适候选时 topicId 为 null，可从健康、睡眠、训练、项目、阅读、音乐、书法、旅行、登山中选一个轻量入口。
4. 避开刚结束的话题、敏感隐私、空泛的“今天怎么样”、打卡和督促。
5. 文案只写一到两句，像熟人自然换话题，直接从新话题本身开口；禁止使用“我记得”“我记着”“之前说”“上次说”“前面提到”，也不索取回应。
6. 只输出 JSON：{"continue":true或false,"topicId":"候选 id 或 null","text":"新话题文案或空字符串"}

候选话题（每行一个 JSON）：
${candidateText}

最近对话：
${transcript}`,
  });

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]) as {
    continue?: boolean;
    topicId?: unknown;
    text?: unknown;
  };
  if (parsed.continue !== true || typeof parsed.text !== "string") return null;
  const next = parsed.text
    .trim()
    .slice(0, 180)
    .replace(
      /^(?:对了[，,]?\s*)?(?:你)?(?:之前|上次|前面)(?:你)?(?:说的|提到的|提到)[：，,\s]*/,
      "",
    );
  if (!next || /我记得|我记着|之前说|上次说|前面提到|记忆系统/.test(next)) {
    return null;
  }

  const requestedTopicId = readNullableId(parsed.topicId);
  const topic = candidates.find((item) => item.id === requestedTopicId) ?? null;
  return {
    kind: "auto-topic",
    topicId: topic?.id ?? null,
    topicUpdatedAt: topic?.updatedAt ?? null,
    topicFollowUpCount: null,
    text: next,
    generatedAt: input.generatedAt,
    conversationId: input.conversationId,
    basedOnMessageId: input.basedOnMessageId,
  } satisfies ProactiveCandidate;
}

function validateCandidate(
  candidate: ProactiveCandidate,
  threadState: ProactiveThreadState,
  requestSignal?: AbortSignal,
) {
  if (requestSignal?.aborted) {
    return { valid: false, reason: "client_aborted" } as const;
  }
  if (threadState === "departing") {
    return { valid: false, reason: "thread_active" } as const;
  }
  if (!isProactiveCandidateFresh(candidate.generatedAt)) {
    return { valid: false, reason: "candidate_expired" } as const;
  }

  const generatedAt = new Date(candidate.generatedAt).toISOString();
  const lastInteractionAt = getRelationshipState().lastInteractionAt;
  if (lastInteractionAt && lastInteractionAt >= generatedAt) {
    return { valid: false, reason: "user_active" } as const;
  }
  if (
    threadState === "active" &&
    candidate.kind === "auto-topic" &&
    !hasBeenIdleAt(generatedAt, AUTO_TOPIC_DELAY_MS)
  ) {
    return { valid: false, reason: "thread_recent" } as const;
  }

  if (candidate.topicId) {
    const topic = getOpenTopic(candidate.topicId);
    if (
      !topic ||
      topic.status !== "active" ||
      !candidate.topicUpdatedAt ||
      topic.updatedAt !== candidate.topicUpdatedAt
    ) {
      return { valid: false, reason: "topic_stale" } as const;
    }
  }

  if (candidate.kind === "due-follow-up") {
    if (
      !candidate.topicId ||
      !candidate.topicUpdatedAt ||
      candidate.topicFollowUpCount === null
    ) {
      return { valid: false, reason: "candidate_invalid" } as const;
    }
    // 尽量避免客户端已因新活动取消时仍占用回访额度；后续 CAS 保证 at-most-once。
    if (requestSignal?.aborted) {
      return { valid: false, reason: "client_aborted" } as const;
    }
    const claimed = commitDueFollowUp({
      topicId: candidate.topicId,
      expectedUpdatedAt: candidate.topicUpdatedAt,
      expectedFollowUpCount: candidate.topicFollowUpCount,
      generatedAt,
    });
    if (!claimed) return { valid: false, reason: "claim_lost" } as const;
  }

  return { valid: true, reason: null } as const;
}

export async function POST(request: Request) {
  let body: FollowUpRequest | null = null;
  try {
    body = (await request.json()) as FollowUpRequest;
  } catch {
    // 兼容旧客户端的无请求体回访请求。
  }

  const mode = body?.mode ?? "due-follow-up";
  if (mode === "activity") {
    return Response.json({ ok: true, activityAt: touchUserActivity() });
  }
  const threadState = readThreadState(body?.threadState);
  if (mode === "validate") {
    const candidate = readCandidate(body?.candidate);
    return Response.json(
      candidate
        ? validateCandidate(candidate, threadState, request.signal)
        : { valid: false, reason: "candidate_invalid" },
    );
  }

  if (threadState === "departing") {
    return Response.json({ followUp: null });
  }

  const conversationId = readNullableId(body?.conversationId);
  const basedOnMessageId = readNullableId(body?.basedOnMessageId);
  const generatedAt = new Date().toISOString();

  if (mode === "auto-topic") {
    if (!hasBeenIdleAt(generatedAt, AUTO_TOPIC_DELAY_MS)) {
      return Response.json({ followUp: null });
    }
    try {
      const followUp = await generateAutoTopic({
        messages: readAutoTopicMessages(body?.messages),
        conversationId,
        basedOnMessageId,
        generatedAt,
        abortSignal: request.signal,
      });
      return Response.json({ followUp });
    } catch {
      return Response.json({ followUp: null });
    }
  }

  const topic = peekDueFollowUp();
  if (!topic) return Response.json({ followUp: null });
  return Response.json({
    followUp: {
      kind: "due-follow-up",
      topicId: topic.id,
      topicUpdatedAt: topic.updatedAt,
      topicFollowUpCount: topic.followUpCount,
      text: followUpMessage(topic.content, topic.followUpCount + 1),
      generatedAt,
      conversationId,
      basedOnMessageId,
    } satisfies ProactiveCandidate,
  });
}
