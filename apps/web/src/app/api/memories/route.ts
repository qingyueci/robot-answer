import {
  createMemoryRecord,
  getMemoryGovernanceStats,
  listMemoryRecords,
  markMemoryConfirmed,
} from "@/lib/memory/local-store";
import { addConfirmedMemory } from "@/lib/memory/service";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryStatus,
} from "@/lib/memory/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status");
  const validStatus = ["candidate", "confirmed", "rejected"].includes(status ?? "")
    ? (status as MemoryStatus)
    : undefined;
  return Response.json({
    memories: listMemoryRecords(validStatus),
    governance: getMemoryGovernanceStats(),
  });
}

type ImportMemory = {
  content?: unknown;
  category?: unknown;
  confidence?: unknown;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs = 60_000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("写入向量记忆超时")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 导入用户直接确认的长期记忆。
 * infer=false，不调用对话模型；只写本地记录并生成本地向量。
 */
export async function POST(request: Request) {
  let body: { confirmed?: unknown; memories?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  if (body.confirmed !== true || !Array.isArray(body.memories)) {
    return Response.json(
      { error: "必须明确 confirmed=true，并提供 memories 数组" },
      { status: 400 },
    );
  }
  if (body.memories.length === 0 || body.memories.length > 20) {
    return Response.json(
      { error: "单次应导入 1 至 20 条记忆" },
      { status: 400 },
    );
  }

  const results: Array<Record<string, unknown>> = [];
  for (const [index, raw] of (body.memories as ImportMemory[]).entries()) {
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    const category =
      typeof raw.category === "string" &&
      MEMORY_CATEGORIES.includes(raw.category as MemoryCategory)
        ? (raw.category as MemoryCategory)
        : null;
    const confidence = Number(raw.confidence ?? 1);
    if (!content || content.length > 500 || !category) {
      results.push({
        index,
        ok: false,
        error: "内容须为 1 至 500 字，且 category 必须有效",
      });
      continue;
    }

    try {
      const { record, created } = createMemoryRecord({
        content,
        category,
        sensitive: false,
        confidence: Number.isFinite(confidence)
          ? Math.max(0, Math.min(1, confidence))
          : 1,
        sourceExcerpt: "用户直接提供并确认的长期记忆素材",
      });
      if (record.status === "confirmed") {
        results.push({
          index,
          ok: true,
          id: record.id,
          mem0Id: record.mem0Id,
          created: false,
          confirmedNow: false,
        });
        continue;
      }

      const mem0Id = await withTimeout(
        addConfirmedMemory(record.content, record.category, {
          sourceExcerpt: record.sourceExcerpt,
          confidence: record.confidence,
          sensitive: false,
          userConfirmed: true,
        }),
      );
      const confirmed = markMemoryConfirmed(record.id, mem0Id);
      results.push({
        index,
        ok: true,
        id: confirmed?.id,
        mem0Id,
        created,
        confirmedNow: true,
      });
    } catch (error) {
      results.push({
        index,
        ok: false,
        error: error instanceof Error ? error.message : "记忆导入失败",
      });
    }
  }

  const failed = results.filter((result) => result.ok !== true).length;
  return Response.json(
    {
      ok: failed === 0,
      imported: results.length - failed,
      failed,
      results,
      governance: getMemoryGovernanceStats(),
    },
    { status: failed === 0 ? 200 : 207 },
  );
}
