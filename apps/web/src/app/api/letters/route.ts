import {
  generateLetter,
  generateLetterReply,
} from "@/lib/companion/letter-service";
import {
  createLetter,
  getLetter,
  listLetters,
} from "@/lib/companion/store";
import { toChineseModelError } from "@/lib/model/provider";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ letters: listLetters(60) });
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    action?: unknown;
    theme?: unknown;
    title?: unknown;
    body?: unknown;
    replyToId?: unknown;
  } | null;
  if (!payload) {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  if (payload.action === "send") {
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    const replyToId =
      typeof payload.replyToId === "string" && payload.replyToId.trim()
        ? payload.replyToId.trim()
        : null;
    const source = replyToId ? getLetter(replyToId) : null;
    if (!body) {
      return Response.json({ error: "信件正文不能为空" }, { status: 400 });
    }
    if (replyToId && !source) {
      return Response.json({ error: "原信件不存在" }, { status: 404 });
    }

    const title =
      typeof payload.title === "string" && payload.title.trim()
        ? payload.title.trim().slice(0, 80)
        : source
          ? `回信：${source.title}`.slice(0, 80)
          : "写给 Home Robot 的信";
    const userLetter = createLetter({
      title,
      body,
      closing: "你",
      contextSummary: source
        ? `回复Home Robot 的《${source.title}》`
        : "你自由写下的信",
      sender: "user",
      replyToId,
    });

    try {
      const reply = await generateLetterReply(userLetter, source);
      return Response.json({ letters: [reply, userLetter] }, { status: 201 });
    } catch (error) {
      return Response.json(
        {
          letters: [userLetter],
          warning: `信已保存；Home Robot 的回信稍后再试：${toChineseModelError(error)}`,
        },
        { status: 201 },
      );
    }
  }

  if (payload.theme !== undefined && typeof payload.theme !== "string") {
    return Response.json({ error: "主题必须是文字" }, { status: 400 });
  }
  const theme =
    typeof payload.theme === "string" ? payload.theme.trim().slice(0, 80) : "";

  try {
    const letter = await generateLetter(theme);
    return Response.json({ letter }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: toChineseModelError(error) },
      { status: 503 },
    );
  }
}
