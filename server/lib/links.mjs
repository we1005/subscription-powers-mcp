/** 来源链接的清洗与提取（Dot 与 Codex API 两个搜索后端共用） */

/** 去掉 OpenAI 附加的跟踪参数 utm_source=openai / chatgpt.com */
export function cleanUrl(u) {
  try { const x = new URL(u); if (/chatgpt|openai/i.test(x.searchParams.get('utm_source') ?? '')) x.searchParams.delete('utm_source'); return x.toString(); } catch { return u; }
}

/** 去掉答案正文里 markdown 链接带的 utm_source=openai（保留其它查询参数） */
export function stripTracking(text) {
  return text.replace(/([?&])utm_source=(?:openai|chatgpt\.com)(&|(?=[)\]\s"'>]|$))/g, (_, sep, amp) => (amp === '&' ? sep : ''));
}

export function extractLinks(text) {
  const out = new Map();
  for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) out.set(cleanUrl(m[2]), { title: m[1].trim(), url: cleanUrl(m[2]) });
  // 裸 URL 只取 ASCII URL 字符：中文回复里「…/releases。」的全角标点不能被吞进链接
  for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g)) { const u = cleanUrl(m[0].replace(/[.,;:!?]+$/, '')); if (!out.has(u)) out.set(u, { title: u, url: u }); }
  return [...out.values()];
}
