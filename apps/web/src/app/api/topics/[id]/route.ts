import { updateOpenTopicStatus } from "@/lib/companion/store";
import {
  getMemoryRecord,
  rejectMemoryRecord,
} from "@/lib/memory/local-store";
import { deleteConfirmedMemory } from "@/lib/memory/service";
import type { TopicStatus } from "@/lib/companion/types";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  let body: { status?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  const allowed = new Set<TopicStatus>(["active", "completed", "dismissed"]);
  if (typeof body.status !== "string" || !allowed.has(body.status as TopicStatus)) {
    return Response.json({ error: "话题状态无效" }, { status: 400 });
  }
  const topic = updateOpenTopicStatus(id, body.status as TopicStatus);
  if (!topic) return Response.json({ error: "话题不存在" }, { status: 404 });

  if (
    topic.sourceMemoryId &&
    (body.status === "completed" || body.status === "dismissed")
  ) {
    const memory = getMemoryRecord(topic.sourceMemoryId);
    if (memory?.mem0Id) {
      try {
        await deleteConfirmedMemory(memory.mem0Id);
      } catch {
        // 本地先停用，向量服务恢复后可由后续治理清理。
      }
    }
    rejectMemoryRecord(
      topic.sourceMemoryId,
      body.status === "completed"
        ? "对应的未完成话题已经结束"
        : "对应的未完成话题已不再跟进",
    );
  }
  return Response.json({ topic });
}
