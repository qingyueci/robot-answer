import {
  consolidateJournalEntries,
  consolidateOpenTopics,
  getCompanionGovernanceStats,
} from "@/lib/companion/store";
import {
  consolidateConfirmedMemories,
  getMemoryGovernanceStats,
  listMemoryRecords,
  rejectMemoryRecord,
  runMemoryHousekeeping,
} from "@/lib/memory/local-store";
import { deleteConfirmedMemory } from "@/lib/memory/service";

export type GovernanceScope = "memory" | "journal" | "topics" | "all";

export function currentGovernanceStats() {
  return {
    memory: getMemoryGovernanceStats(),
    companion: getCompanionGovernanceStats(),
  };
}

/** 由 API 统一执行保留、过期、去重和归档，不把整理工作留给页面。 */
export async function runAutomaticGovernance(scope: GovernanceScope = "all") {
  const result: Record<string, unknown> = {};

  if (scope === "memory" || scope === "all") {
    const pending = listMemoryRecords("candidate");
    for (const record of pending) {
      rejectMemoryRecord(record.id, "API 已接管去留：归档旧的人工待确认项");
    }
    const housekeeping = runMemoryHousekeeping();
    const consolidated = consolidateConfirmedMemories();
    let vectorsRemoved = 0;
    for (const mem0Id of consolidated.mem0Ids) {
      try {
        await deleteConfirmedMemory(mem0Id);
        vectorsRemoved += 1;
      } catch {
        // 本地已经完成治理，向量服务恢复后仍可再次清理。
      }
    }
    result.memory = {
      ...housekeeping,
      merged: consolidated.merged,
      vectorsRemoved,
      candidatesResolved: pending.length,
    };
  }

  if (scope === "journal" || scope === "all") {
    result.journal = consolidateJournalEntries();
  }
  if (scope === "topics" || scope === "all") {
    result.topics = consolidateOpenTopics();
  }

  return { result, stats: currentGovernanceStats() };
}
