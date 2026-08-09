import {
  currentGovernanceStats,
  runAutomaticGovernance,
  type GovernanceScope,
} from "@/lib/governance/automatic";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ stats: currentGovernanceStats() });
}

export async function POST(request: Request) {
  let body: { scope?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  const scope = typeof body.scope === "string" ? body.scope : "all";
  if (!["memory", "journal", "topics", "all"].includes(scope)) {
    return Response.json({ error: "治理范围无效" }, { status: 400 });
  }

  const governed = await runAutomaticGovernance(scope as GovernanceScope);
  return Response.json({ ok: true, ...governed });
}
