/**
 * 各题型满分的「唯一来源」。
 *
 * 为什么要有这个文件：这几个数字原先散在 4 个地方（掌握率图、得分率图、
 * 学科素养雷达图的分母、AI 学情分析的提示词），改一处漏一处，
 * 直接导致百分比算错 —— 现代文满分就曾经在两处之间对不上。
 * 以后调整满分，只改下面这一处。
 *
 * 口径（2026-10-08 经王老师确认）：
 *   选择题 25 / 现代文阅读 35 / 文言文阅读 20 / 默写填空 10 / 作文 60
 *   合计 150，与卷面总分一致。
 *
 * 注意：「非连续性文本」不是独立板块，它的分数并入「现代文阅读 35 分」。
 * 但 Excel 导入模板里仍保留那一列，所以统计时要把两列加起来，
 * 已录入的数据才不会被丢掉 —— 见下面的 modernReadingTotal()。
 */
export const SCORE_MAX = {
  choice: 25,
  modernReading: 35,
  classicReading: 20,
  dictation: 10,
  composition: 60,
};

/** 六项加总的卷面满分 = 150 */
export const TOTAL_MAX =
  SCORE_MAX.choice +
  SCORE_MAX.modernReading +
  SCORE_MAX.classicReading +
  SCORE_MAX.dictation +
  SCORE_MAX.composition;

/**
 * 现代文阅读的实际得分。
 * Excel 里「现代文阅读」和「非连续性文本」是两列，但非连续性属于现代文，
 * 统计口径上必须合并（满分也共用现代文的 35 分）。
 */
export const modernReadingTotal = (s: any): number =>
  (Number(s?.modernReading) || 0) + (Number(s?.nonLinear) || 0);

export interface ScoreItem {
  label: string;
  max: number;
  get: (s: any) => number;
}

/**
 * 卷面各分项（顺序即展示顺序）。
 * 两张图表都从这里取，不要再各自写一份 —— 那正是口径走样的原因。
 */
export const SCORE_ITEMS: ScoreItem[] = [
  { label: '选择题', max: SCORE_MAX.choice, get: (s) => Number(s?.choice) || 0 },
  { label: '现代文阅读', max: SCORE_MAX.modernReading, get: modernReadingTotal },
  { label: '文言文阅读', max: SCORE_MAX.classicReading, get: (s) => Number(s?.classicReading) || 0 },
  { label: '默写填空', max: SCORE_MAX.dictation, get: (s) => Number(s?.dictation) || 0 },
  { label: '作文', max: SCORE_MAX.composition, get: (s) => Number(s?.composition) || 0 },
];

/** 学科素养雷达图各组的分母：按上面的满分推导，不要在这里再写死数字 */
export const LITERACY_MAX = {
  /** 语言建构 = 选择题 + 默写填空 */
  language: SCORE_MAX.choice + SCORE_MAX.dictation,
  /** 思维发展 = 现代文阅读（含非连续性文本） */
  thinking: SCORE_MAX.modernReading,
  /** 审美鉴赏 = 作文 */
  aesthetics: SCORE_MAX.composition,
  /** 文化传承 = 文言文阅读 */
  culture: SCORE_MAX.classicReading,
  /** 表达创作 = 作文 + 现代文阅读（含非连续性文本） */
  expression: SCORE_MAX.composition + SCORE_MAX.modernReading,
};
