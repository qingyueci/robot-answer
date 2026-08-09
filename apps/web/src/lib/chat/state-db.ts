import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 聊天状态库：与 companion/store.ts 共用同一个 SQLite 文件
 * （WAL 模式下多连接没有问题），这里只建聊天相关的表。
 */

let database: DatabaseSync | undefined;

export function getChatStateDb(): DatabaseSync {
  if (database) return database;

  const filePath =
    process.env.ROBOT_STATE_DB_PATH?.trim() ||
    path.resolve(
      /*turbopackIgnore: true*/ process.cwd(),
      "../../data/state/robot-state.db",
    );
  mkdirSync(path.dirname(filePath), { recursive: true });
  database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(`
    create table if not exists conversation_directives (
      id text primary key,
      conversation_id text not null,
      directive text not null,
      source_message_id text,
      created_at text not null
    );

    create unique index if not exists conversation_directives_unique_idx
      on conversation_directives(conversation_id, directive);

    create index if not exists conversation_directives_conversation_idx
      on conversation_directives(conversation_id, created_at desc);

    create table if not exists conversation_summaries (
      conversation_id text primary key,
      summary text not null,
      message_count integer not null default 0,
      updated_at text not null
    );

    create table if not exists message_feedback (
      id text primary key,
      conversation_id text not null,
      message_id text not null,
      kind text not null,
      created_at text not null
    );

    create unique index if not exists message_feedback_unique_idx
      on message_feedback(conversation_id, message_id, kind);
  `);
  return database;
}

/** conversationId 为空时用 "local" 作为 key。 */
export function conversationKey(conversationId: string | null | undefined): string {
  const key = conversationId?.trim();
  return key ? key : "local";
}

/**
 * 把单轮摘要追加到会话滚动摘要。
 * 摘要由 post-turn 的同一次后台模型调用产生，不额外消耗一次模型请求。
 */
export function appendConversationSummary(
  conversationId: string | null,
  turnSummary: string,
  messageCount: number,
) {
  const summary = turnSummary.trim().replace(/\s+/g, " ");
  if (!summary) return;

  const db = getChatStateDb();
  const key = conversationKey(conversationId);
  const existing = db
    .prepare(
      "select summary, message_count from conversation_summaries where conversation_id = ?",
    )
    .get(key) as { summary: string; message_count: number } | undefined;
  const combined = existing?.summary
    ? `${existing.summary}\n${summary}`
    : summary;
  // 只保留最近约 1800 字，避免摘要本身无限增长。
  const compact = combined.slice(-1800);

  db.prepare(`
    insert into conversation_summaries (
      conversation_id, summary, message_count, updated_at
    ) values (?, ?, ?, ?)
    on conflict(conversation_id) do update set
      summary = excluded.summary,
      message_count = excluded.message_count,
      updated_at = excluded.updated_at
  `).run(
    key,
    compact,
    (existing?.message_count ?? 0) + Math.max(0, messageCount),
    new Date().toISOString(),
  );
}
