export function comparableText(value: string) {
  return value
    .toLocaleLowerCase("zh-CN")
    .replace(/[点吃]外卖/g, "外卖")
    .replace(/[做煮]云吞/g, "云吞")
    .replace(
      /观棋|用户|Home Robot|你|我|目前|现在|正在|尚未|表示|提到|觉得|认为|希望|想要|准备|考虑|决定|自己/g,
      "",
    )
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function bigrams(value: string) {
  const normalized = comparableText(value);
  if (!normalized) return new Set<string>();
  if (normalized.length < 2) return new Set([normalized]);
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

/** 包含系数：适合判断中文短句是否在表达同一件事。 */
export function textSimilarity(left: string, right: string) {
  const normalizedLeft = comparableText(left);
  const normalizedRight = comparableText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return 1;
  }

  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  const smaller = Math.min(leftGrams.size, rightGrams.size);
  if (smaller === 0) return 0;
  let overlap = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) overlap += 1;
  }
  return overlap / smaller;
}

function splitSentences(value: string) {
  return value
    .split(/[\n。！？!?；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 合并日记摘要时只追加真正新增的句子，避免机械重复。 */
export function mergeDistinctText(
  existing: string,
  incoming: string,
  maxLength = 800,
) {
  const kept = splitSentences(existing);
  for (const sentence of splitSentences(incoming)) {
    if (kept.some((item) => textSimilarity(item, sentence) >= 0.82)) continue;
    kept.push(sentence);
  }
  return kept.slice(0, 4).join("；").slice(0, maxLength);
}

export function compactJournalText(
  value: string,
  maxSentences = 4,
  maxLength = 520,
) {
  const kept: string[] = [];
  for (const sentence of splitSentences(value)) {
    if (kept.some((item) => textSimilarity(item, sentence) >= 0.82)) continue;
    kept.push(sentence);
    if (kept.length >= maxSentences) break;
  }
  return kept.join("；").slice(0, maxLength);
}

const TRIVIAL_TURN_PATTERN =
  /^(ok+|好(的|吧)?|行(吧)?|可以|知道了|嗯+|哦+|哈+|谢谢|谢了|早|早安|晚安|在吗|在|吃饭|睡觉|先这样|没事)[\s。.!！,，、~～?？…]*$/i;

/** 这类应答只更新互动时间，不值得消耗后台整理模型。 */
export function isTrivialUserTurn(value: string) {
  const text = value.trim();
  return !text || text.length <= 12 && TRIVIAL_TURN_PATTERN.test(text);
}

const OPPOSITE_PAIRS: Array<[RegExp, RegExp]> = [
  [/简洁|简短|少说/, /详细|展开|多说/],
  [/喜欢|偏好/, /讨厌|不喜欢|避免/],
  [/主动/, /被动/],
  [/早睡/, /熬夜|晚睡/],
  [/安静/, /热闹/],
];

/** 只识别高把握的相反表达；命中后必须交给用户确认，不能自动覆盖旧记忆。 */
export function looksContradictory(left: string, right: string) {
  return OPPOSITE_PAIRS.some(
    ([positive, negative]) =>
      (positive.test(left) && negative.test(right)) ||
      (negative.test(left) && positive.test(right)),
  );
}

const JOURNAL_THEMES: Array<[string, RegExp]> = [
  ["expression", /生硬|语气|温度|暧昧|接话|聊天方式/],
  ["trading", /同花顺|行情|被套|看盘|接早|持仓|浮亏/],
  ["classics", /道德经|老子|陈鼓应/],
  ["expectation", /初识|新相识|刚认识|期待/],
  ["food", /外卖|云吞|云吃|饭搭子/],
  ["past-relationship", /前女友|前男友|前任|分手/],
];

export function detectJournalTheme(title: string, summary: string) {
  for (const [theme, pattern] of JOURNAL_THEMES) {
    if (pattern.test(title)) return theme;
  }
  for (const [theme, pattern] of JOURNAL_THEMES) {
    if (pattern.test(summary)) return theme;
  }
  return "";
}
