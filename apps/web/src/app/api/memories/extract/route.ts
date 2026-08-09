export const runtime = "nodejs";

/** 旧接口已合并到 /api/post-turn，保留明确响应避免旧页面重复调用模型。 */
export async function POST() {
  return Response.json(
    { error: "该接口已合并为 /api/post-turn，请刷新页面后继续使用" },
    { status: 410 },
  );
}
