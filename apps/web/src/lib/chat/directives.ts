import { randomUUID } from "node:crypto";
import { conversationKey, getChatStateDb } from "./state-db";

/**
 * 当场纠正 / 风格要求：用规则识别用户消息里的即时指令，
 * 存入本地 SQLite，之后每轮把最近最多 5 条作为最高优先级块注入 system。
 * 纯规则模板映射，不调用模型。
 */

const DIRECTIVE_RULES: { pattern: RegExp; directive: string }[] = [
  {
    pattern: /说话.{0,4}生硬|好生硬|太生硬|很生硬|有点生硬|有點生硬/,
    directive: "用户要求：说话不要生硬，像朋友一样自然",
  },
  {
    pattern: /别(再)?(这么|這麼|那样|那樣)?问|不要(再)?问|別(再)?問|别盘问|別盤問|少问点|少問點/,
    directive: "用户要求：不要连续提问或盘问，顺着话题自然接话",
  },
  {
    pattern: /直接说|直接說|有话直说|有話直說/,
    directive: "用户要求：直接说结论，不要绕弯子",
  },
  {
    pattern: /别给我计划|別給我計劃|不要计划|不要計劃|别列计划|別列計劃|不用计划|不用計劃/,
    directive: "用户要求：不要给计划或行动清单，先陪着聊",
  },
  {
    pattern: /话题终结者|話題終結者|把天聊死/,
    directive: "用户要求：回复要有来有回，不要把话题聊死",
  },
  {
    pattern: /别(再)?打卡|別(再)?打卡|不要打卡/,
    directive: "用户要求：不要用打卡、任务式的说法",
  },
  {
    pattern: /别总结|別總結|不要总结|不要總結|不用总结|不用總結/,
    directive: "用户要求：不要总结收尾，顺着聊下去",
  },
  {
    pattern: /不用说教|不用說教|别说教|別說教|不要说教|不要說教|别讲道理|別講道理/,
    directive: "用户要求：不要说教或讲大道理",
  },
  {
    pattern: /别升华|別升華|不要升华|不用升华/,
    directive: "用户要求：不要把普通对话升华成关系意义",
  },
];

/** 从一条用户消息中识别出的当场纠正/风格要求。 */
export function extractDirectives(userText: string): string[] {
  const text = userText.trim();
  if (!text) return [];
  const found: string[] = [];
  for (const rule of DIRECTIVE_RULES) {
    if (rule.pattern.test(text) && !found.includes(rule.directive)) {
      found.push(rule.directive);
    }
  }
  return found;
}

/** 把指令写入本地库（同会话同文本去重），返回本次新存入的指令。 */
export function recordDirectives(
  conversationId: string | null,
  directives: string[],
  sourceMessageId?: string | null,
): string[] {
  if (directives.length === 0) return [];
  const db = getChatStateDb();
  const key = conversationKey(conversationId);
  const now = new Date().toISOString();
  const insert = db.prepare(`
    insert or ignore into conversation_directives (
      id, conversation_id, directive, source_message_id, created_at
    ) values (?, ?, ?, ?, ?)
  `);
  const stored: string[] = [];
  for (const directive of directives) {
    const result = insert.run(
      randomUUID(),
      key,
      directive,
      sourceMessageId ?? null,
      now,
    );
    if (result.changes > 0) stored.push(directive);
  }
  return stored;
}

/** 识别 + 入库一步完成；存储失败时静默降级。 */
export function detectAndRecordDirectives(
  conversationId: string | null,
  userText: string,
  sourceMessageId?: string | null,
): string[] {
  const directives = extractDirectives(userText);
  if (directives.length === 0) return [];
  try {
    recordDirectives(conversationId, directives, sourceMessageId);
  } catch {
    // 存储失败不影响聊天，本轮仍可使用识别到的指令。
  }
  return directives;
}

/** 取该会话最近最多 limit 条指令（按时间倒序）。 */
export function listConversationDirectives(
  conversationId: string | null,
  limit = 5,
): string[] {
  try {
    const rows = getChatStateDb()
      .prepare(`
        select directive from conversation_directives
        where conversation_id = ?
        order by created_at desc
        limit ?
      `)
      .all(conversationKey(conversationId), Math.max(1, limit)) as unknown as {
      directive: string;
    }[];
    return rows.map((row) => row.directive);
  } catch {
    return [];
  }
}
