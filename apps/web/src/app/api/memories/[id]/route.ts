import {
  getMemoryRecord,
  markMemoryConfirmed,
  rejectMemoryRecord,
  softDeleteMemoryRecord,
  updateMemoryRecord,
} from "@/lib/memory/local-store";
import {
  addConfirmedMemory,
  deleteConfirmedMemory,
  updateConfirmedMemory,
} from "@/lib/memory/service";
import {
  deleteOpenTopicByMemoryId,
  updateOpenTopicContentByMemoryId,
  upsertOpenTopic,
} from "@/lib/companion/store";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const record = getMemoryRecord(id);
  if (!record) return Response.json({ error: "记忆不存在" }, { status: 404 });

  let body: { action?: unknown; content?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  if (body.action === "confirm") {
    if (record.status === "confirmed") return Response.json({ memory: record });
    const mem0Id = await addConfirmedMemory(record.content, record.category, {
      sourceConversationId: record.sourceConversationId,
      sourceExcerpt: record.sourceExcerpt,
      confidence: record.confidence,
      expiresAt: record.expiresAt,
      sensitive: record.sensitive,
      aboutThirdParty: record.aboutThirdParty,
      userConfirmed: true,
    });
    const confirmed = markMemoryConfirmed(id, mem0Id);
    if (confirmed?.category === "open_loop") {
      upsertOpenTopic({
        content: confirmed.content,
        sourceMemoryId: confirmed.id,
        sourceConversationId: confirmed.sourceConversationId,
      });
    }
    return Response.json({ memory: confirmed });
  }

  if (body.action === "reject") {
    return Response.json({ memory: rejectMemoryRecord(id) });
  }

  if (body.action === "update" && typeof body.content === "string") {
    const content = body.content.trim();
    if (!content) return Response.json({ error: "记忆内容不能为空" }, { status: 400 });
    if (record.mem0Id) await updateConfirmedMemory(record.mem0Id, content);
    try {
      const updated = updateMemoryRecord(id, content);
      if (!updated) return Response.json({ error: "记忆不存在" }, { status: 404 });
      if (updated.category === "open_loop") {
        updateOpenTopicContentByMemoryId(updated.id, updated.content);
      }
      return Response.json({ memory: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : "记忆更新失败";
      const status = message.includes("UNIQUE") ? 409 : 500;
      return Response.json({ error: status === 409 ? "已有相同记忆" : message }, { status });
    }
  }

  return Response.json({ error: "不支持的操作" }, { status: 400 });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const record = getMemoryRecord(id);
  if (!record) return Response.json({ error: "记忆不存在" }, { status: 404 });

  if (record.mem0Id) await deleteConfirmedMemory(record.mem0Id);
  if (record.category === "open_loop") deleteOpenTopicByMemoryId(record.id);
  softDeleteMemoryRecord(id);
  return Response.json({ deleted: true });
}
