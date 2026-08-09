import {
  appendConversationSummary,
  getChatStateDb,
} from "@/lib/chat/state-db";
import { touchRelationship } from "@/lib/companion/store";
import {
  applyPostTurnExtraction,
  runPostTurnExtraction,
} from "@/lib/companion/post-turn";
import { isTrivialUserTurn } from "@/lib/governance/text";
import { runAutomaticGovernance } from "@/lib/governance/automatic";

export const runtime = "nodejs";

/**
 * 每轮对话结束后的统一后台处理（记忆 + 日记 + 话题 + 关系事件）。
 *
 * - 每轮最多一次模型调用；失败绝不影响聊天（除请求格式错误外都返回 200）。
 * - turnId（前端传 assistant 消息 id）幂等：重复请求直接返回上次结果摘要。
 */

type InputMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

type ProcessedTurnRow = {
  turn_id: string;
  processed_at: string;
  status: string;
  result_json: string;
};

let tableEnsured = false;

function ensureProcessedTurnsTable() {
  if (tableEnsured) return;
  getChatStateDb().exec(`
    create table if not exists processed_turns (
      turn_id text primary key,
      processed_at text not null,
      status text not null,
      result_json text not null default '{}'
    );
  `);
  tableEnsured = true;
}

function recordProcessedTurn(turnId: string, status: string, result: object) {
  try {
    ensureProcessedTurnsTable();
    getChatStateDb()
      .prepare(`
        insert or replace into processed_turns (turn_id, processed_at, status, result_json)
        values (?, ?, ?, ?)
      `)
      .run(turnId, new Date().toISOString(), status, JSON.stringify(result));
  } catch {
    // 调试记录失败不影响主流程。
  }
}

function markTurnProcessing(turnId: string) {
  ensureProcessedTurnsTable();
  return getChatStateDb()
    .prepare(`
      insert or ignore into processed_turns (
        turn_id, processed_at, status, result_json
      ) values (?, ?, 'processing', '{}')
    `)
    .run(turnId, new Date().toISOString()).changes > 0;
}

function validMessages(value: unknown): value is InputMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        ((item as InputMessage).role === "user" ||
          (item as InputMessage).role === "assistant") &&
        typeof (item as InputMessage).content === "string" &&
        ((item as InputMessage).id === undefined ||
          typeof (item as InputMessage).id === "string"),
    )
  );
}

export async function POST(request: Request) {
  let body: {
    conversationId?: unknown;
    turnId?: unknown;
    messages?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  if (body.conversationId !== null && typeof body.conversationId !== "string") {
    return Response.json(
      { error: "conversationId 必须是字符串或 null" },
      { status: 400 },
    );
  }
  if (typeof body.turnId !== "string" || !body.turnId.trim()) {
    return Response.json({ error: "turnId 不能为空" }, { status: 400 });
  }
  if (!validMessages(body.messages)) {
    return Response.json({ error: "messages 格式无效" }, { status: 400 });
  }

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : null;
  const turnId = body.turnId.trim();

  try {
    ensureProcessedTurnsTable();

    // 幂等：同一 turnId 直接返回上次结果摘要，不重复提取。
    const existing = getChatStateDb()
      .prepare("select * from processed_turns where turn_id = ?")
      .get(turnId) as ProcessedTurnRow | undefined;
    if (existing && existing.status !== "failed") {
      let summary: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(existing.result_json);
        if (parsed && typeof parsed === "object") {
          summary = parsed as Record<string, unknown>;
        }
      } catch {
        summary = {};
      }
      return Response.json({ ...summary, duplicate: true, status: existing.status });
    }
    if (existing?.status === "failed") {
      getChatStateDb()
        .prepare("delete from processed_turns where turn_id = ?")
        .run(turnId);
    }
    if (!markTurnProcessing(turnId)) {
      return Response.json({ ok: true, duplicate: true, status: "processing" });
    }

    const lines = body.messages
      .map((message) => ({ role: message.role, content: message.content.trim() }))
      .filter((message) => message.content)
      .slice(-8);

    if (lines.length === 0) {
      const skipped = {
        ok: true,
        status: "skipped",
        extracted: 0,
        confirmed: 0,
        candidates: 0,
        journalSaved: false,
      };
      recordProcessedTurn(turnId, "skipped", skipped);
      return Response.json(skipped);
    }

    // 每轮仍更新关系计数（lastMoment 由 store 层过滤无信息量内容）。
    const lastUserText =
      [...lines].reverse().find((line) => line.role === "user")?.content ?? "";
    try {
      touchRelationship({ sourceMessageId: turnId, lastMoment: lastUserText });
    } catch {
      // 关系计数失败不影响后台提取。
    }

    // 纯确认、寒暄、笑声等只更新互动时间，不消耗一次后台模型请求。
    if (isTrivialUserTurn(lastUserText)) {
      const skipped = {
        ok: true,
        status: "skipped",
        extracted: 0,
        confirmed: 0,
        candidates: 0,
        journalSaved: false,
      };
      recordProcessedTurn(turnId, "skipped", skipped);
      return Response.json(skipped);
    }

    const extraction = await runPostTurnExtraction(lines);
    if (!extraction) {
      // 模型不可用或失败：绝不自动生成日记兜底。
      const failed = { ok: false, status: "failed" };
      recordProcessedTurn(turnId, "failed", failed);
      return Response.json(failed);
    }

    const sourceExcerpt = lines
      .map((line) => `${line.role === "user" ? "用户" : "Home Robot"}：${line.content}`)
      .join("\n")
      .slice(0, 1200);

    const applied = await applyPostTurnExtraction({
      extraction,
      conversationId,
      turnId,
      sourceExcerpt,
      userText: lastUserText,
    });
    appendConversationSummary(
      conversationId,
      extraction.turnSummary,
      lines.length,
    );
    const governed = await runAutomaticGovernance("all");

    const completed = {
      ok: true,
      status: "completed",
      extracted: extraction.memories.length,
      confirmed: applied.confirmed,
      candidates: applied.candidates,
      journalSaved: applied.journalSaved,
      governed: governed.result,
    };
    recordProcessedTurn(turnId, "completed", completed);
    return Response.json(completed);
  } catch {
    // 后台处理失败不能影响聊天：记录状态并返回 200。
    const failed = { ok: false, status: "failed" };
    recordProcessedTurn(turnId, "failed", failed);
    return Response.json(failed);
  }
}
