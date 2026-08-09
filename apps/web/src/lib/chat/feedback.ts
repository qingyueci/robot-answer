import { randomUUID } from "node:crypto";
import { recordDirectives } from "./directives";
import { conversationKey, getChatStateDb } from "./state-db";

export type MessageFeedbackKind =
  | "stiff"
  | "too_long"
  | "too_many_questions"
  | "missed_the_point";

const FEEDBACK_DIRECTIVES: Record<MessageFeedbackKind, string> = {
  stiff: "用户反馈：近期回复显得生硬；后续用更自然的口语接话，少用模板句",
  too_long: "用户反馈：近期回复太长；后续先说重点，日常回复尽量控制在一到三句",
  too_many_questions: "用户反馈：近期追问太多；后续减少问句，优先顺着已有话题接话",
  missed_the_point: "用户反馈：近期回复没有接住重点；后续先回应用户刚才真正关心的那一点",
};

export function isMessageFeedbackKind(
  value: unknown,
): value is MessageFeedbackKind {
  return typeof value === "string" && value in FEEDBACK_DIRECTIVES;
}

/** 记录单条回复反馈，并把对应纠正写入当前会话的高优先级规则。 */
export function recordMessageFeedback(input: {
  conversationId: string | null;
  messageId: string;
  kind: MessageFeedbackKind;
}) {
  const db = getChatStateDb();
  const key = conversationKey(input.conversationId);
  const result = db
    .prepare(`
      insert or ignore into message_feedback (
        id, conversation_id, message_id, kind, created_at
      ) values (?, ?, ?, ?, ?)
    `)
    .run(
      randomUUID(),
      key,
      input.messageId,
      input.kind,
      new Date().toISOString(),
    );

  recordDirectives(
    input.conversationId,
    [FEEDBACK_DIRECTIVES[input.kind]],
    input.messageId,
  );

  return { created: result.changes > 0 };
}
