import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  compactJournalText,
  detectJournalTheme,
  mergeDistinctText,
  textSimilarity,
} from "@/lib/governance/text";
import { emotionExpiresAt, isFollowUpQuietHours } from "./state-policy";
import type {
  EmotionState,
  JournalEntry,
  Letter,
  OpenTopic,
  RelationshipState,
  TopicStatus,
} from "./types";

type RelationshipRow = {
  total_user_turns: number;
  last_interaction_at: string | null;
  last_moment: string;
  updated_at: string;
};

type JournalRow = {
  id: string;
  source_message_id: string | null;
  day: string;
  title: string;
  summary: string;
  mood: string;
  important: number;
  source_conversation_id: string | null;
  governance_reason: string;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
};

type TopicRow = {
  id: string;
  content: string;
  status: TopicStatus;
  source_memory_id: string | null;
  source_conversation_id: string | null;
  follow_up_count: number;
  last_follow_up_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type EmotionRow = {
  mood: string;
  expires_at: string;
  source_message_id: string | null;
  updated_at: string;
};

type LetterRow = {
  id: string;
  title: string;
  body: string;
  closing: string;
  context_summary: string;
  sender: "robot" | "user";
  reply_to_id: string | null;
  created_at: string;
};

let database: DatabaseSync | undefined;

function getDatabase() {
  if (database) return database;

  const filePath =
    process.env.ROBOT_STATE_DB_PATH?.trim() ||
    path.resolve(
      /*turbopackIgnore: true*/ process.cwd(),
      "../../data/state/robot-state.db",
    );
  mkdirSync(path.dirname(filePath), { recursive: true });
  database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  database.exec(`
    create table if not exists relationship_state (
      id integer primary key check (id = 1),
      total_user_turns integer not null default 0,
      last_interaction_at text,
      last_moment text not null default '',
      updated_at text not null
    );

    create table if not exists relationship_events (
      id text primary key,
      source_message_id text not null unique,
      kind text not null default 'note',
      description text not null default '',
      created_at text not null
    );

    create table if not exists journal_entries (
      id text primary key,
      source_message_id text unique,
      day text not null,
      title text not null,
      summary text not null,
      mood text not null default '',
      important integer not null default 0,
      source_conversation_id text,
      governance_reason text not null default '',
      merged_into_id text,
      created_at text not null,
      updated_at text not null,
      deleted_at text
    );

    create index if not exists journal_entries_day_idx
      on journal_entries(day desc, created_at desc);

    create table if not exists journal_entry_sources (
      source_message_id text primary key,
      journal_id text not null,
      created_at text not null
    );

    create table if not exists open_topics (
      id text primary key,
      fingerprint text not null unique,
      content text not null,
      status text not null default 'active',
      source_memory_id text unique,
      source_conversation_id text,
      follow_up_count integer not null default 0,
      last_follow_up_at text,
      created_at text not null,
      updated_at text not null,
      completed_at text
    );

    create index if not exists open_topics_status_idx
      on open_topics(status, updated_at desc);

    create table if not exists emotion_state (
      id integer primary key check (id = 1),
      mood text not null,
      expires_at text not null,
      source_message_id text,
      updated_at text not null
    );

    create table if not exists letters (
      id text primary key,
      title text not null,
      body text not null,
      closing text not null default '',
      context_summary text not null default '',
      sender text not null default 'robot',
      reply_to_id text,
      created_at text not null
    );

    create index if not exists letters_created_at_idx
      on letters(created_at desc);
  `);

  // 兼容迁移：旧库 relationship_events 缺少 kind / description 列时补充
  // （SQLite 不支持 ADD COLUMN IF NOT EXISTS，先查 PRAGMA）。
  const eventColumns = database
    .prepare("PRAGMA table_info(relationship_events)")
    .all() as unknown as { name: string }[];
  if (!eventColumns.some((column) => column.name === "kind")) {
    database.exec(
      "alter table relationship_events add column kind text not null default 'note'",
    );
  }
  if (!eventColumns.some((column) => column.name === "description")) {
    database.exec(
      "alter table relationship_events add column description text not null default ''",
    );
  }

  const journalColumns = database
    .prepare("PRAGMA table_info(journal_entries)")
    .all() as unknown as { name: string }[];
  if (!journalColumns.some((column) => column.name === "governance_reason")) {
    database.exec(
      "alter table journal_entries add column governance_reason text not null default ''",
    );
  }
  if (!journalColumns.some((column) => column.name === "merged_into_id")) {
    database.exec("alter table journal_entries add column merged_into_id text");
  }
  const topicColumns = database
    .prepare("PRAGMA table_info(open_topics)")
    .all() as unknown as { name: string }[];
  if (!topicColumns.some((column) => column.name === "follow_up_count")) {
    database.exec(
      "alter table open_topics add column follow_up_count integer not null default 0",
    );
  }
  if (!topicColumns.some((column) => column.name === "last_follow_up_at")) {
    database.exec("alter table open_topics add column last_follow_up_at text");
  }
  const letterColumns = database
    .prepare("PRAGMA table_info(letters)")
    .all() as unknown as { name: string }[];
  if (!letterColumns.some((column) => column.name === "sender")) {
    database.exec(
      "alter table letters add column sender text not null default 'robot'",
    );
  }
  if (!letterColumns.some((column) => column.name === "reply_to_id")) {
    database.exec("alter table letters add column reply_to_id text");
  }
  database.exec(`
    insert or ignore into journal_entry_sources (
      source_message_id, journal_id, created_at
    )
    select source_message_id, id, created_at
    from journal_entries
    where source_message_id is not null
  `);

  const now = new Date().toISOString();
  database
    .prepare(`
      insert or ignore into relationship_state (
        id, total_user_turns, last_interaction_at, last_moment, updated_at
      ) values (1, 0, null, '', ?)
    `)
    .run(now);

  return database;
}

function familiarityText(turns: number, meaningfulEvents: number) {
  if (turns < 20 || meaningfulEvents < 2) return "认识不久，还在互相了解";
  if (meaningfulEvents < 8) return "彼此的表达习惯正在变得清楚";
  return "已经形成比较自然的相处节奏";
}

function rowToRelationship(
  row: RelationshipRow,
  meaningfulEvents: number,
): RelationshipState {
  return {
    stage: "established_partner",
    stageLabel: "自然熟悉",
    familiarityText: familiarityText(row.total_user_turns, meaningfulEvents),
    totalUserTurns: row.total_user_turns,
    lastInteractionAt: row.last_interaction_at,
    lastMoment: row.last_moment,
    updatedAt: row.updated_at,
  };
}

function rowToJournal(row: JournalRow): JournalEntry {
  return {
    id: row.id,
    day: row.day,
    title: row.title,
    summary: row.summary,
    mood: row.mood,
    important: Boolean(row.important),
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTopic(row: TopicRow): OpenTopic {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    followUpCount: Number(row.follow_up_count) || 0,
    lastFollowUpAt: row.last_follow_up_at,
    sourceMemoryId: row.source_memory_id,
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToLetter(row: LetterRow): Letter {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    closing: row.closing,
    contextSummary: row.context_summary,
    sender: row.sender === "user" ? "user" : "robot",
    replyToId: row.reply_to_id,
    createdAt: row.created_at,
  };
}

export function createLetter(input: {
  title: string;
  body: string;
  closing?: string;
  contextSummary?: string;
  sender?: "robot" | "user";
  replyToId?: string | null;
}) {
  const title = input.title.trim().slice(0, 80) || "写给你的信";
  const body = input.body.trim().slice(0, 5000);
  if (!body) throw new Error("信件正文不能为空");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  getDatabase()
    .prepare(`
      insert into letters (
        id, title, body, closing, context_summary, sender, reply_to_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      title,
      body,
      input.closing?.trim().slice(0, 120) ?? "Home Robot",
      input.contextSummary?.trim().slice(0, 600) ?? "",
      input.sender ?? "robot",
      input.replyToId ?? null,
      createdAt,
    );
  return {
    id,
    title,
    body,
    closing: input.closing?.trim().slice(0, 120) ?? "Home Robot",
    contextSummary: input.contextSummary?.trim().slice(0, 600) ?? "",
    sender: input.sender ?? "robot",
    replyToId: input.replyToId ?? null,
    createdAt,
  } satisfies Letter;
}

export function getLetter(id: string) {
  const row = getDatabase()
    .prepare("select * from letters where id = ?")
    .get(id) as LetterRow | undefined;
  return row ? rowToLetter(row) : null;
}

export function listLetters(limit = 30) {
  const rows = getDatabase()
    .prepare("select * from letters order by created_at desc limit ?")
    .all(Math.max(1, Math.min(limit, 100))) as unknown as LetterRow[];
  return rows.map(rowToLetter);
}

export function getEmotionState(now = new Date()): EmotionState | null {
  const row = getDatabase()
    .prepare("select * from emotion_state where id = 1")
    .get() as EmotionRow | undefined;
  if (!row || row.expires_at <= now.toISOString()) return null;
  return {
    mood: row.mood,
    expiresAt: row.expires_at,
    sourceMessageId: row.source_message_id,
    updatedAt: row.updated_at,
  };
}

export function setEmotionState(input: {
  mood: string;
  sourceMessageId?: string | null;
  now?: Date;
}) {
  const mood = input.mood.trim().slice(0, 20);
  if (!mood) return null;
  const now = input.now ?? new Date();
  const updatedAt = now.toISOString();
  const expiresAt = emotionExpiresAt(now);
  getDatabase()
    .prepare(`
      insert into emotion_state (
        id, mood, expires_at, source_message_id, updated_at
      ) values (1, ?, ?, ?, ?)
      on conflict(id) do update set
        mood = excluded.mood,
        expires_at = excluded.expires_at,
        source_message_id = excluded.source_message_id,
        updated_at = excluded.updated_at
    `)
    .run(mood, expiresAt, input.sourceMessageId ?? null, updatedAt);
  return getEmotionState(now);
}

export function getRelationshipState() {
  const db = getDatabase();
  const row = db
    .prepare("select * from relationship_state where id = 1")
    .get() as RelationshipRow;
  const eventCount = db
    .prepare(`
      select count(*) as count from relationship_events
      where kind in (
        'meaningful_moment',
        'correction_adopted',
        'topic_revisited',
        'boundary_respected'
      )
    `)
    .get() as { count: number };
  return rowToRelationship(row, Number(eventCount.count) || 0);
}

/**
 * 「没有信息量」的应答：ok/yes/好/嗯/哈哈 等（含标点变体，忽略大小写），
 * 或长度不足 6 的短句。这类内容不得更新 lastMoment，也不得成为关系事件。
 */
const MEANINGLESS_MOMENT_PATTERN =
  /^(ok+|yes|no|好(的)?|嗯+|哈+|可以|知道了|行(吧)?|在吗|在)[\s。.!！,，、~～?？…]*$/i;

export function isMeaninglessMomentText(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 6) return true;
  return MEANINGLESS_MOMENT_PATTERN.test(trimmed);
}

export function touchRelationship(input: {
  sourceMessageId: string;
  lastMoment: string;
}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const inserted = db
    .prepare(`
      insert or ignore into relationship_events (id, source_message_id, kind, description, created_at)
      values (?, ?, 'turn', '', ?)
    `)
    .run(randomUUID(), input.sourceMessageId, now);

  if (inserted.changes > 0) {
    const moment = input.lastMoment.trim().slice(0, 240);
    if (isMeaninglessMomentText(moment)) {
      // 无信息量内容只更新计数与最近互动时间，不覆盖 lastMoment。
      db.prepare(`
        update relationship_state
        set total_user_turns = total_user_turns + 1,
            last_interaction_at = ?, updated_at = ?
        where id = 1
      `).run(now, now);
    } else {
      db.prepare(`
        update relationship_state
        set total_user_turns = total_user_turns + 1,
            last_interaction_at = ?, last_moment = ?, updated_at = ?
        where id = 1
      `).run(now, moment, now);
    }
  }
  return getRelationshipState();
}

const MEANINGFUL_EVENT_KINDS = new Set([
  "meaningful_moment",
  "correction_adopted",
  "topic_revisited",
  "boundary_respected",
]);

/**
 * 记录一条可解释的关系事件（纠正被采纳、话题回访、边界被尊重、有信息量的时刻）。
 * source_message_id 有唯一约束，重复上报是幂等的。
 * 有意义的事件会把 description（截断 240）写入 lastMoment；计数仍由 touchRelationship 负责。
 */
export function recordRelationshipEvent(input: {
  kind: string;
  description: string;
  sourceMessageId?: string | null;
}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const kind = input.kind.trim() || "note";
  const description = input.description.trim().slice(0, 240);
  if (!description) return false;

  const inserted = db
    .prepare(`
      insert or ignore into relationship_events (id, source_message_id, kind, description, created_at)
      values (?, ?, ?, ?, ?)
    `)
    .run(
      randomUUID(),
      input.sourceMessageId?.trim() || `generated:${randomUUID()}`,
      kind,
      description,
      now,
    );

  if (
    inserted.changes > 0 &&
    MEANINGFUL_EVENT_KINDS.has(kind) &&
    !isMeaninglessMomentText(description)
  ) {
    db.prepare(`
      update relationship_state set last_moment = ?, updated_at = ? where id = 1
    `).run(description, now);
  }
  return inserted.changes > 0;
}

export function createJournalEntry(input: {
  title: string;
  summary: string;
  mood?: string;
  important?: boolean;
  sourceMessageId?: string | null;
  sourceConversationId?: string | null;
  day?: string;
}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();
  const title = input.title.trim().slice(0, 80) || "今天的片段";
  const summary = input.summary.trim().slice(0, 800);
  if (!summary) throw new Error("日记内容不能为空");
  const day = input.day?.trim() || now.slice(0, 10);

  const result = db.prepare(`
    insert or ignore into journal_entries (
      id, source_message_id, day, title, summary, mood, important,
      source_conversation_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.sourceMessageId ?? null,
    day,
    title,
    summary,
    input.mood?.trim().slice(0, 40) ?? "",
    input.important ? 1 : 0,
    input.sourceConversationId ?? null,
    now,
    now,
  );

  if (result.changes > 0) return id;
  if (!input.sourceMessageId) return null;
  const existing = db
    .prepare("select id from journal_entries where source_message_id = ?")
    .get(input.sourceMessageId) as { id: string } | undefined;
  return existing?.id ?? null;
}

function journalBySource(db: DatabaseSync, sourceMessageId: string) {
  return db
    .prepare(`
      select journal_id from journal_entry_sources
      where source_message_id = ?
    `)
    .get(sourceMessageId) as { journal_id: string } | undefined;
}

function recordJournalSource(
  db: DatabaseSync,
  sourceMessageId: string | null | undefined,
  journalId: string,
  now: string,
) {
  if (!sourceMessageId) return;
  db.prepare(`
    insert or ignore into journal_entry_sources (
      source_message_id, journal_id, created_at
    ) values (?, ?, ?)
  `).run(sourceMessageId, journalId, now);
}

function journalEntriesMatch(
  left: Pick<JournalRow, "title" | "summary" | "important">,
  right: { title: string; summary: string; important: boolean | number },
) {
  if (
    textSimilarity(left.summary, right.summary) >= 0.58 ||
    textSimilarity(left.title, right.title) >= 0.5
  ) {
    return true;
  }
  const leftTheme = detectJournalTheme(left.title, left.summary);
  const rightTheme = detectJournalTheme(right.title, right.summary);
  return (
    Boolean(leftTheme) &&
    leftTheme === rightTheme &&
    !(Boolean(left.important) && Boolean(right.important))
  );
}

/**
 * 同日合并写日记：
 * - sourceMessageId 已存在 → 直接返回已有条目 id（幂等）。
 * - important=false 且当天已有未删除的自动条目 → 把新 summary 用「；」合并进
 *   已有条目（总长截断 800，title 保留原条目，mood 取新的非空值），返回已有 id。
 * - important=true 或当天无自动条目 → 新建。
 */
export function upsertJournalEntryForDay(input: {
  title: string;
  summary: string;
  mood?: string;
  important?: boolean;
  sourceMessageId?: string | null;
  sourceConversationId?: string | null;
  day?: string;
}): string | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const day = input.day?.trim() || now.slice(0, 10);
  const summary = input.summary.trim().slice(0, 800);
  if (!summary) throw new Error("日记内容不能为空");
  const important = Boolean(input.important);

  if (input.sourceMessageId) {
    const existingBySource = journalBySource(db, input.sourceMessageId);
    if (existingBySource) return existingBySource.journal_id;
  }

  const sameDay = db
    .prepare(`
      select * from journal_entries
      where day = ? and deleted_at is null
      order by important desc, created_at asc
      limit 30
    `)
    .all(day) as unknown as JournalRow[];
  const similar = sameDay.find(
    (entry) =>
      journalEntriesMatch(entry, {
        title: input.title,
        summary,
        important,
      }),
  );
  if (similar) {
    const mergedSummary = mergeDistinctText(similar.summary, summary);
    const mood = input.mood?.trim()
      ? input.mood.trim().slice(0, 40)
      : similar.mood;
    db.prepare(`
      update journal_entries
      set summary = ?, mood = ?, important = ?, updated_at = ?
      where id = ?
    `).run(
      mergedSummary,
      mood,
      similar.important || important ? 1 : 0,
      now,
      similar.id,
    );
    recordJournalSource(db, input.sourceMessageId, similar.id, now);
    return similar.id;
  }

  if (!important) {
    const existing = sameDay.find((entry) => entry.source_message_id !== null);
    if (existing) {
      const mergedSummary = mergeDistinctText(existing.summary, summary);
      const mood = input.mood?.trim()
        ? input.mood.trim().slice(0, 40)
        : existing.mood;
      db.prepare(`
        update journal_entries set summary = ?, mood = ?, updated_at = ?
        where id = ?
      `).run(mergedSummary, mood, now, existing.id);
      recordJournalSource(db, input.sourceMessageId, existing.id, now);
      return existing.id;
    }
  }

  const id = randomUUID();
  const title = input.title.trim().slice(0, 80) || "今天的片段";
  const result = db
    .prepare(`
      insert or ignore into journal_entries (
        id, source_message_id, day, title, summary, mood, important,
        source_conversation_id, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      input.sourceMessageId ?? null,
      day,
      title,
      summary,
      input.mood?.trim().slice(0, 40) ?? "",
      important ? 1 : 0,
      input.sourceConversationId ?? null,
      now,
      now,
    );
  if (result.changes > 0) {
    recordJournalSource(db, input.sourceMessageId, id, now);
    return id;
  }
  if (!input.sourceMessageId) return null;
  return journalBySource(db, input.sourceMessageId)?.journal_id ?? null;
}

/** 冷却判断：最近 withinHours 小时内是否已有自动创建的日记条目。 */
export function hasRecentAutoJournalEntry(withinHours = 2) {
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
  const row = getDatabase()
    .prepare(`
      select id from journal_entries
      where deleted_at is null and source_message_id is not null and created_at > ?
      limit 1
    `)
    .get(since);
  return Boolean(row);
}

export function listJournalEntries(limit = 90) {
  const rows = getDatabase()
    .prepare(`
      select * from journal_entries
      where deleted_at is null
      order by day desc, created_at desc
      limit ?
    `)
    .all(Math.max(1, Math.min(limit, 365))) as unknown as JournalRow[];
  return rows.map(rowToJournal);
}

export function deleteJournalEntry(id: string) {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare(`
      update journal_entries set deleted_at = ?, updated_at = ?
      where id = ? and deleted_at is null
    `)
    .run(now, now, id);
  return result.changes > 0;
}

/** 合并同一天高度相似的历史自动日记；旧条目仅软隐藏，可从数据库恢复。 */
export function consolidateJournalEntries() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const archivedSensitive = db
    .prepare(`
      update journal_entries
      set deleted_at = ?,
          governance_reason = '第三方亲密关系细节不保留',
          updated_at = ?
      where deleted_at is null
        and source_message_id is not null
        and (
          title like '%前女友%'
          or title like '%前男友%'
          or summary like '%前女友%'
          or summary like '%前男友%'
          or summary like '%其前%'
        )
    `)
    .run(now, now).changes;
  const rows = db
    .prepare(`
      select * from journal_entries
      where deleted_at is null and source_message_id is not null
      order by day asc, important desc, created_at asc
    `)
    .all() as unknown as JournalRow[];
  const keepers: JournalRow[] = [];
  let merged = 0;

  for (const row of rows) {
    const keeper = keepers.find(
      (candidate) =>
        candidate.day === row.day &&
        journalEntriesMatch(candidate, row),
    );
    if (!keeper) {
      keepers.push(row);
      continue;
    }

    const summary = mergeDistinctText(keeper.summary, row.summary);
    db.prepare(`
      update journal_entries
      set summary = ?, important = ?, updated_at = ?
      where id = ?
    `).run(
      summary,
      keeper.important || row.important ? 1 : 0,
      now,
      keeper.id,
    );
    db.prepare(`
      update journal_entries
      set deleted_at = ?, merged_into_id = ?,
          governance_reason = '与同日记录重复，已合并', updated_at = ?
      where id = ? and deleted_at is null
    `).run(now, keeper.id, now, row.id);
    db.prepare(`
      update journal_entry_sources set journal_id = ? where journal_id = ?
    `).run(keeper.id, row.id);
    keeper.summary = summary;
    keeper.important = keeper.important || row.important ? 1 : 0;
    merged += 1;
  }

  const activeRows = db
    .prepare(`
      select id, summary from journal_entries
      where deleted_at is null and source_message_id is not null
    `)
    .all() as unknown as Array<{ id: string; summary: string }>;
  let compacted = 0;
  for (const row of activeRows) {
    const compact = compactJournalText(row.summary);
    if (compact === row.summary) continue;
    db.prepare(`
      update journal_entries set summary = ?, updated_at = ? where id = ?
    `).run(compact, now, row.id);
    compacted += 1;
  }

  return {
    merged,
    compacted,
    archivedSensitive: Number(archivedSensitive),
  };
}

export function upsertOpenTopic(input: {
  content: string;
  sourceMemoryId?: string | null;
  sourceConversationId?: string | null;
}) {
  const db = getDatabase();
  const content = input.content.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!content) throw new Error("话题内容不能为空");
  const now = new Date().toISOString();
  const similar = findSimilarActiveTopic(db, content);
  if (similar) {
    db.prepare(`
      update open_topics
      set updated_at = ?, follow_up_count = 0, last_follow_up_at = null
      where id = ?
    `).run(now, similar.id);
    const refreshed = db
      .prepare("select * from open_topics where id = ?")
      .get(similar.id) as TopicRow;
    return rowToTopic(refreshed);
  }
  const fingerprint = createHash("sha256")
    .update(content.toLocaleLowerCase("zh-CN"))
    .digest("hex");
  db.prepare(`
    insert or ignore into open_topics (
      id, fingerprint, content, status, source_memory_id,
      source_conversation_id, created_at, updated_at
    ) values (?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    randomUUID(),
    fingerprint,
    content,
    input.sourceMemoryId ?? null,
    input.sourceConversationId ?? null,
    now,
    now,
  );

  const row = db
    .prepare("select * from open_topics where fingerprint = ?")
    .get(fingerprint) as TopicRow;
  return rowToTopic(row);
}

export function listOpenTopics(status?: TopicStatus) {
  const db = getDatabase();
  const rows = status
    ? db
        .prepare("select * from open_topics where status = ? order by updated_at desc")
        .all(status)
    : db.prepare("select * from open_topics order by updated_at desc").all();
  return (rows as unknown as TopicRow[]).map(rowToTopic);
}

const PRIVATE_FOLLOW_UP =
  /家庭|财务|资产|收入|负债|持仓|亏损|前任|前男友|前女友/;

export function isPrivateFollowUpTopic(content: string) {
  return PRIVATE_FOLLOW_UP.test(content);
}

/**
 * 领取一条到期回访。全局最多两次：24 小时一次，再过 48 小时一次。
 * ponytail: 首版随聊天页打开领取；需要关页推送时再接系统通知通道。
 */
export function claimDueFollowUp(now = new Date()) {
  if (isFollowUpQuietHours(now)) return null;
  const db = getDatabase();
  const nowIso = now.toISOString();
  const relationship = db
    .prepare("select last_interaction_at from relationship_state where id = 1")
    .get() as { last_interaction_at: string | null };
  const lastInteraction = relationship.last_interaction_at;
  if (
    !lastInteraction ||
    lastInteraction > new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  ) {
    return null;
  }

  const sent = db
    .prepare(`
      select coalesce(sum(follow_up_count), 0) as count,
             max(last_follow_up_at) as latest
      from open_topics
      where last_follow_up_at > ?
    `)
    .get(lastInteraction) as { count: number; latest: string | null };
  if (Number(sent.count) >= 2) return null;
  if (
    Number(sent.count) === 1 &&
    sent.latest &&
    sent.latest > new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
  ) {
    return null;
  }

  const rows = db
    .prepare(`
      select * from open_topics
      where status = 'active'
        and follow_up_count < 2
        and updated_at <= ?
      order by updated_at asc
      limit 30
    `)
    .all(
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    ) as unknown as TopicRow[];
  const topic = rows.find((row) => !isPrivateFollowUpTopic(row.content));
  if (!topic) return null;

  const changed = db
    .prepare(`
      update open_topics
      set follow_up_count = follow_up_count + 1,
          last_follow_up_at = ?
      where id = ? and status = 'active' and follow_up_count = ?
    `)
    .run(nowIso, topic.id, topic.follow_up_count).changes;
  if (changed === 0) return null;
  const claimed = db
    .prepare("select * from open_topics where id = ?")
    .get(topic.id) as TopicRow;
  return rowToTopic(claimed);
}

/** 把高度相似的进行中话题收拢为一条，重复项改为 dismissed。 */
export function consolidateOpenTopics() {
  const db = getDatabase();
  const rows = db
    .prepare(`
      select * from open_topics
      where status = 'active'
      order by created_at asc
    `)
    .all() as unknown as TopicRow[];
  const keepers: TopicRow[] = [];
  const now = new Date().toISOString();
  let merged = 0;

  for (const row of rows) {
    const keeper = keepers.find(
      (candidate) => topicSimilarity(candidate.content, row.content) >= 0.72,
    );
    if (!keeper) {
      keepers.push(row);
      continue;
    }
    db.prepare(`
      update open_topics
      set status = 'dismissed', completed_at = ?, updated_at = ?
      where id = ? and status = 'active'
    `).run(now, now, row.id);
    merged += 1;
  }
  return { merged };
}

export function getCompanionGovernanceStats() {
  const db = getDatabase();
  const journalRows = db
    .prepare(`
      select * from journal_entries
      where deleted_at is null and source_message_id is not null
      order by day asc, created_at asc
    `)
    .all() as unknown as JournalRow[];
  let journalDuplicates = 0;
  for (let index = 0; index < journalRows.length; index += 1) {
    const current = journalRows[index];
    const repeated = journalRows.slice(0, index).some(
      (previous) =>
        previous.day === current.day &&
        journalEntriesMatch(previous, current),
    );
    if (repeated) journalDuplicates += 1;
  }

  const topics = listOpenTopics("active");
  let topicDuplicates = 0;
  for (let index = 0; index < topics.length; index += 1) {
    if (
      topics
        .slice(0, index)
        .some(
          (previous) =>
            topicSimilarity(previous.content, topics[index].content) >= 0.72,
        )
    ) {
      topicDuplicates += 1;
    }
  }
  return { journalDuplicates, topicDuplicates };
}

export function updateOpenTopicStatus(id: string, status: TopicStatus) {
  const now = new Date().toISOString();
  const completedAt = status === "completed" ? now : null;
  getDatabase()
    .prepare(
      status === "active"
        ? `
          update open_topics
          set status = ?, completed_at = ?, updated_at = ?,
              follow_up_count = 0, last_follow_up_at = null
          where id = ?
        `
        : `
          update open_topics
          set status = ?, completed_at = ?, updated_at = ?
          where id = ?
        `,
    )
    .run(status, completedAt, now, id);
  const row = getDatabase()
    .prepare("select * from open_topics where id = ?")
    .get(id) as TopicRow | undefined;
  return row ? rowToTopic(row) : null;
}

export function updateOpenTopicContentByMemoryId(
  sourceMemoryId: string,
  content: string,
) {
  const normalized = content.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!normalized) return;
  const fingerprint = createHash("sha256")
    .update(normalized.toLocaleLowerCase("zh-CN"))
    .digest("hex");
  getDatabase()
    .prepare(`
      update open_topics
      set content = ?, fingerprint = ?, updated_at = ?
      where source_memory_id = ?
    `)
    .run(normalized, fingerprint, new Date().toISOString(), sourceMemoryId);
}

export function deleteOpenTopicByMemoryId(sourceMemoryId: string) {
  getDatabase()
    .prepare("delete from open_topics where source_memory_id = ?")
    .run(sourceMemoryId);
}

/** 按内容指纹把仍处于 active 的话题标记为 completed，并返回命中的话题。 */
export function completeOpenTopicByContent(content: string) {
  const normalized = content.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!normalized) return null;
  const fingerprint = createHash("sha256")
    .update(normalized.toLocaleLowerCase("zh-CN"))
    .digest("hex");
  const now = new Date().toISOString();
  const db = getDatabase();
  const result = db
    .prepare(`
      update open_topics
      set status = 'completed', completed_at = ?, updated_at = ?
      where fingerprint = ? and status = 'active'
    `)
    .run(now, now, fingerprint);
  if (result.changes > 0) {
    const completed = db
      .prepare("select * from open_topics where fingerprint = ?")
      .get(fingerprint) as TopicRow | undefined;
    return completed ? rowToTopic(completed) : null;
  }

  const similar = findSimilarActiveTopic(db, normalized);
  if (!similar) return null;
  const changed = db
    .prepare(`
      update open_topics
      set status = 'completed', completed_at = ?, updated_at = ?
      where id = ? and status = 'active'
    `)
    .run(now, now, similar.id).changes;
  if (changed === 0) return null;
  return rowToTopic({ ...similar, status: "completed", completed_at: now, updated_at: now });
}

function comparableTopic(content: string) {
  return content
    .toLocaleLowerCase("zh-CN")
    .replace(/观棋|用户|正在|尚未|目前|考虑|决定|希望|想要|准备/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function topicBigrams(content: string) {
  const normalized = comparableTopic(content);
  if (normalized.length < 2) return new Set([normalized]);
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function topicSimilarity(left: string, right: string) {
  const normalizedLeft = comparableTopic(left);
  const normalizedRight = comparableTopic(right);
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return 1;
  }
  const leftGrams = topicBigrams(left);
  const rightGrams = topicBigrams(right);
  const smaller = Math.min(leftGrams.size, rightGrams.size);
  if (smaller === 0) return 0;
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }
  return intersection / smaller;
}

function findSimilarActiveTopic(db: DatabaseSync, content: string) {
  const rows = db
    .prepare(`
      select * from open_topics
      where status = 'active'
      order by updated_at desc
      limit 100
    `)
    .all() as unknown as TopicRow[];
  return rows.find((row) => topicSimilarity(row.content, content) >= 0.72);
}

export function buildRelationshipContext() {
  const state = getRelationshipState();
  const activeTopics = listOpenTopics("active").slice(0, 3);
  const lastMoment = state.lastMoment.trim();
  const usefulLastMoment =
    lastMoment.length >= 6 && !isMeaninglessMomentText(lastMoment);

  return [
    "与用户是自然熟悉的关系，作为背景即可，不要在回复中强调。",
    "优先像熟人一样接话；不要固定点名，不要专属宣言，不要把普通聊天强行浪漫化。",
    `相处质感：${state.familiarityText}。`,
    usefulLastMoment ? `最近一次用户提到：${lastMoment}` : "",
    activeTopics.length
      ? `仍可自然接续的话题：${activeTopics.map((topic) => topic.content).join("；")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
