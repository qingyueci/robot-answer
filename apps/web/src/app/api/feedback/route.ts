import { NextResponse } from "next/server";
import {
  isMessageFeedbackKind,
  recordMessageFeedback,
} from "@/lib/chat/feedback";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      conversationId?: unknown;
      messageId?: unknown;
      kind?: unknown;
    };
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : null;
    const messageId =
      typeof body.messageId === "string" ? body.messageId.trim() : "";

    if (!messageId || !isMessageFeedbackKind(body.kind)) {
      return NextResponse.json(
        { error: "反馈内容不完整" },
        { status: 400 },
      );
    }

    const result = recordMessageFeedback({
      conversationId,
      messageId,
      kind: body.kind,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch {
    return NextResponse.json(
      { error: "反馈暂时没有保存成功" },
      { status: 500 },
    );
  }
}
