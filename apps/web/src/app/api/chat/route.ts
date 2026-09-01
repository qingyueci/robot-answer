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
import type { ConversationMode } from "@/lib/chat/mode";
import {
  bubbleLayoutInstruction,
  maxOutputTokens,
  shouldUseDeepThinkingForTurn,
} from "@/lib/chat/conversation-policy";
import { touchUserActivity } from "@/lib/companion/store";
import { buildExplicitGroundedMemoryReply } from "@/lib/memory/grounding";
import {
  conflictsWithCurrentFactCorrection,
  extractCurrentFactCorrection,
  looksContradictory,
} from "@/lib/governance/text";

export const runtime = "nodejs";

function readText(message: UIMessage | undefined) {
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
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

function staticTextStream(input: {
  messages: UIMessage[];
  mode: ConversationMode;
  text: string;
  debug?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
}) {
  const stream = createUIMessageStream({
    originalMessages: input.messages,
    execute({ writer }) {
      const id = crypto.randomUUID();
      if (input.messageMetadata) {
        writer.write({
          type: "message-metadata",
          messageMetadata: input.messageMetadata,
        });
      }
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: input.text });
      writer.write({ type: "text-end", id });
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: responseHeaders({ mode: input.mode, debug: input.debug }),
  });
}

function demoStream(messages: UIMessage[], mode: ConversationMode) {
  return staticTextStream({
    messages,
    mode,
    text: buildDemoResponse(readText(messages.at(-1))),
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
  if (!userText.trim() || messages.at(-1)?.role !== "user") {
    return Response.json(
      { error: "最后一条消息必须是非空的用户消息" },
      { status: 400 },
    );
  }

  // 用户消息一到达服务端就刷新活动时钟；不要等模型生成或 post-turn 完成。
  touchUserActivity();
  const recentUserTexts = messages
    .filter((message) => message.role === "user")
    .slice(-4, -1)
    .map(readText);

  const ctx = await buildChatContext({ conversationId, messages, userText });
  const mode = ctx.debug.mode;
  const currentCorrection = extractCurrentFactCorrection(userText);
  const groundedMemoryReply = buildExplicitGroundedMemoryReply(
    userText,
    ctx.groundingItems.filter(
      (item) =>
        !looksContradictory(item.content, userText) &&
        !conflictsWithCurrentFactCorrection(item.content, userText),
    ),
    currentCorrection,
  );
  if (groundedMemoryReply) {
    return staticTextStream({
      messages,
      mode,
      text: groundedMemoryReply,
      debug: {
        mode,
        grounding: "controlled-explicit-memory",
        memoryIds: ctx.debug.memoryIds,
        conversationMove: ctx.debug.conversationMove,
        threadState: ctx.debug.threadState,
      },
      messageMetadata: {
        bubbleLayout: "split",
        conversationMove: ctx.debug.conversationMove,
        threadState: ctx.debug.threadState,
      },
    });
  }
  const deepThinking = shouldUseDeepThinkingForTurn({
    mode,
    userText,
    recentUserTexts,
    threadState: ctx.debug.threadState,
    continuesPriorActiveThread: ctx.debug.continuesPriorActiveThread,
  });
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

  const bubbleInstruction = bubbleLayoutInstruction({
    thinkingEnabled: deepThinking,
    longFormRequested: ctx.debug.longFormRequested,
  });

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
    // 这是容量上限，不是目标长度；普通短聊仍由 Conversation Move 控制简洁度。
    maxOutputTokens: maxOutputTokens(handle.thinkingEnabled),
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    messageMetadata: ({ part }) =>
      part.type === "start"
        ? {
            bubbleLayout:
              deepThinking || ctx.debug.longFormRequested ? "single" : "split",
            conversationMove: ctx.debug.conversationMove,
            threadState: ctx.debug.threadState,
          }
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
        conversationMove: ctx.debug.conversationMove,
        threadState: ctx.debug.threadState,
        continuesPriorActiveThread: ctx.debug.continuesPriorActiveThread,
        maxOutputTokens: maxOutputTokens(handle.thinkingEnabled),
      },
    }),
    onError: (error) => toChineseModelError(error),
  });
}
