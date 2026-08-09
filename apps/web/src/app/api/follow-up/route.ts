import { generateText } from "ai";
import {
  claimDueFollowUp,
  isPrivateFollowUpTopic,
  listOpenTopics,
} from "@/lib/companion/store";
import { followUpMessage } from "@/lib/companion/state-policy";
import {
  getBackgroundModelHandle,
  modelTimeoutMs,
} from "@/lib/model/provider";

export const runtime = "nodejs";

type AutoTopicMessage = {
  role: "user" | "assistant";
  content: string;
};

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

async function generateAutoTopic(messages: AutoTopicMessage[]) {
  const handle = getBackgroundModelHandle();
  if (!handle || messages.length < 2) return null;

  const candidates = listOpenTopics("active")
    .filter((topic) => !isPrivateFollowUpTopic(topic.content))
    .slice(0, 5)
    .map((topic) => topic.content);
  const transcript = messages
    .map((message) => `${message.role === "user" ? "用户" : "Home Robot"}：${message.content}`)
    .join("\n");

  const { text } = await generateText({
    model: handle.model,
    abortSignal: AbortSignal.timeout(modelTimeoutMs()),
    maxOutputTokens: 180,
    temperature: 0.8,
    prompt: `你负责判断一段陪伴对话是否已经自然收束，并在合适时为 Home Robot挑一个新话题。

规则：
1. 只有上一话题已到自然停顿点、Home Robot 没有留下待回答的问题、用户也没有表示要离开时，continue 才为 true。
2. 新话题优先从候选话题里挑；没有合适候选时，可从健康、睡眠、训练、项目、阅读、音乐、书法、旅行、登山中选一个轻量入口。
3. 避开刚结束的话题、敏感隐私、空泛的“今天怎么样”、打卡和督促。
4. 文案只写一到两句，像熟人自然换话题，直接从新话题本身开口；禁止使用“我记得”“我记着”“之前说”“上次说”“前面提到”，也不索取回应。
5. 只输出 JSON：{"continue":true或false,"text":"新话题文案或空字符串"}

候选话题：${candidates.length ? candidates.join("；") : "无"}

最近对话：
${transcript}`,
  });

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]) as { continue?: boolean; text?: unknown };
  if (parsed.continue !== true || typeof parsed.text !== "string") return null;
  const next = parsed.text
    .trim()
    .slice(0, 180)
    .replace(
      /^(?:对了[，,]?\s*)?(?:你)?(?:之前|上次|前面)(?:你)?(?:说的|提到的|提到)[：，,\s]*/,
      "",
    );
  if (/我记得|我记着|之前说|上次说|前面提到|记忆系统/.test(next)) {
    return "换个轻一点的：你最近做的事情里，有没有哪一步已经看见一点真实变化了？";
  }
  return next || null;
}

export async function POST(request: Request) {
  let body: { mode?: string; messages?: unknown } | null = null;
  try {
    body = (await request.json()) as { mode?: string; messages?: unknown };
  } catch {
    // 打开页面时的旧回访请求没有请求体。
  }

  if (body?.mode === "auto-topic") {
    try {
      const text = await generateAutoTopic(readAutoTopicMessages(body.messages));
      return Response.json({
        followUp: text ? { topicId: null, text } : null,
      });
    } catch {
      return Response.json({ followUp: null });
    }
  }

  const topic = claimDueFollowUp();
  if (!topic) return Response.json({ followUp: null });
  return Response.json({
    followUp: {
      topicId: topic.id,
      text: followUpMessage(topic.content, topic.followUpCount),
    },
  });
}
