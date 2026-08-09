import { generateText } from "ai";
import { getConfiguredChatModel } from "@/lib/model/provider";
import { MEMORY_CATEGORIES, type ExtractedMemory } from "./types";

type ConversationLine = { role: "user" | "assistant"; content: string };

function parseJsonArray(text: string) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function extractMemories(lines: ConversationLine[]) {
  const model = getConfiguredChatModel();
  if (!model || lines.length === 0) return [];

  const transcript = lines
    .slice(-6)
    .map((line) => `${line.role === "user" ? "观棋" : "Home Robot"}：${line.content}`)
    .join("\n");
  const timeout = Number(process.env.ROBOT_MODEL_TIMEOUT_MS || 45_000);
  const result = await generateText({
    model,
    abortSignal: AbortSignal.timeout(Number.isFinite(timeout) ? timeout : 45_000),
    prompt: `你是长期记忆提取器。只根据观棋明确说出的内容提取未来有用的信息，不得把Home Robot 的话当作观棋的事实，也不得把一次情绪推断成固定人格。

分类：
- ordinary_preference：稳定偏好、表达习惯
- stable_fact：相对稳定的个人事实
- personality_inference：需要以后验证的性格推断
- sensitive：健康、亲密关系、身份、财务等敏感事实
- open_loop：承诺、待办、尚未结束的话题
- temporary_state：短期状态，最多保留 7 天

只输出 JSON 数组，不要 Markdown。每项格式：
{"content":"一条独立、简短、第三人称中文事实","category":"分类","sensitive":false,"confidence":0.0}

没有值得记忆的内容就输出 []。最多 5 条。

对话：
${transcript}`,
  });

  const allowed = new Set<string>(MEMORY_CATEGORIES);
  const output: ExtractedMemory[] = [];
  for (const item of parseJsonArray(result.text).slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const content = typeof value.content === "string" ? value.content.trim() : "";
    const category = typeof value.category === "string" ? value.category : "";
    const confidence = Number(value.confidence);
    if (!content || content.length > 240 || !allowed.has(category)) continue;

    output.push({
      content,
      category: category as ExtractedMemory["category"],
      sensitive: Boolean(value.sensitive) || category === "sensitive",
      confidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : 0.5,
    });
  }
  return output;
}
