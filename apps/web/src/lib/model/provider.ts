import { createOpenAI } from "@ai-sdk/openai";
import {
  extractReasoningMiddleware,
  generateText,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";

/**
 * 模型提供层。
 *
 * 配置优先级（从高到低）：
 * 1. ROBOT_CHAT_*      —— 通用对话模型（OpenAI 兼容接口），陪伴聊天的首选。
 * 2. KIMI_CODE_*       —— Kimi Code，仅作兼容回退，不再默认承担陪伴聊天。
 * 3. OPENAI_API_KEY/MODEL —— 最后回退。
 *
 * 任何密钥都只用于创建客户端，绝不写入返回值、日志或错误文本。
 */

export type ChatModelHandle = {
  /** 可直接传给 streamText / generateText 的模型句柄。 */
  model: LanguageModel;
  /** 用于调试的模型名（不含密钥）。 */
  modelName: string;
  /** 用于调试的提供方标签（不含密钥、不含完整 URL）。 */
  providerLabel: string;
  /** 当前请求是否启用了 DeepSeek 深度思考。 */
  thinkingEnabled: boolean;
};

export type ChatModelOptions = {
  task?: "chat" | "background";
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
};

export function modelTimeoutMs() {
  const timeout = Number(process.env.ROBOT_MODEL_TIMEOUT_MS ?? 45_000);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 45_000;
}

/** 给所有模型网络请求兜底一个超时，即使调用方没有传 abortSignal。 */
function fetchWithTimeout(
  transformBody?: (body: Record<string, unknown>) => Record<string, unknown>,
  transformResponse?: (response: Response) => Promise<Response>,
): typeof fetch {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(modelTimeoutMs());
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    let body = init?.body;
    if (transformBody && typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        body = JSON.stringify(transformBody(parsed));
      } catch {
        // 非 JSON 请求保持原样，交给上游处理。
      }
    }
    const response = await fetch(input, { ...init, body, signal });
    return transformResponse ? transformResponse(response) : response;
  };
}

/** 把 DeepSeek 的 reasoning_content 转成 AI SDK 可识别的 reasoning 流。 */
async function transformDeepSeekReasoningResponse(response: Response) {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream") && response.body) {
    let buffer = "";
    let reasoningOpen = false;
    let reasoningClosed = false;

    const transformLine = (line: string) => {
      if (!line.startsWith("data:") || line.trim() === "data: [DONE]") {
        return `${line}\n`;
      }
      try {
        const payload = JSON.parse(line.slice(5).trim()) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
            };
            finish_reason?: string | null;
          }>;
        };
        for (const choice of payload.choices ?? []) {
          const delta = choice.delta ?? (choice.delta = {});
          const reasoning = delta.reasoning_content;
          if (reasoning) {
            delta.content = `${reasoningOpen ? "" : "<think>"}${reasoning}`;
            reasoningOpen = true;
            delete delta.reasoning_content;
          } else if (
            reasoningOpen &&
            !reasoningClosed &&
            (delta.content || choice.finish_reason)
          ) {
            delta.content = `</think>${delta.content ?? ""}`;
            reasoningClosed = true;
          }
        }
        return `data: ${JSON.stringify(payload)}\n`;
      } catch {
        return `${line}\n`;
      }
    };

    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform(chunk, controller) {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) controller.enqueue(transformLine(line.replace(/\r$/, "")));
          },
          flush(controller) {
            if (buffer) controller.enqueue(transformLine(buffer.replace(/\r$/, "")));
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  if (contentType.includes("application/json")) {
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
        }>;
      };
      for (const choice of payload.choices ?? []) {
        const message = choice.message;
        if (message?.reasoning_content) {
          message.content = `<think>${message.reasoning_content}</think>${message.content ?? ""}`;
          delete message.reasoning_content;
        }
      }
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  }

  return response;
}

