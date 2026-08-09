import { mkdirSync } from "node:fs";
import path from "node:path";
import { Memory } from "mem0ai/oss";
import { textSimilarity } from "@/lib/governance/text";
import type { MemoryCategory } from "./types";

const MEMORY_USER_ID = process.env.ROBOT_MEMORY_USER_ID?.trim() || "guanqi";
const MEMORY_AGENT_ID = process.env.ROBOT_MEMORY_AGENT_ID?.trim() || "home-robot";
let memoryInstance: Memory | undefined;

function memoryEnabled() {
  return process.env.ROBOT_MEMORY_ENABLED?.trim().toLowerCase() !== "false";
}

function getMemory() {
  if (!memoryEnabled()) throw new Error("本地长期记忆未启用");
  if (memoryInstance) return memoryInstance;

  const historyDbPath =
    process.env.ROBOT_MEM0_HISTORY_DB_PATH?.trim() ||
    path.resolve(
      /*turbopackIgnore: true*/ process.cwd(),
      "../../data/memory/mem0-history.db",
    );
  mkdirSync(path.dirname(historyDbPath), { recursive: true });

  // LLM 配置与聊天路径同优先级：ROBOT_CHAT_* 优先，KIMI_CODE_* 回退。
  const robotApiKey = process.env.ROBOT_CHAT_API_KEY?.trim();
  const robotModel =
    process.env.ROBOT_BACKGROUND_MODEL?.trim() ||
    process.env.ROBOT_CHAT_MODEL?.trim();
  const kimiApiKey = process.env.KIMI_CODE_API_KEY?.trim();

  let llmConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    temperature: number;
  };
  if (robotApiKey && robotModel) {
    const baseURL = process.env.ROBOT_CHAT_BASE_URL?.trim();
    llmConfig = {
      apiKey: robotApiKey,
      ...(baseURL ? { baseURL } : {}),
      model: robotModel,
      temperature: 0.1,
    };
  } else if (kimiApiKey) {
    llmConfig = {
      apiKey: kimiApiKey,
      baseURL:
        process.env.KIMI_CODE_BASE_URL?.trim() ||
        "https://api.kimi.com/coding/v1",
      model: process.env.KIMI_CODE_MODEL?.trim() || "kimi-for-coding",
      // kimi-for-coding 仅接受 temperature=1。
      temperature: 1,
    };
  } else {
    throw new Error("缺少对话模型配置（ROBOT_CHAT_* 或 KIMI_CODE_*），无法提取长期记忆");
  }

  memoryInstance = new Memory({
    embedder: {
      provider: "ollama",
      config: {
        model:
          process.env.ROBOT_MEMORY_EMBED_MODEL?.trim() ||
          "nomic-embed-text-v2-moe",
        url: process.env.ROBOT_OLLAMA_URL?.trim() || "http://127.0.0.1:11434",
        embeddingDims: 768,
      },
    },
    vectorStore: {
      provider: "qdrant",
      config: {
        host: process.env.ROBOT_QDRANT_HOST?.trim() || "127.0.0.1",
        port: Number(process.env.ROBOT_QDRANT_PORT || 6333),
        collectionName:
          process.env.ROBOT_QDRANT_COLLECTION?.trim() || "home_robot_memories",
        embeddingModelDims: 768,
        dimension: 768,
        onDisk: true,
      },
    },
    llm: {
      provider: "openai",
      config: {
        apiKey: llmConfig.apiKey,
        ...(llmConfig.baseURL ? { baseURL: llmConfig.baseURL } : {}),
        model: llmConfig.model,
        timeout: Number(process.env.ROBOT_MODEL_TIMEOUT_MS || 45_000),
        temperature: llmConfig.temperature,
      },
    },
    historyDbPath,
    customInstructions:
      "只保存观棋明确表达、可在未来对话中复用的事实。不要把临时情绪推断成固定人格。",
  });

  return memoryInstance;
}

