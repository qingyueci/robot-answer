import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { textSimilarity } from "@/lib/governance/text";
import type { MemoryCategory, MemoryRecord, MemoryStatus } from "./types";

type MemoryRow = {
  id: string;
  content: string;
  category: MemoryCategory;
  status: MemoryStatus;
  sensitive: number;
  confidence: number;
  source_conversation_id: string | null;
  source_excerpt: string;
  expires_at: string | null;
  mem0_id: string | null;
  about_third_party: number;
  governance_reason: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

let database: DatabaseSync | undefined;

function databasePath() {
  return (
    process.env.ROBOT_MEMORY_DB_PATH?.trim() ||
    path.resolve(
      /*turbopackIgnore: true*/ process.cwd(),
      "../../data/memory/robot-memory.db",
    )
  );
}

function getDatabase() {
  if (database) return database;

  const filePath = databasePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  database.exec(`
    create table if not exists memory_records (
      id text primary key,
      fingerprint text not null unique,
      content text not null,
      category text not null,
      status text not null default 'candidate',
      sensitive integer not null default 0,
      confidence real not null default 0,
      source_conversation_id text,
      source_excerpt text not null default '',
      expires_at text,
      mem0_id text,
      about_third_party integer not null default 0,
      governance_reason text not null default '',
      created_at text not null,
      updated_at text not null,
      deleted_at text
    );

    create index if not exists memory_records_status_updated_idx
      on memory_records(status, updated_at desc);
  `);

  // 兼容迁移：旧库缺少 about_third_party 列时补充（SQLite 不支持 ADD COLUMN IF NOT EXISTS）。
  const columns = database
    .prepare("PRAGMA table_info(memory_records)")
    .all() as unknown as { name: string }[];
  if (!columns.some((column) => column.name === "about_third_party")) {
    database.exec(
      "alter table memory_records add column about_third_party integer not null default 0",
    );
  }
  if (!columns.some((column) => column.name === "governance_reason")) {
    database.exec(
      "alter table memory_records add column governance_reason text not null default ''",
    );
  }
  return database;
}

function normalizeContent(content: string) {
  return content.trim().replace(/\s+/g, " ");
}

function fingerprintFor(category: MemoryCategory, content: string) {
  return createHash("sha256")
    .update(`${category}\0${content.toLocaleLowerCase("zh-CN")}`)
    .digest("hex");
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    status: row.status,
    sensitive: Boolean(row.sensitive),
    confidence: row.confidence,
    sourceConversationId: row.source_conversation_id,
    sourceExcerpt: row.source_excerpt,
    expiresAt: row.expires_at,
    mem0Id: row.mem0_id,
    aboutThirdParty: Boolean(row.about_third_party),
    governanceReason: row.governance_reason ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMemoryRecord(input: {
  content: string;
  category: MemoryCategory;
  sensitive: boolean;
  confidence: number;
  sourceConversationId?: string | null;
  sourceExcerpt?: string;
  expiresAt?: string | null;
  aboutThirdParty?: boolean;
}) {
  const db = getDatabase();
  const content = normalizeContent(input.content);
  const fingerprint = fingerprintFor(input.category, content);
  const now = new Date().toISOString();
  const id = randomUUID();

  const result = db
    .prepare(`
      insert or ignore into memory_records (
        id, fingerprint, content, category, status, sensitive, confidence,
        source_conversation_id, source_excerpt, expires_at, about_third_party,
        created_at, updated_at
      ) values (?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      fingerprint,
      content,
      input.category,
      input.sensitive ? 1 : 0,
      input.confidence,
      input.sourceConversationId ?? null,
      input.sourceExcerpt ?? "",
      input.expiresAt ?? null,
      input.aboutThirdParty ? 1 : 0,
      now,
      now,
    );

  const row = db
    .prepare("select * from memory_records where fingerprint = ? and deleted_at is null")
    .get(fingerprint) as MemoryRow | undefined;
  if (!row) throw new Error("本地记忆记录创建失败");

  return { record: rowToRecord(row), created: result.changes > 0 };
}

export function getMemoryRecord(id: string) {
  const row = getDatabase()
    .prepare("select * from memory_records where id = ? and deleted_at is null")
    .get(id) as MemoryRow | undefined;
  return row ? rowToRecord(row) : null;
}

/** 按 mem0 向量库 ID 反查本地记录（语义去重更新旧记录时用）。 */
export function getMemoryRecordByMem0Id(mem0Id: string) {
  const row = getDatabase()
    .prepare("select * from memory_records where mem0_id = ? and deleted_at is null")
    .get(mem0Id) as MemoryRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function listMemoryRecords(status?: MemoryStatus) {
  const db = getDatabase();
  runMemoryHousekeeping();
  const rows = status
    ? db
        .prepare(`
          select * from memory_records
          where status = ? and deleted_at is null
          order by updated_at desc
        `)
        .all(status)
    : db
        .prepare(`
          select * from memory_records
          where deleted_at is null
          order by updated_at desc
        `)
        .all();

  return (rows as unknown as MemoryRow[]).map(rowToRecord);
}

export function markMemoryConfirmed(id: string, mem0Id: string | null) {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(`
      update memory_records
      set status = 'confirmed', mem0_id = ?, updated_at = ?
      where id = ? and deleted_at is null
    `)
    .run(mem0Id, now, id);
  return getMemoryRecord(id);
}

/** 仅在本地确认记录仍是发起向量写入时的版本时绑定结果。 */
export function attachMemoryVectorIfCurrent(input: {
  id: string;
  expectedUpdatedAt: string;
  mem0Id: string;
}) {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare(`
      update memory_records
      set mem0_id = ?, updated_at = ?
      where id = ?
        and status = 'confirmed'
        and mem0_id is null
        and updated_at = ?
        and deleted_at is null
    `)
    .run(input.mem0Id, now, input.id, input.expectedUpdatedAt);
  return result.changes > 0 ? getMemoryRecord(input.id) : null;
}

/** 向量失败诊断也受版本约束，避免覆盖后续纠正留下的状态。 */
export function setMemoryGovernanceReasonIfCurrent(input: {
  id: string;
  expectedUpdatedAt: string;
  reason: string;
}) {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare(`
      update memory_records
      set governance_reason = ?, updated_at = ?
      where id = ?
        and status = 'confirmed'
        and mem0_id is null
        and updated_at = ?
        and deleted_at is null
    `)
    .run(
      input.reason.trim().slice(0, 120),
      now,
      input.id,
      input.expectedUpdatedAt,
    );
  return result.changes > 0 ? getMemoryRecord(input.id) : null;
}

/**
 * 在单个本地事务中停用被纠正的旧事实，并让新事实立即可被本地 Recall 使用。
 * 向量同步随后 best-effort 执行，进程在任意时刻退出都不会让旧事实重新召回。
 */
export function reconcileConfirmedMemoryRecords(input: {
  oldIds: string[];
  content: string;
  category: MemoryCategory;
  sensitive: boolean;
  confidence: number;
  sourceConversationId?: string | null;
  sourceExcerpt: string;
  expiresAt?: string | null;
  aboutThirdParty?: boolean;
}) {
  const oldIds = [...new Set(input.oldIds.filter(Boolean))];
  const content = normalizeContent(input.content);
  if (oldIds.length === 0 || !content) return null;

  const db = getDatabase();
  const now = new Date().toISOString();
  const fingerprint = fingerprintFor(input.category, content);
  const placeholders = oldIds.map(() => "?").join(", ");
  db.exec("BEGIN IMMEDIATE");
  try {
    const oldRows = db
      .prepare(`
        select * from memory_records
        where id in (${placeholders})
          and status = 'confirmed'
          and deleted_at is null
      `)
      .all(...oldIds) as unknown as MemoryRow[];
    if (oldRows.length === 0) {
      db.exec("ROLLBACK");
      return null;
    }

    const existing = db
      .prepare("select * from memory_records where fingerprint = ?")
      .get(fingerprint) as MemoryRow | undefined;
    const activeConfirmed = Boolean(
      existing && existing.status === "confirmed" && !existing.deleted_at,
    );
    const targetId = existing?.id ?? randomUUID();
    const previousTargetMem0Id = activeConfirmed ? null : existing?.mem0_id ?? null;

    if (!existing) {
      db.prepare(`
        insert into memory_records (
          id, fingerprint, content, category, status, sensitive, confidence,
          source_conversation_id, source_excerpt, expires_at, mem0_id,
          about_third_party, governance_reason, created_at, updated_at
        ) values (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, null, ?, ?, ?, ?)
      `).run(
        targetId,
        fingerprint,
        content,
        input.category,
        input.sensitive ? 1 : 0,
        Math.max(0, Math.min(1, input.confidence)),
        input.sourceConversationId ?? null,
        input.sourceExcerpt.trim().slice(0, 1200),
        input.expiresAt ?? null,
        input.aboutThirdParty ? 1 : 0,
        "用户本轮明确纠正；向量待同步",
        now,
        now,
      );
    } else if (!activeConfirmed || !existing.mem0_id) {
      db.prepare(`
        update memory_records
        set content = ?, category = ?, status = 'confirmed', sensitive = ?,
            confidence = ?, source_conversation_id = ?, source_excerpt = ?,
            expires_at = ?, mem0_id = null, about_third_party = ?,
            governance_reason = '用户本轮明确纠正；向量待同步',
            updated_at = ?, deleted_at = null
        where id = ?
      `).run(
        content,
        input.category,
        input.sensitive ? 1 : 0,
        Math.max(0, Math.min(1, input.confidence)),
        input.sourceConversationId ?? null,
        input.sourceExcerpt.trim().slice(0, 1200),
        input.expiresAt ?? null,
        input.aboutThirdParty ? 1 : 0,
        now,
        targetId,
      );
    }

    db.prepare(`
      update memory_records
      set status = 'rejected',
          governance_reason = '用户本轮明确纠正，旧事实已停用',
          updated_at = ?
      where id in (${placeholders})
        and status = 'confirmed'
        and deleted_at is null
    `).run(now, ...oldIds);

    db.exec("COMMIT");
    const record = getMemoryRecord(targetId);
    if (!record) throw new Error("纠正后的本地记忆不存在");
    return {
      record,
      needsVectorSync: !activeConfirmed || !existing?.mem0_id,
      vectorIdsToDelete: [
        ...oldRows.map((row) => row.mem0_id).filter((id): id is string => Boolean(id)),
        ...(previousTargetMem0Id ? [previousTargetMem0Id] : []),
      ],
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // COMMIT 后的读取异常无需再次回滚。
    }
    throw error;
  }
}

export function updateMemoryRecord(id: string, content: string) {
  const normalized = normalizeContent(content);
  if (!normalized) throw new Error("记忆内容不能为空");
  const existing = getMemoryRecord(id);
  if (!existing) return null;
  const fingerprint = fingerprintFor(existing.category, normalized);
  getDatabase()
    .prepare(`
      update memory_records set content = ?, fingerprint = ?, updated_at = ?
      where id = ? and deleted_at is null
    `)
    .run(normalized, fingerprint, new Date().toISOString(), id);
  return getMemoryRecord(id);
}

export function rejectMemoryRecord(id: string, reason = "") {
  getDatabase()
    .prepare(`
      update memory_records
      set status = 'rejected', governance_reason = ?, updated_at = ?
      where id = ? and deleted_at is null
    `)
    .run(reason.trim().slice(0, 120), new Date().toISOString(), id);
  return getMemoryRecord(id);
}

export function setMemoryGovernanceReason(id: string, reason: string) {
  getDatabase()
    .prepare(`
      update memory_records
      set governance_reason = ?, updated_at = ?
      where id = ? and deleted_at is null
    `)
    .run(
      reason.trim().slice(0, 120),
      new Date().toISOString(),
      id,
    );
  return getMemoryRecord(id);
}

/** stale 向量删不掉时，把它绑定到 rejected tombstone，供语义召回硬过滤。 */
export function attachVectorToRejectedMemory(input: {
  id: string;
  mem0Id: string;
  reason: string;
}) {
  const result = getDatabase()
    .prepare(`
      update memory_records
      set mem0_id = ?, governance_reason = ?, updated_at = ?
      where id = ? and status = 'rejected' and deleted_at is null
    `)
    .run(
      input.mem0Id,
      input.reason.trim().slice(0, 120),
      new Date().toISOString(),
      input.id,
    );
  return result.changes > 0 ? getMemoryRecord(input.id) : null;
}

/**
 * 本地记忆保洁：
 * - 临时状态到期后转为“已忽略”；
 * - 候选超过 14 天无人确认后自动归档；
 * - 第三方敏感候选不继续滞留。
 * 记录只改状态，不做物理删除。
 */
export function runMemoryHousekeeping(now = new Date()) {
  const db = getDatabase();
  const nowIso = now.toISOString();
  const staleCandidateAt = new Date(
    now.getTime() - 14 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const expired = db
    .prepare(`
      update memory_records
      set status = 'rejected',
          governance_reason = '临时信息已过期',
          updated_at = ?
      where deleted_at is null
        and status != 'rejected'
        and expires_at is not null
        and expires_at < ?
    `)
    .run(nowIso, nowIso).changes;

  const stale = db
    .prepare(`
      update memory_records
      set status = 'rejected',
          governance_reason = '超过14天未确认，已自动归档',
          updated_at = ?
      where deleted_at is null
        and status = 'candidate'
        and created_at < ?
    `)
    .run(nowIso, staleCandidateAt).changes;

  const thirdPartySensitive = db
    .prepare(`
      update memory_records
      set status = 'rejected',
          governance_reason = '第三方敏感信息不进入长期记忆',
          updated_at = ?
      where deleted_at is null
        and status = 'candidate'
        and sensitive = 1
        and (
          about_third_party = 1
          or content like '%前女友%'
          or content like '%前男友%'
          or content like '%前任%'
          or content like '%其前%'
        )
    `)
    .run(nowIso).changes;

  return {
    expired: Number(expired),
    staleCandidates: Number(stale),
    thirdPartySensitive: Number(thirdPartySensitive),
  };
}

export function getMemoryGovernanceStats() {
  runMemoryHousekeeping();
  const db = getDatabase();
  const row = db
    .prepare(`
      select
        sum(case when status = 'candidate' and deleted_at is null then 1 else 0 end) as candidates,
        sum(case when status = 'confirmed' and deleted_at is null then 1 else 0 end) as confirmed,
        sum(case when governance_reason != '' and deleted_at is null then 1 else 0 end) as governed
      from memory_records
    `)
    .get() as {
      candidates: number | null;
      confirmed: number | null;
      governed: number | null;
    };
  return {
    candidates: Number(row.candidates) || 0,
    confirmed: Number(row.confirmed) || 0,
    governed: Number(row.governed) || 0,
    duplicates: findConfirmedMemoryDuplicates().length,
  };
}

const CONSOLIDATABLE_CATEGORIES = new Set<MemoryCategory>([
  "ordinary_preference",
  "stable_fact",
  "open_loop",
]);

function findConfirmedMemoryDuplicates() {
  const rows = getDatabase()
    .prepare(`
      select * from memory_records
      where deleted_at is null and status = 'confirmed'
      order by length(content) desc, created_at asc
    `)
    .all() as unknown as MemoryRow[];
  const keepers: MemoryRow[] = [];
  const duplicates: Array<{ keeper: MemoryRow; duplicate: MemoryRow }> = [];

  for (const row of rows) {
    if (!CONSOLIDATABLE_CATEGORIES.has(row.category)) {
      keepers.push(row);
      continue;
    }
    const keeper = keepers.find(
      (candidate) =>
        candidate.category === row.category &&
        textSimilarity(candidate.content, row.content) >= 0.75,
    );
    if (keeper) {
      duplicates.push({ keeper, duplicate: row });
    } else {
      keepers.push(row);
    }
  }
  return duplicates;
}

/**
 * 收拢已确认的高度相似记忆。
 * 本地重复项只软隐藏；返回其 mem0Id 供 API 层同步清理向量。
 */
export function consolidateConfirmedMemories() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const duplicates = findConfirmedMemoryDuplicates();
  const mem0Ids: string[] = [];

  for (const { keeper, duplicate } of duplicates) {
    db.prepare(`
      update memory_records
      set deleted_at = ?,
          governance_reason = '与更完整的已确认记忆重复',
          updated_at = ?
      where id = ? and deleted_at is null
    `).run(now, now, duplicate.id);
    if (duplicate.mem0_id) mem0Ids.push(duplicate.mem0_id);

    // 保留条目更新到最近一次治理时间，便于在页面上靠前展示。
    db.prepare(`
      update memory_records set updated_at = ?
      where id = ? and deleted_at is null
    `).run(now, keeper.id);
  }

  return { merged: duplicates.length, mem0Ids };
}

export function softDeleteMemoryRecord(id: string) {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(`
      update memory_records set deleted_at = ?, updated_at = ?
      where id = ? and deleted_at is null
    `)
    .run(now, now, id);
}
