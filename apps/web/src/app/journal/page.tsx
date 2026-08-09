"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JournalEntry, OpenTopic, RelationshipState } from "@/lib/companion/types";
import styles from "./page.module.css";

type JournalData = {
  relationship: RelationshipState;
  entries: JournalEntry[];
  topics: OpenTopic[];
  governance: { journalDuplicates: number; topicDuplicates: number };
};

function displayDay(day: string) {
  const date = new Date(`${day}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
}

function displayText(value: string) {
  return value.replaceAll("观棋", "你");
}

export default function JournalPage() {
  const [data, setData] = useState<JournalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/journal", { cache: "no-store" });
      if (!response.ok) throw new Error("读取日记失败");
      setData((await response.json()) as JournalData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取日记失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeTopics = useMemo(
    () => data?.topics.filter((topic) => topic.status === "active") ?? [],
    [data],
  );
  const finishedTopics = useMemo(
    () => data?.topics.filter((topic) => topic.status !== "active") ?? [],
    [data],
  );

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Home Robot 的共同记录</p>
            <h1>日记与未完话题</h1>
            <p>API 根据对话价值决定写入、合并和归档，无需手动整理。</p>
          </div>
          <nav aria-label="主要页面">
            <Link href="/">聊天</Link>
            <Link href="/memories">记忆</Link>
            <span>日记</span>
            <Link href="/letters">信件</Link>
          </nav>
        </header>

        {error ? <p className={styles.error}>{error}</p> : null}
        {loading ? <p className={styles.empty}>正在整理共同记录…</p> : null}

        {data ? (
          <>
            <section className={styles.relationship}>
              <div>
                <p className={styles.eyebrow}>当前关系</p>
                <h2>{data.relationship.stageLabel}</h2>
              </div>
              <p>{data.relationship.familiarityText}</p>
              <span className={styles.apiBadge}>API 自动管理</span>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                <div>
                  <p className={styles.eyebrow}>之后还要接着聊</p>
                  <h2>未完成话题</h2>
                </div>
                <span>{activeTopics.length} 件进行中</span>
              </div>
              {activeTopics.length === 0 ? (
                <p className={styles.empty}>现在没有悬着的话题。</p>
              ) : (
                <div className={styles.topicList}>
                  {activeTopics.map((topic) => (
                    <article className={styles.topic} key={topic.id}>
                      <p>{displayText(topic.content)}</p>
                    </article>
                  ))}
                </div>
              )}
              {finishedTopics.length > 0 ? (
                <details className={styles.finished}>
                  <summary>查看 API 已结束的话题（{finishedTopics.length}）</summary>
                  {finishedTopics.map((topic) => (
                    <div key={topic.id}><span>{displayText(topic.content)}</span></div>
                  ))}
                </details>
              ) : null}
            </section>

            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                <div>
                  <p className={styles.eyebrow}>重要片段会自动落笔</p>
                  <h2>共同日记</h2>
                </div>
                <span>{data.entries.length} 篇</span>
              </div>

              {data.entries.length === 0 ? (
                <p className={styles.empty}>还没有值得落笔的片段，普通寒暄不会写入。</p>
              ) : (
                <div className={styles.entryList}>
                  {data.entries.map((entry) => (
                    <article className={styles.entry} key={entry.id}>
                      <div className={styles.entryMeta}>
                        <time>{displayDay(entry.day)}</time>
                        {entry.mood ? <span>{entry.mood}</span> : null}
                        {entry.important ? <span>重要</span> : null}
                      </div>
                      <h3>{displayText(entry.title)}</h3>
                      <p>{displayText(entry.summary)}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