export async function addConfirmedMemory(
  content: string,
  category: MemoryCategory,
  metadata: Record<string, unknown> = {},
) {
  const expiresAt = typeof metadata.expiresAt === "string" ? metadata.expiresAt : null;
  const result = await getMemory().add(content, {
    userId: MEMORY_USER_ID,
    agentId: MEMORY_AGENT_ID,
    infer: false,
    expirationDate: expiresAt ? expiresAt.slice(0, 10) : null,
    metadata: { ...metadata, category, status: "confirmed" },
  });
  const id = result.results[0]?.id;
  if (!id) throw new Error("Mem0 没有返回记忆 ID");
  return id;
}

type MemoryMetadata = Record<string, unknown> | undefined;

/** 过期或不应进入聊天上下文的记录过滤。 */
function usableConfirmed(metadata: MemoryMetadata, nowIso: string) {
  if (!metadata || metadata.status !== "confirmed") return false;
  const expiresAt =
    typeof metadata.expiresAt === "string" ? metadata.expiresAt : null;
  if (expiresAt && expiresAt < nowIso) return false;
  // 涉及第三方且敏感的详细资料不进入聊天上下文。
  if (
    metadata.aboutThirdParty === true &&
    metadata.sensitive === true &&
    metadata.userConfirmed !== true
  ) {
    return false;
  }
  return true;
}

export async function searchConfirmedMemories(query: string) {
  if (!query.trim() || !memoryEnabled()) return [];
  const result = await getMemory().search(query, {
    topK: 8,
    threshold: 0.45,
    filters: {
      user_id: MEMORY_USER_ID,
      agent_id: MEMORY_AGENT_ID,
    },
  });
  const nowIso = new Date().toISOString();
  const deduplicated: typeof result.results = [];
  for (const item of result.results) {
    if (!usableConfirmed(item.metadata as MemoryMetadata, nowIso)) continue;
    const content = typeof item.memory === "string" ? item.memory.trim() : "";
    if (!content) continue;
    const repeated = deduplicated.some(
      (existing) =>
        typeof existing.memory === "string" &&
        textSimilarity(existing.memory, content) >= 0.82,
    );
    if (!repeated) deduplicated.push(item);
    if (deduplicated.length >= 4) break;
  }
  return deduplicated;
}

/**
 * 语义去重：找分数最高且 ≥ 0.88 的已确认记忆。
 * 检索失败时返回 null（调用方按普通确认流程继续）。
 */
export async function findSimilarConfirmedMemory(
  content: string,
): Promise<{ id: string; memory: string; score: number } | null> {
  if (!content.trim() || !memoryEnabled()) return null;
  try {
    const result = await getMemory().search(content, {
      topK: 3,
      threshold: 0.5,
      filters: {
        user_id: MEMORY_USER_ID,
        agent_id: MEMORY_AGENT_ID,
      },
    });
    const nowIso = new Date().toISOString();
    let best: { id: string; memory: string; score: number } | null = null;
    for (const item of result.results) {
      if (!usableConfirmed(item.metadata as MemoryMetadata, nowIso)) continue;
      const score = Number(item.score);
      if (!Number.isFinite(score) || score < 0.88) continue;
      const id = typeof item.id === "string" ? item.id : "";
      const memory = typeof item.memory === "string" ? item.memory.trim() : "";
      if (!id || !memory) continue;
      if (!best || score > best.score) best = { id, memory, score };
    }
    return best;
  } catch {
    return null;
  }
}

export async function buildMemoryContext(query: string) {
  const memories = await searchConfirmedMemories(query);
  if (memories.length === 0) return "";

  const lines = memories.map((item) => `- ${item.memory}`);
  return [
    "以下是经过确认的长期记忆，只在与当前话题有关时自然使用；不要逐条复述，也不要声称记得未列出的事实：",
    ...lines,
  ].join("\n");
}

export async function updateConfirmedMemory(id: string, content: string) {
  await getMemory().update(id, { text: content });
}

export async function deleteConfirmedMemory(id: string) {
  await getMemory().delete(id);
}
