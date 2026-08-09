import {
  createJournalEntry,
  getEmotionState,
  getCompanionGovernanceStats,
  getRelationshipState,
  listJournalEntries,
  listOpenTopics,
} from "@/lib/companion/store";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    relationship: getRelationshipState(),
    emotion: getEmotionState(),
    entries: listJournalEntries(),
    topics: listOpenTopics(),
    governance: getCompanionGovernanceStats(),
  });
}

export async function POST(request: Request) {
  let body: { title?: unknown; summary?: unknown; mood?: unknown; day?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  if (typeof body.summary !== "string" || !body.summary.trim()) {
    return Response.json({ error: "日记内容不能为空" }, { status: 400 });
  }
  const id = createJournalEntry({
    title: typeof body.title === "string" ? body.title : "手动记录",
    summary: body.summary,
    mood: typeof body.mood === "string" ? body.mood : "",
    day: typeof body.day === "string" ? body.day : undefined,
  });
  return Response.json({ id }, { status: 201 });
}
