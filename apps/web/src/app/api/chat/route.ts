import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from "ai";
import { buildDemoResponse } from "@/lib/persona/demo-response";
import {
  getChatModelHandle,
  modelTimeoutMs,
  toChineseModelError,
} from "@/lib/model/provider";
import { buildChatContext } from "@/lib/chat/context-builder";
import { detectConversationMode, type ConversationMode } from "@/lib/chat/mode";

export const runtime = "nodejs";

function readText(message: UIMessage | undefined) {
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function shouldUseDeepThinking(
  mode: ConversationMode,
  userText: string,
  recentUserTexts: string[],
) {
  if (mode === "analysis") return true;

  const nuanced =
    /算了|没事|随便|都行|无所谓|你决定|其实|但是|可是|反话|隐喻|纠结|委屈|失望|在意|关系|误会|为什么|怎么办/;
  if (mode === "advice") return userText.length >= 16 || nuanced.test(userText);
  if (mode === "emotional") {
    return nuanced.test(userText) || recentUserTexts.some((text) => nuanced.test(text));
  }
  if (mode === "factual") return userText.length >= 100;
  return false;
}

function responseHeaders(input: {
  mode: ConversationMode;
  debug?: Record<string, unknown>;
}) {
  const headers = new Headers();
  headers.set("x-robot-mode", input.mode);
  if (input.debug && process.env.NODE_ENV === "development") {
    // 只含模型名/标签/模式/id/计数，绝不含密钥或记忆全文。
    headers.set("x-robot-debug", encodeURIComponent(JSON.stringify(input.debug)));
  }
  return headers;
}

function demoStream(messages: UIMessage[], mode: ConversationMode) {
  const text = buildDemoResponse(readText(messages.at(-1)));
  const stream = createUIMessageStream({
    originalMessages: messages,
    execute({ writer }) {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: responseHeaders({ mode }),
  });
}

export async function POST(request: Request) {
  let body: { messages?: UIMessage[]; conversationId?: string };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return Response.json({ error: "缺少 messages 数组" }, { status: 400 });
  }

  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.trim()
      ? body.conversationId.trim()
      : null;
  const userText = readText(messages.at(-1));
  const recentUserTexts = messages
    .filter((message) => message.role === "user")
    .slice(-4, -1)
    .map(readText);

  const mode = detectConversationMode(userText, recentUserTexts);
  const deepThinking = shouldUseDeepThinking(mode, userText, recentUserTexts);
  const handle = getChatModelHandle({
    thinking: deepThinking,
    reasoningEffort: "high",
  });
  if (!handle) {
    return demoStream(messages, mode);
  }

  const abortSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(modelTimeoutMs()),
  ]);

  const ctx = await buildChatContext({ conversationId, messages, userText });
  const bubbleInstruction = deepThinking
    ? "本轮是深度话题：把完整回应放在一个连续聊天气泡里，正文不要使用换行分段；需要停顿时用句号或分号。"
    : "本轮按真人聊天节奏输出：每说完一个自然短句组就换一行，每一行会成为独立聊天气泡；通常 1 到 4 行，每行 1 到 2 句，不要使用空行。内容很短时不强行拆分。";

  const result = streamText({
    model: handle.model,
    system: `${ctx.system}\n\n${bubbleInstruction}`,
    messages: await convertToModelMessages(ctx.messages),
    abortSignal,
    // DeepSeek 思考模式会忽略 temperature，因此不再发送；其他模型保留原设置。
    temperature: handle.thinkingEnabled
      ? undefined
      : handle.providerLabel === "kimi-code"
        ? 1
        : 0.8,
    maxOutputTokens: handle.thinkingEnabled ? 3200 : 600,
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    messageMetadata: ({ part }) =>
      part.type === "start"
        ? { bubbleLayout: deepThinking ? "single" : "split" }
        : undefined,
    headers: responseHeaders({
      mode: ctx.debug.mode,
      debug: {
        model: handle.modelName,
        provider: handle.providerLabel,
        mode: ctx.debug.mode,
        thinking: handle.thinkingEnabled,
        memoryIds: ctx.debug.memoryIds,
        contextTokens: ctx.debug.contextTokens,
        usedSummary: ctx.debug.usedSummary,
        directives: ctx.debug.directives,
        emotion: ctx.debug.emotion,
        recallRoutes: ctx.debug.recallRoutes,
      },
    }),
    onError: (error) => toChineseModelError(error),
  });
}
