import type { UIMessage } from "ai";
import { getBrowserSupabase } from "./client";

const CONVERSATION_STORAGE_KEY = "robot.home-robot.conversation-id";
const LOCAL_CHAT_STORAGE_KEY = "robot.home-robot.local-chats.v1";
const DEFAULT_TITLES = new Set(["与 Home Robot 的对话", "新对话"]);
const LOCAL_CONVERSATION_PREFIX = "local:";
const SUPABASE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const SUPABASE_AUTH_TIMEOUT_MS = 3_500;
let supabaseUnavailableUntil = 0;

type StoredMessage = {
  client_message_id: string;
  role: UIMessage["role"];
  parts: UIMessage["parts"];
};

type ConversationRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatSession = {
  conversationId: string | null;
  messages: UIMessage[];
  persistence: "local" | "ready";
};

type LocalConversation = ChatConversation & {
  messages: UIMessage[];
};

function readLocalConversations(): LocalConversation[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LOCAL_CHAT_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(value) ? (value as LocalConversation[]) : [];
  } catch {
    return [];
  }
}

function writeLocalConversations(conversations: LocalConversation[]) {
  if (typeof localStorage === "undefined") return;
  // 限制本地体积，避免长时间使用后触发浏览器存储上限。
  const compact = conversations
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 50)
    .map((item) => ({ ...item, messages: item.messages.slice(-300) }));
  localStorage.setItem(LOCAL_CHAT_STORAGE_KEY, JSON.stringify(compact));
}

function isLocalConversation(id: string) {
  return id.startsWith(LOCAL_CONVERSATION_PREFIX);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Supabase 会话初始化超时")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createLocalConversation(title = "新对话"): ChatSession {
  const now = new Date().toISOString();
  const conversation: LocalConversation = {
    id: `${LOCAL_CONVERSATION_PREFIX}${crypto.randomUUID()}`,
    title: title.trim().slice(0, 120) || "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  writeLocalConversations([conversation, ...readLocalConversations()]);
  localStorage.setItem(CONVERSATION_STORAGE_KEY, conversation.id);
  return {
    conversationId: conversation.id,
    messages: [],
    persistence: "local",
  };
}

function loadLocalConversation(id: string): ChatSession {
  const conversation = readLocalConversations().find((item) => item.id === id);
  if (!conversation) throw new Error("这段本地对话不存在或已被删除");
  localStorage.setItem(CONVERSATION_STORAGE_KEY, conversation.id);
  return {
    conversationId: conversation.id,
    messages: conversation.messages,
    persistence: "local",
  };
}

function messageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function rowToConversation(row: ConversationRow): ChatConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getAuthenticatedUser() {
  const supabase = getBrowserSupabase();
  if (!supabase) return null;
  if (Date.now() < supabaseUnavailableUntil) return null;

  try {
    const { data: sessionData, error: sessionError } = await withTimeout(
      supabase.auth.getSession(),
      SUPABASE_AUTH_TIMEOUT_MS,
    );
    if (sessionError) throw sessionError;
    if (sessionData.session?.user) return sessionData.session.user;

    const { data, error } = await withTimeout(
      supabase.auth.signInAnonymously(),
      SUPABASE_AUTH_TIMEOUT_MS,
    );
    if (error) throw error;
    if (!data.user) throw new Error("Supabase 匿名登录没有返回用户");
    supabaseUnavailableUntil = 0;
    return data.user;
  } catch {
    supabaseUnavailableUntil = Date.now() + SUPABASE_RETRY_COOLDOWN_MS;
    return null;
  }
}

async function readMessages(conversationId: string) {
  const supabase = getBrowserSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("robot_messages")
    .select("client_message_id, role, parts")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => {
    const stored = row as StoredMessage;
    return {
      id: stored.client_message_id,
      role: stored.role,
      parts: stored.parts,
    } satisfies UIMessage;
  });
}

