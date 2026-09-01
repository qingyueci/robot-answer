import {
  consolidateJournalEntries,
  consolidateOpenTopics,
  getCompanionGovernanceStats,
} from "@/lib/companion/store";
import {
  consolidateConfirmedMemories,
  getMemoryGovernanceStats,
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

/** API 执行过期、去重和归档；待确认候选最多保留 14 天。 */
export async function runAutomaticGovernance(scope: GovernanceScope = "all") {
  const result: Record<string, unknown> = {};

  if (scope === "memory" || scope === "all") {
    // 未确认推断/冲突会保留为 candidate；housekeeping 只清理超过 14 天的项。
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
      candidatesResolved:
        housekeeping.staleCandidates + housekeeping.thirdPartySensitive,
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
