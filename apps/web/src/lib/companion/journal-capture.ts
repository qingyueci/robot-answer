import { generateText } from "ai";
import { getConfiguredChatModel } from "@/lib/model/provider";

type ConversationLine = { role: "user" | "assistant"; content: string };

export type JournalCapture = {
  worthSaving: boolean;
  title: string;
  summary: string;
  mood: string;
  important: boolean;
};

function fallback(lines: ConversationLine[]): JournalCapture {
  void lines;
  return {
    worthSaving: false,
    title: "今天的对话片段",
    summary: "",
    mood: "",
    important: false,
  };
}

function parseCapture(text: string): JournalCapture | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const summary = typeof value.summary === "string" ? value.summary.trim() : "";
    if (!summary) return null;
    return {
      worthSaving: Boolean(value.worthSaving),
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title.trim().slice(0, 80)
          : "今天的对话片段",
      summary: summary.slice(0, 800),
      mood: typeof value.mood === "string" ? value.mood.trim().slice(0, 40) : "",
      important: Boolean(value.important),
    };
  } catch {
    return null;
  }
}

export async function captureJournal(lines: ConversationLine[]) {
  const cleaned = lines
    .map((line) => ({ ...line, content: line.content.trim() }))
    .filter((line) => line.content)
    .slice(-6);
  const fallbackResult = fallback(cleaned);
  const model = getConfiguredChatModel();
  if (!model || cleaned.length === 0) return fallbackResult;

  const transcript = cleaned
    .map((line) => `${line.role === "user" ? "观棋" : "Home Robot"}：${line.content}`)
    .join("\n");
  const timeout = Number(process.env.ROBOT_MODEL_TIMEOUT_MS || 45_000);

  try {
    const result = await generateText({
      model,
      abortSignal: AbortSignal.timeout(Number.isFinite(timeout) ? timeout : 45_000),
      prompt: `你是 Home Robot 的私人日记整理器。判断这段对话是否值得形成一条日记。
值得保存：有明确情绪、决定、计划、重要经历、关系时刻或需要以后接续的话题。
不保存：问候、单独的“ok/好/嗯”、纯工具操作确认、没有内容的寒暄。
只输出 JSON，不要 Markdown：
{"worthSaving":true,"title":"不超过16字","summary":"用第三人称写1到3句，准确记录发生了什么，不虚构","mood":"不超过8字，可为空","important":false}

对话：
${transcript}`,
    });
    return parseCapture(result.text) ?? fallbackResult;
  } catch {
    return fallbackResult;
  }
}
