import {
  conflictsWithCurrentFactCorrection,
  extractCurrentFactCorrection,
} from "@/lib/governance/text";
import {
  attachMemoryVectorIfCurrent,
  attachVectorToRejectedMemory,
  listMemoryRecords,
  reconcileConfirmedMemoryRecords,
  setMemoryGovernanceReason,
  setMemoryGovernanceReasonIfCurrent,
} from "./local-store";
import { addConfirmedMemory, deleteConfirmedMemory } from "./service";
import type { MemoryCategory } from "./types";

type VectorOperations = {
  add: (
    content: string,
    category: MemoryCategory,
    metadata: Record<string, unknown>,
  ) => Promise<string>;
  delete: (id: string) => Promise<void>;
};

const defaultVectorOperations: VectorOperations = {
  add: addConfirmedMemory,
  delete: deleteConfirmedMemory,
};

function safeFragment(value: string) {
  return value
    .trim()
    .replace(/^[\[（(“‘'"「『]+|[\]）)”’'"」』]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function correctedContent(existing: string, rejected: string, asserted: string) {
  if (existing.includes(rejected)) {
    return existing.split(rejected).join(asserted).trim().slice(0, 500);
  }
  return `用户明确纠正相关事实为：${asserted}`;
}

export type MemoryReconciliationResult = {
  status:
    | "not_applicable"
    | "no_conflict"
    | "confirmed"
    | "confirmed_local_only"
    | "superseded";
  oldMemoryIds: string[];
  newMemoryId: string | null;
  content: string | null;
  vectorDeleteFailures: number;
  reason?: string;
};

/**
 * 只信任用户原文中的 X/Y：本地事务先完成 X→Y，再 best-effort 同步向量。
 * 因此向量服务失败或进程在同步前退出，都不会让旧 X 再进入本地 Recall。
 */
export async function reconcileCurrentFactCorrection(
  input: {
    userText: string;
    conversationId: string | null;
  },
  vectors: VectorOperations = defaultVectorOperations,
): Promise<MemoryReconciliationResult> {
  const correction = extractCurrentFactCorrection(input.userText);
  if (!correction) {
    return {
      status: "not_applicable",
      oldMemoryIds: [],
      newMemoryId: null,
      content: null,
      vectorDeleteFailures: 0,
    };
  }

  const rejected = safeFragment(correction.rejected);
  const asserted = safeFragment(correction.asserted);
  if (!rejected || !asserted || rejected === asserted) {
    return {
      status: "not_applicable",
      oldMemoryIds: [],
      newMemoryId: null,
      content: null,
      vectorDeleteFailures: 0,
    };
  }

  const oldMemories = listMemoryRecords("confirmed").filter((memory) =>
    conflictsWithCurrentFactCorrection(memory.content, input.userText),
  );
  if (oldMemories.length === 0) {
    return {
      status: "no_conflict",
      oldMemoryIds: [],
      newMemoryId: null,
      content: null,
      vectorDeleteFailures: 0,
    };
  }

  const primary = [...oldMemories].sort(
    (left, right) => right.confidence - left.confidence,
  )[0];
  const content = correctedContent(primary.content, rejected, asserted);
  const local = reconcileConfirmedMemoryRecords({
    oldIds: oldMemories.map((memory) => memory.id),
    content,
    category: primary.category,
    sensitive: primary.sensitive,
    confidence: 1,
    sourceConversationId: input.conversationId,
    sourceExcerpt: input.userText,
    expiresAt: primary.expiresAt,
    aboutThirdParty: primary.aboutThirdParty,
  });
  if (!local) {
    return {
      status: "no_conflict",
      oldMemoryIds: [],
      newMemoryId: null,
      content: null,
      vectorDeleteFailures: 0,
    };
  }

  let vectorDeleteFailures = 0;
  for (const id of [...new Set(local.vectorIdsToDelete)]) {
    try {
      await vectors.delete(id);
    } catch {
      vectorDeleteFailures += 1;
    }
  }

  if (!local.needsVectorSync) {
    if (vectorDeleteFailures > 0) {
      setMemoryGovernanceReason(
        local.record.id,
        "用户纠正已确认；旧向量删除失败，本地已停用",
      );
    }
    return {
      status: "confirmed",
      oldMemoryIds: oldMemories.map((memory) => memory.id),
      newMemoryId: local.record.id,
      content: local.record.content,
      vectorDeleteFailures,
    };
  }

  try {
    const mem0Id = await vectors.add(local.record.content, local.record.category, {
      sourceConversationId: input.conversationId,
      sourceExcerpt: input.userText,
      confidence: 1,
      updatedAt: local.record.updatedAt,
      expiresAt: local.record.expiresAt,
      sensitive: local.record.sensitive,
      aboutThirdParty: local.record.aboutThirdParty,
      userConfirmed: true,
      localMemoryId: local.record.id,
      correctionOf: oldMemories.map((memory) => memory.id),
    });
    const attached = attachMemoryVectorIfCurrent({
      id: local.record.id,
      expectedUpdatedAt: local.record.updatedAt,
      mem0Id,
    });
    if (!attached) {
      try {
        await vectors.delete(mem0Id);
      } catch {
        vectorDeleteFailures += 1;
        attachVectorToRejectedMemory({
          id: local.record.id,
          mem0Id,
          reason: "纠正已被后续事实取代；过时向量删除失败",
        });
      }
      return {
        status: "superseded",
        oldMemoryIds: oldMemories.map((memory) => memory.id),
        newMemoryId: local.record.id,
        content: local.record.content,
        vectorDeleteFailures,
      };
    }
    setMemoryGovernanceReason(
      local.record.id,
      vectorDeleteFailures > 0
        ? "用户纠正已确认；旧向量删除失败，本地已停用"
        : "",
    );
    return {
      status: "confirmed",
      oldMemoryIds: oldMemories.map((memory) => memory.id),
      newMemoryId: local.record.id,
      content: local.record.content,
      vectorDeleteFailures,
    };
  } catch {
    // 本地事务已确认 Y；向量失败只降低语义召回，不允许回滚到旧 X。
    const reason =
      vectorDeleteFailures > 0
        ? "用户纠正已本地确认；新旧向量同步失败"
        : "用户纠正已本地确认；新向量写入失败";
    const diagnosed = setMemoryGovernanceReasonIfCurrent({
      id: local.record.id,
      expectedUpdatedAt: local.record.updatedAt,
      reason,
    });
    if (!diagnosed) {
      return {
        status: "superseded",
        oldMemoryIds: oldMemories.map((memory) => memory.id),
        newMemoryId: local.record.id,
        content: local.record.content,
        vectorDeleteFailures,
      };
    }
    return {
      status: "confirmed_local_only",
      oldMemoryIds: oldMemories.map((memory) => memory.id),
      newMemoryId: local.record.id,
      content: local.record.content,
      vectorDeleteFailures,
      reason,
    };
  }
}