export async function listChatConversations(): Promise<ChatConversation[]> {
  const local = readLocalConversations().map(({ messages: _messages, ...item }) => item);
  const supabase = getBrowserSupabase();
  const user = await getAuthenticatedUser();
  if (!supabase || !user) return local;

  const { data, error } = await supabase
    .from("robot_conversations")
    .select("id, title, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  const remote = (data as ConversationRow[] | null)?.map(rowToConversation) ?? [];
  return [...remote, ...local].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function createChatConversation(
  title = "新对话",
): Promise<ChatSession> {
  const supabase = getBrowserSupabase();
  const user = await getAuthenticatedUser();
  if (!supabase || !user) {
    return createLocalConversation(title);
  }

  const { data, error } = await supabase
    .from("robot_conversations")
    .insert({
      user_id: user.id,
      title: title.trim().slice(0, 120) || "新对话",
      relationship_stage: "established_partner",
    })
    .select("id")
    .single();

  if (error) throw error;
  localStorage.setItem(CONVERSATION_STORAGE_KEY, data.id);
  return { conversationId: data.id, messages: [], persistence: "ready" };
}

export async function loadChatSession(
  conversationId: string,
): Promise<ChatSession> {
  if (isLocalConversation(conversationId)) {
    return loadLocalConversation(conversationId);
  }
  const supabase = getBrowserSupabase();
  const user = await getAuthenticatedUser();
  if (!supabase || !user) {
    const local = readLocalConversations()[0];
    return local ? loadLocalConversation(local.id) : createLocalConversation();
  }

  const { data, error } = await supabase
    .from("robot_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("这段对话不存在或已被删除");

  localStorage.setItem(CONVERSATION_STORAGE_KEY, data.id);
  return {
    conversationId: data.id,
    messages: await readMessages(data.id),
    persistence: "ready",
  };
}

export async function openChatSession(): Promise<ChatSession> {
  const rememberedId = localStorage.getItem(CONVERSATION_STORAGE_KEY);
  if (rememberedId && isLocalConversation(rememberedId)) {
    try {
      return loadLocalConversation(rememberedId);
    } catch {
      localStorage.removeItem(CONVERSATION_STORAGE_KEY);
    }
  }

  const supabase = getBrowserSupabase();
  const user = await getAuthenticatedUser();
  if (!supabase || !user) {
    const local = readLocalConversations()[0];
    return local ? loadLocalConversation(local.id) : createLocalConversation();
  }

  if (rememberedId) {
    try {
      return await loadChatSession(rememberedId);
    } catch {
      localStorage.removeItem(CONVERSATION_STORAGE_KEY);
    }
  }

  const conversations = await listChatConversations();
  if (conversations[0]) return loadChatSession(conversations[0].id);
  return createChatConversation();
}

export async function renameChatConversation(id: string, title: string) {
  if (isLocalConversation(id)) {
    const normalized = title.trim().slice(0, 120);
    if (!normalized) throw new Error("对话标题不能为空");
    const now = new Date().toISOString();
    writeLocalConversations(
      readLocalConversations().map((item) =>
        item.id === id ? { ...item, title: normalized, updatedAt: now } : item,
      ),
    );
    return;
  }
  const supabase = getBrowserSupabase();
  if (!supabase) return;
  const normalized = title.trim().slice(0, 120);
  if (!normalized) throw new Error("对话标题不能为空");

  const { error } = await supabase
    .from("robot_conversations")
    .update({ title: normalized })
    .eq("id", id);
  if (error) throw error;
}

export async function titleConversationFromFirstMessage(
  id: string,
  userText: string,
) {
  if (isLocalConversation(id)) {
    const local = readLocalConversations().find((item) => item.id === id);
    if (!local || !DEFAULT_TITLES.has(local.title)) return;
    const title = userText.trim().replace(/\s+/g, " ").slice(0, 28);
    if (title) await renameChatConversation(id, title);
    return;
  }
  const supabase = getBrowserSupabase();
  if (!supabase) return;

  const { data, error } = await supabase
    .from("robot_conversations")
    .select("title")
    .eq("id", id)
    .single();
  if (error) throw error;
  if (!DEFAULT_TITLES.has(data.title)) return;

  const title = userText.trim().replace(/\s+/g, " ").slice(0, 28);
  if (title) await renameChatConversation(id, title);
}

export async function deleteChatConversation(id: string) {
  if (isLocalConversation(id)) {
    writeLocalConversations(
      readLocalConversations().filter((item) => item.id !== id),
    );
    if (localStorage.getItem(CONVERSATION_STORAGE_KEY) === id) {
      localStorage.removeItem(CONVERSATION_STORAGE_KEY);
    }
    return;
  }
  const supabase = getBrowserSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("robot_conversations")
    .delete()
    .eq("id", id);
  if (error) throw error;
  if (localStorage.getItem(CONVERSATION_STORAGE_KEY) === id) {
    localStorage.removeItem(CONVERSATION_STORAGE_KEY);
  }
}

export async function saveChatMessage(
  conversationId: string,
  message: UIMessage,
) {
  if (isLocalConversation(conversationId)) {
    const now = new Date().toISOString();
    writeLocalConversations(
      readLocalConversations().map((item) => {
        if (item.id !== conversationId) return item;
        const messages = item.messages.filter(
          (existing) => existing.id !== message.id,
        );
        return { ...item, messages: [...messages, message], updatedAt: now };
      }),
    );
    return;
  }
  const supabase = getBrowserSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("robot_messages").upsert(
    {
      conversation_id: conversationId,
      client_message_id: message.id,
      role: message.role,
      content: messageText(message),
      parts: message.parts,
    },
    { onConflict: "conversation_id,client_message_id" },
  );

  if (error) throw error;
}

export async function saveChatMessages(
  conversationId: string,
  messages: UIMessage[],
) {
  if (isLocalConversation(conversationId)) {
    for (const message of messages) {
      await saveChatMessage(conversationId, message);
    }
    return;
  }
  const supabase = getBrowserSupabase();
  if (!supabase || messages.length === 0) return;

  const rows = messages.map((message) => ({
    conversation_id: conversationId,
    client_message_id: message.id,
    role: message.role,
    content: messageText(message),
    parts: message.parts,
  }));

  const { error } = await supabase
    .from("robot_messages")
    .upsert(rows, { onConflict: "conversation_id,client_message_id" });

  if (error) throw error;
}
