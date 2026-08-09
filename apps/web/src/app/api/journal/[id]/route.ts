import { deleteJournalEntry } from "@/lib/companion/store";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!deleteJournalEntry(id)) {
    return Response.json({ error: "日记不存在" }, { status: 404 });
  }
  return Response.json({ deleted: true });
}
