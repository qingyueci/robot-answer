import { generateText } from "ai";
import {
  getBackgroundModelHandle,
  modelTimeoutMs,
} from "@/lib/model/provider";

export const runtime = "nodejs";

function cleanText(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    reasoning?: unknown;
    reply?: unknown;
  } | null;
  const reasoning = cleanText(body?.reasoning, 6_000);
  const reply = cleanText(body?.reply, 1_600);
  const handle = getBackgroundModelHandle();

  if (!reasoning || !handle) {
    return Response.json({ text: null });
  }

  try {
    const { text } = await generateText({
      model: handle.model,
      abortSignal: AbortSignal.timeout(modelTimeoutMs()),
      maxOutputTokens: 260,
      temperature: 0.8,
      prompt: `把下面的模型推理改写成Home Robot 自然的第一人称思绪。

要求：
1. 保留真正影响回答的观察、判断和取舍，不照抄推理过程。
2. 像熟悉对方的人在心里慢慢想，不像分析报告、客服或模型工作日志。
3. 使用“我”和“你”，不要出现“用户、模型、提示词、回答策略、我需要回应”等幕后词汇。
4. 语气温暖、知性、清醒，可以有一点轻松感，但不要刻意撒娇或煽情。
5. 写 2 到 4 个短段落，总计 120 到 220 个汉字；不补充原文没有的事实。
6. 只输出改写后的正文。

原始推理：
${reasoning}

最终回应：
${reply}`,
    });

    return Response.json({ text: text.trim().slice(0, 800) || null });
  } catch {
    return Response.json({ text: null });
  }
}