export function deepSeekRequestTransform(options: {
  thinking: boolean;
  reasoningEffort: "high" | "max";
}) {
  return (body: Record<string, unknown>) => {
    const { reasoning_effort: _ignored, ...rest } = body;
    return {
      ...rest,
      thinking: { type: options.thinking ? "enabled" : "disabled" },
      ...(options.thinking
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
    };
  };
}

function resolveChatModel(options: ChatModelOptions = {}): ChatModelHandle | null {
  // 1) 通用对话模型（最高优先级）。
  const robotApiKey = process.env.ROBOT_CHAT_API_KEY?.trim();
  const primaryModel = process.env.ROBOT_CHAT_MODEL?.trim();
  const backgroundModel = process.env.ROBOT_BACKGROUND_MODEL?.trim();
  const robotModel =
    options.task === "background" && backgroundModel
      ? backgroundModel
      : primaryModel;
  if (robotApiKey && robotModel) {
    const providerLabel =
      process.env.ROBOT_CHAT_PROVIDER?.trim() || "openai-compatible";
    const baseURL = process.env.ROBOT_CHAT_BASE_URL?.trim();
    const isDeepSeek =
      providerLabel.toLowerCase() === "deepseek" ||
      baseURL?.toLowerCase().includes("api.deepseek.com") === true;
    const thinkingEnabled =
      isDeepSeek && options.task !== "background" && options.thinking === true;
    const client = createOpenAI({
      name: providerLabel,
      apiKey: robotApiKey,
      ...(baseURL ? { baseURL } : {}),
      fetch: fetchWithTimeout(
        isDeepSeek
          ? deepSeekRequestTransform({
              thinking: thinkingEnabled,
              reasoningEffort: options.reasoningEffort ?? "high",
            })
          : undefined,
        isDeepSeek ? transformDeepSeekReasoningResponse : undefined,
      ),
    });
    const baseModel = client.chat(robotModel);
    // 通用对话模型按 OpenAI 兼容 Chat Completions 接入，与 Kimi Code 相同。
    return {
      model: isDeepSeek
        ? wrapLanguageModel({
            model: baseModel,
            middleware: extractReasoningMiddleware({ tagName: "think" }),
          })
        : baseModel,
      modelName: robotModel,
      providerLabel,
      thinkingEnabled,
    };
  }

  // 2) Kimi Code 仅作兼容回退。
  const kimiApiKey = process.env.KIMI_CODE_API_KEY?.trim();
  const kimiModel = process.env.KIMI_CODE_MODEL?.trim();
  if (kimiApiKey && kimiModel) {
    const kimi = createOpenAI({
      name: "kimi-code",
      apiKey: kimiApiKey,
      baseURL:
        process.env.KIMI_CODE_BASE_URL?.trim() ||
        "https://api.kimi.com/coding/v1",
      fetch: fetchWithTimeout(),
    });

    // Kimi Code 兼容 Chat Completions，不使用 AI SDK 默认的 Responses API。
    return {
      model: kimi.chat(kimiModel),
      modelName: kimiModel,
      providerLabel: "kimi-code",
      thinkingEnabled: false,
    };
  }

  // 3) OpenAI 最后回退。
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openaiModel = process.env.OPENAI_MODEL?.trim();
  if (openaiApiKey && openaiModel) {
    const client = createOpenAI({
      apiKey: openaiApiKey,
      fetch: fetchWithTimeout(),
    });
    return {
      model: client(openaiModel),
      modelName: openaiModel,
      providerLabel: "openai",
      thinkingEnabled: false,
    };
  }

  return null;
}

/** 新代码使用：返回模型句柄 + 调试信息（不含密钥）。 */
export function getChatModelHandle(
  options: ChatModelOptions = {},
): ChatModelHandle | null {
  return resolveChatModel(options);
}

/** 后台抽取、摘要和分类默认使用低成本模型，并关闭深度思考。 */
export function getBackgroundModelHandle(): ChatModelHandle | null {
  return resolveChatModel({ task: "background", thinking: false });
}

/**
 * 兼容旧代码（memory/extractor.ts、companion/journal-capture.ts 等）：
 * 保持原签名，直接返回模型句柄或 null。
 */
export function getConfiguredChatModel(): LanguageModel | null {
  return resolveChatModel({ task: "background", thinking: false })?.model ?? null;
}

function collectErrorText(error: unknown, depth = 0): string {
  if (error == null || depth > 4) return "";
  if (typeof error === "string") return error.toLowerCase();
  if (typeof error !== "object") return String(error).toLowerCase();

  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["name", "message"]) {
    const value = record[key];
    if (typeof value === "string") parts.push(value.toLowerCase());
  }
  const status = record.statusCode ?? record.status;
  if (typeof status === "number") parts.push(String(status));
  if ("cause" in record) parts.push(collectErrorText(record.cause, depth + 1));
  return parts.join(" ");
}

/**
 * 把模型调用错误映射为简洁中文提示。
 * 输出绝不含原始英文堆栈、URL 或任何密钥。
 */
export function toChineseModelError(error: unknown): string {
  const text = collectErrorText(error);

  if (/429|quota|insufficient|balance|rate.?limit|额度|限流/.test(text)) {
    return "模型额度不足或已被限流，请稍后重试";
  }
  if (/401|403|unauthorized|forbidden|invalid\s+api\s+key|incorrect\s+api\s+key|鉴权/.test(text)) {
    return "模型鉴权失败，请检查 API 密钥配置";
  }
  if (/timeout|timed\s*out|abort/.test(text)) {
    return "模型响应超时，请稍后重试";
  }
  if (/\b5\d\d\b|unavailable|fetch failed|econnrefused|econnreset|socket hang up/.test(text)) {
    return "模型服务暂时不可用";
  }
  return "模型请求失败，请稍后重试";
}

export type ModelHealth = {
  ok: boolean;
  modelName: string | null;
  reason: string | null;
};

const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;
let healthCache: { at: number; value: ModelHealth } | undefined;

/**
 * 轻量健康检查：一次 maxOutputTokens 极小的 generateText。
 * 结果在模块内缓存 5 分钟；聊天路径不要每次调用它。
 */
export async function checkModelHealth(force = false): Promise<ModelHealth> {
  if (!force && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_TTL_MS) {
    return healthCache.value;
  }

  const handle = getChatModelHandle();
  if (!handle) {
    const value: ModelHealth = {
      ok: false,
      modelName: null,
      reason: "未配置可用的对话模型",
    };
    healthCache = { at: Date.now(), value };
    return value;
  }

  try {
    await generateText({
      model: handle.model,
      maxOutputTokens: 1,
      prompt: "ping",
      abortSignal: AbortSignal.timeout(modelTimeoutMs()),
    });
    const value: ModelHealth = { ok: true, modelName: handle.modelName, reason: null };
    healthCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value: ModelHealth = {
      ok: false,
      modelName: handle.modelName,
      reason: toChineseModelError(error),
    };
    healthCache = { at: Date.now(), value };
    return value;
  }
}
