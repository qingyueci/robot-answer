"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { MemoryRecord, MemoryStatus } from "@/lib/memory/types";
import styles from "./page.module.css";

type MemoryGovernance = {
  candidates: number;
  confirmed: number;
  governed: number;
  duplicates: number;
};

const CATEGORY_LABELS: Record<MemoryRecord["category"], string> = {
  ordinary_preference: "偏好",
  stable_fact: "稳定事实",
  personality_inference: "理解",
  sensitive: "敏感信息",
  open_loop: "未完成话题",
  temporary_state: "短期状态",
};

const STATUS_LABELS: Record<MemoryStatus, string> = {
  candidate: "处理中",
  confirmed: "已保留",
  rejected: "已忽略",
};

function displayText(value: string) {
  return value.replaceAll("观棋", "你");
}

export default function MemoriesPage() {
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [governance, setGovernance] = useState<MemoryGovernance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const query = status === "all" ? "" : `?status=${status}`;
      const response = await fetch(`/api/memories${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("读取记忆失败");
      const data = (await response.json()) as {
        memories: MemoryRecord[];
        governance: MemoryGovernance;
      };
      setMemories(data.memories);
      setGovernance(data.governance);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取记忆失败");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <div className={styles.stickyHead}>
          <header className={styles.header}>
            <div>
              <p className={styles.eyebrow}>Home Robot 的长期记忆</p>
              <h1>由 API 决定留下什么</h1>
              <p>每轮对话后自动判断、去重和过期，页面只展示结果。</p>
            </div>
            <nav aria-label="主要页面">
              <Link href="/">聊天</Link>
              <span>记忆</span>
              <Link href="/journal">日记</Link>
              <Link href="/letters">信件</Link>
            </nav>
          </header>

          <nav className={styles.filters} aria-label="记忆筛选">
            {([
              ["all", "全部"],
              ["confirmed", "已保留"],
              ["rejected", "已忽略"],
            ] as const).map(([value, label]) => (
              <button
                className={status === value ? styles.activeFilter : ""}
                key={value}
                onClick={() => setStatus(value)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        {governance ? (
          <div className={styles.governanceBar}>
            <strong>API 自动管理</strong>
            <span>已保留 {governance.confirmed}</span>
            <span>已归档 {governance.governed}</span>
            <span>待处理 {governance.candidates}</span>
          </div>
        ) : null}

        {error ? <p className={styles.error}>{error}</p> : null}
        {loading ? <p className={styles.empty}>正在读取记忆…</p> : null}
        {!loading && memories.length === 0 ? (
          <p className={styles.empty}>这里还没有符合保留条件的记忆。</p>
        ) : null}
        <div className={styles.list}>
          {memories.map((memory) => (
            <article className={styles.card} key={memory.id}>
              <div className={styles.meta}>
                <span>{CATEGORY_LABELS[memory.category]}</span>
                <span>{STATUS_LABELS[memory.status]}</span>
                {memory.sensitive ? <span className={styles.sensitive}>敏感</span> : null}
              </div>
              <p className={styles.memoryText}>{displayText(memory.content)}</p>
              {memory.governanceReason ? (
                <p className={styles.governanceReason}>{memory.governanceReason}</p>
              ) : null}
              {memory.sourceExcerpt ? (
                <details className={styles.source}>
                  <summary>查看来源</summary>
                  <pre>{displayText(memory.sourceExcerpt)}</pre>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
