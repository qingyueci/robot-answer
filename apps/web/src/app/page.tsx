"use client";

import { useChat } from "@ai-sdk/react";
import {
  ArrowClockwise,
  ArrowUp,
  ChatsCircle,
  Circle,
  PencilSimple,
  Plus,
  Sparkle,
  Trash,
  X,
} from "@phosphor-icons/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_TOPIC_DELAY_MS,
  shouldScheduleAutoTopic,
} from "@/lib/companion/state-policy";
import {
  createChatConversation,
  deleteChatConversation,
  listChatConversations,
  loadChatSession,
  openChatSession,
  renameChatConversation,
  saveChatMessage,
  titleConversationFromFirstMessage,
  type ChatConversation,
} from "@/lib/supabase/chat-store";
import styles from "./page.module.css";

type StorageStatus = "starting" | "local" | "ready" | "saving" | "error";
type MemoryStatus = "idle" | "working" | "updated" | "candidate" | "offline";
type FeedbackStatus = "saving" | "saved" | "error";

const REASONING_STYLE_CACHE_KEY = "robot.home-robot.reasoning-style.v1";

function readReasoningStyleCache() {
  try {
    return JSON.parse(localStorage.getItem(REASONING_STYLE_CACHE_KEY) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function writeReasoningStyleCache(cache: Record<string, string>) {
  const recent = Object.fromEntries(Object.entries(cache).slice(-100));
  localStorage.setItem(REASONING_STYLE_CACHE_KEY, JSON.stringify(recent));
  return recent;
}

function messageText(parts: Array<{ type: string; text?: string }>) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function reasoningText(parts: Array<{ type: string; text?: string }>) {
  return parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("");
}

function messageBubbleTexts(message: UIMessage, text: string) {
  if (!text) return [];
  const metadata = message.metadata as
    | { bubbleLayout?: "single" | "split" }
    | undefined;
  const hasDeepReasoning = message.parts.some((part) => part.type === "reasoning");
  if (metadata?.bubbleLayout === "single" || hasDeepReasoning) return [text];

  const bubbles = text
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return bubbles.length > 0 ? bubbles : [text];
}

function displayConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [storageStatus, setStorageStatus] =
    useState<StorageStatus>("starting");
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus>("idle");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<
    Record<string, FeedbackStatus>
  >({});
  const [styledReasoning, setStyledReasoning] = useState<Record<string, string>>(
    {},
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationIdRef = useRef<string | null>(null);
  const messagesRef = useRef<UIMessage[]>([]);
  const inputRef = useRef("");
  const reasoningStyleCacheRef = useRef<Record<string, string>>({});
  const reasoningStyleReadyRef = useRef(false);
  const reasoningStyleRequestedRef = useRef(new Set<string>());
  const autoTopicTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transportRef = useRef<DefaultChatTransport<UIMessage> | null>(null);

  const clearAutoTopicTimer = useCallback(() => {
    if (autoTopicTimerRef.current) {
      clearTimeout(autoTopicTimerRef.current);
      autoTopicTimerRef.current = null;
    }
  }, []);

  if (!transportRef.current) {
    transportRef.current = new DefaultChatTransport<UIMessage>({
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages,
          conversationId: conversationIdRef.current,
        },
      }),
    });
  }

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listChatConversations());
    } catch {
      // 会话列表失败不影响当前聊天。
    }
  }, []);

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    error,
    regenerate,
    clearError,
  } = useChat({
    transport: transportRef.current,
    onError: () => {
      setStorageStatus((current) => (current === "saving" ? "error" : current));
    },
    onFinish: async ({ message, messages: finishedMessages, isError }) => {
      const currentConversationId = conversationIdRef.current;
      if (!isError && currentConversationId) {
        setStorageStatus("saving");
        try {
          await saveChatMessage(currentConversationId, message);
          setStorageStatus("ready");
          await refreshConversations();
        } catch {
          setStorageStatus("error");
        }
      }

      if (isError || !messageText(message.parts).trim()) return;

      setMemoryStatus("working");
      const recentMessages = finishedMessages.slice(-8).map((item) => ({
        id: item.id,
        role: item.role,
        content: messageText(item.parts),
      }));

      try {
        const response = await fetch("/api/post-turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: currentConversationId,
            turnId: message.id,
            messages: recentMessages,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error("后台整理失败");
        const result = (await response.json()) as {
          ok?: boolean;
          confirmed?: number;
          candidates?: number;
        };
        if (!result.ok) throw new Error("后台整理暂时离线");
        setMemoryStatus(
          result.candidates
            ? "candidate"
            : result.confirmed
              ? "updated"
              : "idle",
        );
      } catch {
        setMemoryStatus("offline");
      }

      const assistantText = messageText(message.parts);
      const lastUserText = [...finishedMessages]
        .reverse()
        .find((item) => item.role === "user");
      if (shouldScheduleAutoTopic(
        lastUserText ? messageText(lastUserText.parts) : "",
        assistantText,
      )) {
        clearAutoTopicTimer();
        autoTopicTimerRef.current = setTimeout(async () => {
          if (
            document.visibilityState !== "visible" ||
            inputRef.current.trim() ||
            messagesRef.current.at(-1)?.id !== message.id
          ) {
            return;
          }

          try {
            const response = await fetch("/api/follow-up", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                mode: "auto-topic",
                messages: recentMessages,
              }),
              signal: AbortSignal.timeout(60_000),
            });
            if (!response.ok) return;
            const result = (await response.json()) as {
              followUp: { text: string } | null;
            };
            if (
              !result.followUp?.text ||
              inputRef.current.trim() ||
              messagesRef.current.at(-1)?.id !== message.id
            ) {
              return;
            }

            const autoTopic: UIMessage = {
              id: crypto.randomUUID(),
              role: "assistant",
              parts: [{ type: "text", text: result.followUp.text }],
            };
            const nextMessages = [...messagesRef.current, autoTopic];
            messagesRef.current = nextMessages;
            setMessages(nextMessages);
            if (currentConversationId) {
              await saveChatMessage(currentConversationId, autoTopic);
            }
          } catch {
            // 自动换话题失败不影响当前聊天。
          }
        }, AUTO_TOPIC_DELAY_MS);
      }
    },
  });

  const busy = status === "submitted" || status === "streaming";
  const storageReady = storageStatus !== "starting";

  const statusSentence = (() => {
    if (busy) return "Home Robot 正在回你。";
    if (storageStatus === "starting") return "正在接续上次的对话。";
    if (storageStatus === "saving") return "正在保存这段对话。";
    if (storageStatus === "error") return "保存暂时未连接，消息仍留在当前页面。";
    if (memoryStatus === "working") return "对话已保存，正在整理值得记住的部分。";
    if (memoryStatus === "candidate") return "对话已保存，API 正在整理记忆。";
    if (memoryStatus === "offline") return "对话已保存，后台整理暂时离线。";
    if (memoryStatus === "updated") return "对话已保存，长期记忆已更新。";
    if (storageStatus === "local") return "当前为本地临时会话。";
    return "对话已保存。";
  })();

  useEffect(() => {
    let cancelled = false;

    openChatSession()
      .then(async (session) => {
        if (cancelled) return;
        conversationIdRef.current = session.conversationId;
        setConversationId(session.conversationId);
        setMessages(session.messages);

        // ponytail: 只在打开聊天页时领取回访；关页推送留给以后真正的通知通道。
        try {
          const response = await fetch("/api/follow-up", {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) {
            const result = (await response.json()) as {
              followUp: { text: string } | null;
            };
            if (result.followUp?.text) {
              const followUp: UIMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                parts: [{ type: "text", text: result.followUp.text }],
              };
              setMessages([...session.messages, followUp]);
              if (session.conversationId) {
                await saveChatMessage(session.conversationId, followUp);
              }
            }
          }
        } catch {
          // 主动回访失败不影响正常打开聊天。
        }

        setStorageStatus(session.persistence === "ready" ? "ready" : "local");
        await refreshConversations();
      })
      .catch(() => {
        if (!cancelled) setStorageStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [refreshConversations, setMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const cache = readReasoningStyleCache();
    reasoningStyleCacheRef.current = cache;
    reasoningStyleReadyRef.current = true;
    setStyledReasoning(cache);
  }, []);

  useEffect(() => {
    if (!reasoningStyleReadyRef.current || busy) return;

    const message = messages.findLast((item) => item.role === "assistant");
    if (!message) return;
    const reasoning = reasoningText(message.parts);
    if (
      !reasoning ||
      reasoningStyleCacheRef.current[message.id] ||
      reasoningStyleRequestedRef.current.has(message.id)
    ) {
      return;
    }

    reasoningStyleRequestedRef.current.add(message.id);
    void fetch("/api/reasoning-style", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning, reply: messageText(message.parts) }),
      signal: AbortSignal.timeout(45_000),
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { text?: string | null };
      })
      .then((result) => {
        const text = result?.text?.trim();
        if (!text) return;
        const cache = writeReasoningStyleCache({
          ...reasoningStyleCacheRef.current,
          [message.id]: text,
        });
        reasoningStyleCacheRef.current = cache;
        setStyledReasoning(cache);
      })
      .catch(() => undefined);
  }, [busy, messages]);

  useEffect(() => {
    inputRef.current = input;
    if (input.trim()) clearAutoTopicTimer();
  }, [clearAutoTopicTimer, input]);

  useEffect(() => clearAutoTopicTimer, [clearAutoTopicTimer]);

  async function submit() {
    const text = input.trim();
    if (!text || busy || !storageReady) return;

    clearAutoTopicTimer();

    const userId = crypto.randomUUID();
    const currentConversationId = conversationIdRef.current;
    const userMessage: UIMessage = {
      id: userId,
      role: "user",
      parts: [{ type: "text", text }],
    };

    setInput("");
    requestAnimationFrame(() => textareaRef.current?.focus());
    clearError();

    if (currentConversationId) {
      setStorageStatus("saving");
      try {
        // 先保存用户消息，模型失败或浏览器关闭时也不会丢失。
        await saveChatMessage(currentConversationId, userMessage);
        await titleConversationFromFirstMessage(currentConversationId, text);
        setStorageStatus("ready");
        await refreshConversations();
      } catch {
        setStorageStatus("error");
      }
    }

    // AI SDK 的 messageId 表示“替换已有消息”；新消息必须直接传完整对象。
    await sendMessage(userMessage);
  }

  async function startNewConversation() {
    if (busy || sessionBusy) return;
    setSessionBusy(true);
    try {
      const session = await createChatConversation();
      conversationIdRef.current = session.conversationId;
      setConversationId(session.conversationId);
      setMessages([]);
      clearError();
      setMemoryStatus("idle");
      setStorageStatus(session.persistence === "ready" ? "ready" : "local");
      setSessionsOpen(false);
      await refreshConversations();
    } finally {
      setSessionBusy(false);
    }
  }

  async function switchConversation(id: string) {
    if (id === conversationId || busy || sessionBusy) {
      setSessionsOpen(false);
      return;
    }
    setSessionBusy(true);
    try {
      const session = await loadChatSession(id);
      conversationIdRef.current = session.conversationId;
      setConversationId(session.conversationId);
      setMessages(session.messages);
      clearError();
      setMemoryStatus("idle");
      setStorageStatus("ready");
      setSessionsOpen(false);
    } catch {
      setStorageStatus("error");
    } finally {
      setSessionBusy(false);
    }
  }

  async function saveConversationTitle(id: string) {
    const title = editingTitle.trim();
    if (!title) return;
    setSessionBusy(true);
    try {
      await renameChatConversation(id, title);
      setEditingId(null);
      setEditingTitle("");
      await refreshConversations();
    } finally {
      setSessionBusy(false);
    }
  }

  async function removeConversation(id: string) {
    if (busy || sessionBusy) return;
    const target = conversations.find((item) => item.id === id);
    if (!window.confirm(`删除“${target?.title ?? "这段对话"}”？删除后无法恢复。`)) {
      return;
    }

    setSessionBusy(true);
    try {
      await deleteChatConversation(id);
      const remaining = conversations.filter((item) => item.id !== id);
      if (id === conversationId) {
        const session = remaining[0]
          ? await loadChatSession(remaining[0].id)
          : await createChatConversation();
        conversationIdRef.current = session.conversationId;
        setConversationId(session.conversationId);
        setMessages(session.messages);
      }
      await refreshConversations();
    } finally {
      setSessionBusy(false);
    }
  }

  async function markReplyAsStiff(messageId: string) {
    if (feedbackStatus[messageId] === "saving") return;
    setFeedbackStatus((current) => ({ ...current, [messageId]: "saving" }));
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          messageId,
          kind: "stiff",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("反馈保存失败");
      setFeedbackStatus((current) => ({ ...current, [messageId]: "saved" }));
    } catch {
      setFeedbackStatus((current) => ({ ...current, [messageId]: "error" }));
    }
  }

  const currentConversationTitle =
    conversations.find((item) => item.id === conversationId)?.title ??
    (messages.length > 0 ? "正在继续的对话" : "新的对话");
  const assistantMessageCount = messages.filter(
    (message) => message.role === "assistant",
  ).length;

  return (
    <main className={styles.page}>
      <aside
        className={`${styles.sidebar} ${sessionsOpen ? styles.sidebarOpen : ""}`}
        aria-label="对话列表"
      >
        <div className={styles.brandRow}>
          <div className={styles.brand}>
            <h1>Home Robot</h1>
            <p>偏心地陪你</p>
          </div>
          <button
            aria-label="关闭对话列表"
            className={styles.closeSidebar}
            onClick={() => setSessionsOpen(false)}
            type="button"
          >
            <X size={19} />
          </button>
        </div>

        <button
          className={styles.newConversation}
          disabled={busy || sessionBusy}
          onClick={() => void startNewConversation()}
          type="button"
        >
          <Plus size={17} />
          新对话
        </button>

        <div className={styles.sessionSection}>
          <p className={styles.sessionHeading}>今天与更早</p>
          <div className={styles.sessionList}>
            {conversations.map((item) => (
              <div
                className={`${styles.sessionItem} ${
                  item.id === conversationId ? styles.currentSession : ""
                }`}
                key={item.id}
              >
                {editingId === item.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveConversationTitle(item.id);
                    }}
                  >
                    <input
                      aria-label="对话标题"
                      autoFocus
                      maxLength={120}
                      onChange={(event) =>
                        setEditingTitle(event.currentTarget.value)
                      }
                      value={editingTitle}
                    />
                    <button disabled={sessionBusy} type="submit">
                      保存
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className={styles.sessionMain}
                      disabled={sessionBusy}
                      onClick={() => void switchConversation(item.id)}
                      type="button"
                    >
                      <span>{item.title}</span>
                      <time>{displayConversationTime(item.updatedAt)}</time>
                    </button>
                    <div className={styles.sessionActions}>
                      <button
                        aria-label={`重命名 ${item.title}`}
                        onClick={() => {
                          setEditingId(item.id);
                          setEditingTitle(item.title);
                        }}
                        type="button"
                      >
                        <PencilSimple size={14} />
                      </button>
                      <button
                        aria-label={`删除 ${item.title}`}
                        onClick={() => void removeConversation(item.id)}
                        type="button"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        <p className={styles.sidebarFoot}>
          拾起未说完的话，
          <br />
          也收藏沉默里的微光。
        </p>
      </aside>

      {sessionsOpen ? (
        <button
          aria-label="关闭对话列表"
          className={styles.mobileBackdrop}
          onClick={() => setSessionsOpen(false)}
          type="button"
        />
      ) : null}

      <section className={styles.chatPane} aria-label="中文聊天窗口">
        <header className={styles.header}>
          <button
            className={styles.sessionButton}
            onClick={() => setSessionsOpen(true)}
            type="button"
          >
            <ChatsCircle aria-hidden="true" size={19} />
            对话
          </button>
          <nav className={styles.navigation} aria-label="主要页面">
            <span className={styles.activeNav}>聊天</span>
            <Link href="/memories">记忆</Link>
            <Link href="/journal">日记</Link>
            <Link href="/letters">信件</Link>
          </nav>
        </header>

        <div className={styles.conversationTitle}>
          <p>当前对话</p>
          <h2>{currentConversationTitle}</h2>
          <span>{statusSentence}</span>
        </div>

        <div className={styles.messages} aria-live="polite">
          {messages.length === 0 ? (
            <div className={styles.welcome}>
              <p className={styles.welcomeEyebrow}>今天，也想和你待一会儿</p>
              <h2>过来，和我说说。</h2>
              <p>不用想好怎么开口。你说第一句，剩下的我陪你慢慢说。</p>
              <Sparkle aria-hidden="true" size={16} weight="fill" />
            </div>
          ) : (
            <div className={styles.messageColumn}>
              {messages.map((message) => {
                const text = messageText(message.parts);
                const reasoning = reasoningText(message.parts);
                const isUser = message.role === "user";
                const bubbles = isUser ? [text] : messageBubbleTexts(message, text);
                return (
                  <article
                    className={`${styles.message} ${
                      isUser ? styles.messageUser : styles.messageAssistant
                    }`}
                    key={message.id}
                  >
                    <div className={styles.messageMeta}>
                      <p className={styles.speaker}>{isUser ? "你" : "Home Robot"}</p>
                      <span>{isUser ? "此刻的想法" : "回应"}</span>
                    </div>
                    {!isUser && reasoning ? (
                      <details
                        className={styles.reasoning}
                        open={message.parts.some(
                          (part) =>
                            part.type === "reasoning" && part.state === "streaming",
                        )}
                      >
                        <summary>Home Robot 刚才在想</summary>
                        <div>
                          {styledReasoning[message.id] ??
                            (busy
                              ? "嗯，让我顺着你刚才的话再想一想……"
                              : "我在把刚才的思路整理成更自然的说法……")}
                        </div>
                      </details>
                    ) : null}
                    <div className={isUser ? undefined : styles.assistantReply}>
                      {!isUser ? (
                        <img
                          alt="Home Robot"
                          className={styles.avatar}
                          src="/home-robot-avatar.png"
                        />
                      ) : null}
                      <div className={styles.bubbleStack}>
                        {bubbles.map((bubble, index) => (
                          <div className={styles.bubble} key={`${message.id}-${index}`}>
                            {bubble}
                          </div>
                        ))}
                      </div>
                    </div>
                    {!isUser && text ? (
                      <button
                        className={styles.replyFeedback}
                        disabled={feedbackStatus[message.id] === "saving"}
                        onClick={() => void markReplyAsStiff(message.id)}
                        type="button"
                      >
                        {feedbackStatus[message.id] === "saved"
                          ? "已记下，会调整"
                          : feedbackStatus[message.id] === "error"
                            ? "没保存上，再试一次"
                            : "这句有点生硬"}
                      </button>
                    ) : null}
                  </article>
                );
              })}
              {status === "submitted" ? (
                <div className={styles.typingRow} aria-label="Home Robot 正在输入">
                  <img
                    alt=""
                    aria-hidden="true"
                    className={styles.avatar}
                    src="/home-robot-avatar.png"
                  />
                  <div className={styles.typingBubble}>
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className={styles.composerArea}>
          <p className={styles.composerLabel}>想对我说什么</p>
          {error ? (
            <div className={styles.errorRow}>
              <p className={styles.error}>消息没有送达：{error.message}</p>
              <button
                disabled={busy}
                onClick={() => {
                  clearError();
                  void regenerate();
                }}
                type="button"
              >
                <ArrowClockwise aria-hidden="true" size={15} />
                重试
              </button>
            </div>
          ) : null}
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <textarea
              aria-label="发送给 Home Robot 的消息"
              className={styles.textarea}
              disabled={!storageReady}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="说点什么，我在听……"
              ref={textareaRef}
              rows={1}
              value={input}
            />
            <button
              aria-label="发送消息"
              className={styles.sendButton}
              disabled={!input.trim() || busy || !storageReady}
              type="submit"
            >
              <ArrowUp size={21} weight="regular" />
            </button>
          </form>
          <div className={styles.composerMeta}>
            <span>Enter 发送，Shift + Enter 换行</span>
            <span className={styles.systemStatus}>
              <Circle aria-hidden="true" size={6} weight="fill" />
              {statusSentence}
            </span>
          </div>
        </div>
      </section>

      <aside className={styles.contextPanel} aria-label="对话侧记">
        <section>
          <p className={styles.contextEyebrow}>此刻</p>
          <blockquote>“先把这一句话说完，其余的可以慢一点。”</blockquote>
        </section>
        <section>
          <p className={styles.contextEyebrow}>本次对话</p>
          <dl>
            <div>
              <dt>消息</dt>
              <dd>{messages.length} 条</dd>
            </div>
            <div>
              <dt>Home Robot 回应</dt>
              <dd>{assistantMessageCount} 次</dd>
            </div>
            <div>
              <dt>保存状态</dt>
              <dd>{storageStatus === "local" ? "本地" : "已接续"}</dd>
            </div>
          </dl>
        </section>
        <section>
          <p className={styles.contextEyebrow}>写给今天</p>
          <p className={styles.contextPrompt}>
            如果只留下一句话，今天的你最希望被记住什么？
          </p>
          <Link className={styles.journalLink} href="/journal">
            去看看日记 →
          </Link>
        </section>
      </aside>
    </main>
  );
}
