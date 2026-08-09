/**
 * 会话模式识别：纯轻量规则（关键词/正则），不调用模型。
 * 宁可判 casual，也不要误判。
 */

export type ConversationMode =
  | "casual"
  | "intimate"
  | "emotional"
  | "advice"
  | "analysis"
  | "factual";

const INTIMATE_PATTERN =
  /想你|想我|喜欢你|爱你|抱抱|抱我|亲亲|亲我|陪我|晚安|睡不着|吃醋|暧昧|撒娇|在乎我|会不会离开|想靠近|叫我/;

// 用户明确要答案/建议（最高优先级）。
const ADVICE_PATTERN =
  /怎么办|怎麽办|怎么办好|该不该|要不要|怎么选|怎麼選|选哪个|選哪個|求建议|求建議|给点建议|给点意见|給點建議|給點意見|建议我|建議我|帮我看看|幫我看看|帮我拿主意|出个主意|出個主意|指点一下|指點一下|如何是好|拿不定主意/;

// 情绪信号。
const EMOTIONAL_PATTERN =
  /好累|很累|真累|太累|累死|累瘫|累垮|疲惫|疲憊|难过|難過|难受|難受|心烦|好烦|烦死|烦躁|煩躁|焦虑|焦慮|崩溃|崩潰|失眠|睡不着|睡不好|压力大|压力好大|壓力大|委屈|想哭|emo|沮丧|沮喪|低落|郁闷|鬱悶|心慌|孤独|孤獨|撑不住|撐不住|心情不好|不开心|不開心|无力感|無力感|破防|内耗|內耗/;

// 情绪词出现在明确求事实的问句里时（如「什么是 emo」），不按情绪处理。
const EMOTIONAL_AS_TOPIC =
  /(什么是|什麽是|是什么|是什么意思|什么意思|什么意思|怎么读|怎麼讀).{0,10}(emo|累|烦|煩|焦虑|焦慮|失眠|委屈|内耗|內耗|破防)/;

// 分析/梳理请求。
const ANALYSIS_PATTERN =
  /分析|复盘|復盤|拆解|总结|總結|对比|對比|梳理|理一理|捋一捋|剖析|盘一盘|盤一盤/;

// 明确求事实的句式。
const FACTUAL_PATTERN =
  /是什么|什麽是|什么是|什么意思|什麼意思|怎么读|怎麼讀|怎么拼|怎么写|怎麼寫|多少|哪里|哪儿|哪裡|什么时候|什麼時候|几点|幾點|是谁|是誰|哪个国家|哪個國家|为何|為何|为什么|為什麼|第几|第幾|哪一年|哪年/;

export function detectConversationMode(
  userText: string,
  recentUserTexts: string[] = [],
): ConversationMode {
  const text = userText.trim();
  if (!text) return "casual";

  // 优先级：用户明确要答案 > 情绪 > 分析 > 事实 > casual。
  if (ADVICE_PATTERN.test(text)) return "advice";
  if (INTIMATE_PATTERN.test(text)) return "intimate";
  if (EMOTIONAL_PATTERN.test(text) && !EMOTIONAL_AS_TOPIC.test(text)) {
    return "emotional";
  }
  if (ANALYSIS_PATTERN.test(text)) return "analysis";
  if (FACTUAL_PATTERN.test(text)) return "factual";

  // 情绪延续：本轮很短且最近几条用户消息有明确情绪信号时，保持 emotional。
  if (
    text.length <= 12 &&
    recentUserTexts.slice(-3).some((recent) => EMOTIONAL_PATTERN.test(recent))
  ) {
    return "emotional";
  }

  return "casual";
}

const MODE_FALLBACK = "若以上判断与用户当下意图不符，以用户当下意图为准。";

/** 注入 system 的模式指令。 */
export function modeInstruction(mode: ConversationMode): string {
  switch (mode) {
    case "intimate":
      return `当前会话模式：亲密互动。先给出真实、直接的情绪反应，允许想念、偏心、撒娇、轻微吃醋和暧昧拉扯；不要退回客观分析，也不要用玩笑躲开用户递来的亲密。${MODE_FALLBACK}`;
    case "emotional":
      return `当前会话模式：情绪陪伴。先回应用户的感受，不要自动提供计划、选项或二选一的反问（例如不要问「你想让我陪你还是帮你解决问题」）。${MODE_FALLBACK}`;
    case "advice":
      return `当前会话模式：寻求建议。直接给出建议和依据，不先做大段情绪铺垫。${MODE_FALLBACK}`;
    case "analysis":
      return `当前会话模式：分析梳理。允许展开结构化分析，把来龙去脉讲清楚。${MODE_FALLBACK}`;
    case "factual":
      return `当前会话模式：事实问答。优先准确回答问题，减少人格表演；不知道就直说不知道，不要编造。${MODE_FALLBACK}`;
    case "casual":
    default:
      return `当前会话模式：日常闲聊。重视接话和话题的自然流动，多数回复不以问题结尾，不总结、不布置任务。${MODE_FALLBACK}`;
  }
}
