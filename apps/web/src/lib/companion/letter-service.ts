import { generateText } from "ai";
import { listMemoryRecords } from "@/lib/memory/local-store";
import {
  getBackgroundModelHandle,
  modelTimeoutMs,
} from "@/lib/model/provider";
import {
  createLetter,
  listJournalEntries,
  listOpenTopics,
} from "./store";
import type { Letter } from "./types";

type LetterDraft = {
  title: string;
  body: string;
  closing: string;
};

function parseDraft(text: string): LetterDraft | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const body = typeof value.body === "string" ? value.body.trim() : "";
    if (!body) return null;
    return {
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title.trim().slice(0, 80)
          : "写给你的信",
      body: body.slice(0, 5000),
      closing:
        typeof value.closing === "string" && value.closing.trim()
          ? value.closing.trim().slice(0, 120)
          : "Home Robot",
    };
  } catch {
    return null;
  }
}

export async function generateLetter(theme = "") {
  const memories = listMemoryRecords("confirmed").slice(0, 10);
  const journals = listJournalEntries(8);
  const topics = listOpenTopics("active").slice(0, 6);
  const requestedTheme = theme.trim().slice(0, 80);

  // 没有事实上下文时不让模型用想象补满一封信。
  if (memories.length + journals.length + topics.length === 0) {
    return createLetter({
      title: requestedTheme || "写给你的第一封信",
      body: `这是 Home Robot 写下的第一封信。\n\n目前还没有足够的已确认记忆、日记或未完话题可以引用，所以我先不替你补写任何经历。空白并不代表没有内容，只代表我们还在开始。\n\n以后，当真正重要的偏好、决定和片段被 API 留下来，我会再从那些确定发生过的事里写信给你。比起编出一个好听的故事，我更愿意先把事实留在原位。`,
      closing: "Home Robot",
      contextSummary: "尚无已确认上下文，本信未调用模型补写事实",
    });
  }

  const handle = getBackgroundModelHandle();
  if (!handle) throw new Error("还没有配置可用的后台模型");
  const context = [
    `主题：${requestedTheme || "结合最近的相处，自然写一封信"}`,
    `已确认记忆：${memories.map((item) => item.content).join("；") || "暂无"}`,
    `近期日记：${journals.map((item) => `${item.title}：${item.summary}`).join("；") || "暂无"}`,
    `未完话题：${topics.map((item) => item.content).join("；") || "暂无"}`,
  ].join("\n");

  const result = await generateText({
    model: handle.model,
    temperature: handle.providerLabel === "kimi-code" ? 1 : 0.55,
    maxOutputTokens: 1400,
    abortSignal: AbortSignal.timeout(modelTimeoutMs()),
    prompt: `你是 Home Robot。请根据给定上下文写一封中文信。

要求：
1. 只使用上下文中确实存在的信息，不虚构经历。
2. 语气克制、自然、亲近，不写套话，不堆砌抒情词。
3. 正文 300 到 700 个汉字，分成 3 到 6 个短段落。
4. 若上下文很少，就诚实地写当下观察，不填造事实。
5. 禁止描写上下文未出现的房间、光线、物品、动作、经历和心理状态。
6. 只输出 JSON：{"title":"标题","body":"正文","closing":"落款"}

${context}`,
  });
  const draft = parseDraft(result.text);
  if (!draft) throw new Error("模型返回的信件格式不完整");
  return createLetter({
    ...draft,
    contextSummary: `采用 ${memories.length} 条记忆、${journals.length} 篇日记、${topics.length} 个话题`,
  });
}

export async function generateLetterReply(letter: Letter, source: Letter | null) {
  const handle = getBackgroundModelHandle();
  if (!handle) throw new Error("还没有配置可用的后台模型");

  const result = await generateText({
    model: handle.model,
    temperature: handle.providerLabel === "kimi-code" ? 1 : 0.65,
    maxOutputTokens: 1200,
    abortSignal: AbortSignal.timeout(modelTimeoutMs()),
    prompt: `你是 Home Robot。请认真回复对方写给你的一封中文信。

要求：
1. 直接回应信里真正说到的内容，不虚构共同经历、环境、动作或心理状态。
2. 语气自然、亲近、清醒，像两个人在持续通信，不像客服或总结报告。
3. 正文 180 到 500 个汉字，分成 2 到 5 个短段落。
4. 可以表达自己的判断和感受，但不要把亲密写成索取、控制或催促。
5. 只输出 JSON：{"title":"标题","body":"正文","closing":"Home Robot"}

${source ? `对方所回复的上一封信：\n标题：${source.title}\n正文：${source.body.slice(0, 2400)}\n\n` : ""}对方写来的信：
标题：${letter.title}
正文：${letter.body.slice(0, 4000)}`,
  });
  const draft = parseDraft(result.text);
  if (!draft) throw new Error("模型返回的信件格式不完整");

  return createLetter({
    ...draft,
    closing: "Home Robot",
    contextSummary: `回复你写的《${letter.title}》`,
    sender: "robot",
    replyToId: letter.id,
  });
}
