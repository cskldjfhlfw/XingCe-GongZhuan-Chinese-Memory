export const TAXONOMY_VERSION = 1;

export const IDIOM_TAG_GROUPS = {
  semantic: { label: '语义方向', weight: 4, values: ['态度立场', '认知判断', '言语表达', '行动执行', '方法策略', '变化发展', '风险预防', '品质作风', '关系协作', '程度范围', '结果状态', '时间条件'] },
  sentiment: { label: '感情色彩', weight: 1, values: ['褒义', '贬义', '中性'] },
  object: { label: '适用对象', weight: 2, values: ['人物行为', '观点言论', '政策制度', '局势形势', '事物状态', '方法措施', '关系合作'] },
  context: { label: '语境功能', weight: 2, values: ['提出问题', '分析原因', '提出对策', '转折批评', '递进强调', '并列承接', '总结归纳', '结果评价'] },
  exam: { label: '考试关系', weight: 1, values: ['高频搭配', '易混辨析', '近义替换', '反义对照', '常见误用', '共同出现'] },
};

export const TAG_VALUES = Object.fromEntries(Object.entries(IDIOM_TAG_GROUPS).flatMap(([group, config]) => config.values.map(value => [`${group}:${value}`, { group, value, weight: config.weight }])));

export function normalizeTags(raw = {}) {
  const tags = {};
  for (const [group, config] of Object.entries(IDIOM_TAG_GROUPS)) {
    const values = Array.isArray(raw[group]) ? raw[group] : raw[group] ? [raw[group]] : [];
    tags[group] = [...new Set(values.map(value => String(value).trim()).filter(value => config.values.includes(value)))].slice(0, group === 'sentiment' ? 1 : 4);
  }
  if (!tags.sentiment.length) tags.sentiment = ['中性'];
  return tags;
}

export function flattenTags(tags) { return Object.entries(normalizeTags(tags)).flatMap(([group, values]) => values.map(value => `${group}:${value}`)); }

export function weightedTagSimilarity(left, right) {
  if (!left || !right) return 0;
  const a = new Set(flattenTags(left));
  const b = new Set(flattenTags(right));
  const keys = new Set([...a, ...b]);
  let intersection = 0, union = 0;
  for (const key of keys) {
    const weight = TAG_VALUES[key]?.weight || 1;
    union += weight;
    if (a.has(key) && b.has(key)) intersection += weight;
  }
  return union ? intersection / union : 0;
}

export function primaryTag(tags) { return normalizeTags(tags).semantic[0] || '未分类'; }

export function tagSummary(tags) { return Object.entries(normalizeTags(tags)).flatMap(([group, values]) => values.map(value => ({ group, label: IDIOM_TAG_GROUPS[group].label, value }))); }
