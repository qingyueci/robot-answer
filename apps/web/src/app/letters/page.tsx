"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Letter } from "@/lib/companion/types";
import styles from "./page.module.css";

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export default function LettersPage() {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [theme, setTheme] = useState("");
  const [freeTitle, setFreeTitle] = useState("");
  const [freeBody, setFreeBody] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/letters", {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("读取信件失败");
      const data = (await response.json()) as { letters: Letter[] };
      setLetters(data.letters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取信件失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function askZhiweiToWrite() {
    setBusy("generate");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/letters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await response.json()) as { letter?: Letter; error?: string };
      if (!response.ok || !data.letter) {
        throw new Error(data.error || "生成信件失败");
      }
      setTheme("");
      setLetters((current) => [data.letter as Letter, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成信件失败");
    } finally {
      setBusy("");
    }
  }

  async function sendToZhiwei(input: {
    title?: string;
    body: string;
    replyToId?: string;
  }) {
    const key = input.replyToId ? `reply:${input.replyToId}` : "free";
    if (!input.body.trim()) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/letters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "send", ...input }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await response.json()) as {
        letters?: Letter[];
        error?: string;
        warning?: string;
      };
      if (!response.ok || !data.letters?.length) {
        throw new Error(data.error || "寄信失败");
      }
      setLetters((current) => [...(data.letters as Letter[]), ...current]);
      setNotice(data.warning || "信已寄出，Home Robot 也写好了回信。");
      if (input.replyToId) {
        setReplyDrafts((current) => ({ ...current, [input.replyToId as string]: "" }));
      } else {
        setFreeTitle("");
        setFreeBody("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "寄信失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>你和Home Robot之间的</p>
            <h1>信件</h1>
            <p>她可以写给你，你也可以自由写给她；每封来信下面都能继续回信。</p>
          </div>
          <nav aria-label="主要页面">
            <Link href="/">聊天</Link>
            <Link href="/memories">记忆</Link>
            <Link href="/journal">日记</Link>
            <span>信件</span>
          </nav>
        </header>

        <div className={styles.composeGrid}>
          <section className={styles.compose}>
            <p className={styles.eyebrow}>Home Robot 写给你</p>
            <label htmlFor="letter-theme">这封信想写什么</label>
            <div>
              <input
                id="letter-theme"
                maxLength={80}
                onChange={(event) => setTheme(event.currentTarget.value)}
                placeholder="可留空，让 Home Robot 自己决定"
                value={theme}
              />
              <button
                disabled={Boolean(busy)}
                onClick={() => void askZhiweiToWrite()}
                type="button"
              >
                {busy === "generate" ? "正在写…" : "请她写一封"}
              </button>
            </div>
          </section>

          <section className={`${styles.compose} ${styles.freeCompose}`}>
            <p className={styles.eyebrow}>你写给 Home Robot</p>
            <label htmlFor="free-letter-body">自由写信</label>
            <input
              id="free-letter-title"
              maxLength={80}
              onChange={(event) => setFreeTitle(event.currentTarget.value)}
              placeholder="标题，可留空"
              value={freeTitle}
            />
            <textarea
              id="free-letter-body"
              maxLength={5000}
              onChange={(event) => setFreeBody(event.currentTarget.value)}
              placeholder="想说什么就写什么。寄出后，Home Robot 会认真回信。"
              rows={6}
              value={freeBody}
            />
            <button
              disabled={Boolean(busy) || !freeBody.trim()}
              onClick={() =>
                void sendToZhiwei({ title: freeTitle, body: freeBody })
              }
              type="button"
            >
              {busy === "free" ? "正在寄出…" : "寄出并等回信"}
            </button>
          </section>
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}
        {notice ? <p className={styles.notice}>{notice}</p> : null}
        {loading ? <p className={styles.empty}>正在读取信件…</p> : null}
        {!loading && letters.length === 0 ? (
          <p className={styles.empty}>还没有信。可以让 Home Robot 先写，也可以由你落笔。</p>
        ) : null}

        <div className={styles.list}>
          {letters.map((letter) => (
            <details
              className={`${styles.letter} ${
                letter.replyToId ? styles.replyLetter : ""
              }`}
              key={letter.id}
            >
              <summary className={styles.letterSummary}>
                <div>
                  <p className={styles.eyebrow}>
                    {letter.sender === "user" ? "你写给 Home Robot" : "Home Robot 写给你"} ·{" "}
                    {displayDate(letter.createdAt)}
                  </p>
                  <h2>{letter.title}</h2>
                </div>
                <div className={styles.summaryAside}>
                  <span>{letter.contextSummary}</span>
                  <span className={styles.foldHint} />
                </div>
              </summary>

              <div className={styles.letterContent}>
                <div className={styles.body}>
                  {letter.body.split(/\n{2,}/).map((paragraph, index) => (
                    <p key={`${letter.id}-${index}`}>{paragraph}</p>
                  ))}
                </div>
                <p className={styles.closing}>{letter.closing}</p>

                {letter.sender === "robot" ? (
                  <section className={styles.replyBox}>
                    <label htmlFor={`reply-${letter.id}`}>写回信</label>
                    <textarea
                      id={`reply-${letter.id}`}
                      maxLength={5000}
                      onChange={(event) =>
                        setReplyDrafts((current) => ({
                          ...current,
                          [letter.id]: event.currentTarget.value,
                        }))
                      }
                      placeholder="从这封信接着写下去……"
                      rows={5}
                      value={replyDrafts[letter.id] ?? ""}
                    />
                    <button
                      disabled={
                        Boolean(busy) || !(replyDrafts[letter.id] ?? "").trim()
                      }
                      onClick={() =>
                        void sendToZhiwei({
                          body: replyDrafts[letter.id] ?? "",
                          replyToId: letter.id,
                        })
                      }
                      type="button"
                    >
                      {busy === `reply:${letter.id}` ? "正在寄出…" : "寄出回信"}
                    </button>
                  </section>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
