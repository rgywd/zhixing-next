import { digest } from './state.mjs';
import { Buffer } from 'node:buffer';

export const FEEDS = [
  { publisher: 'NASA', url: 'https://www.nasa.gov/feed/', domains: ['nasa.gov'] },
  { publisher: 'GitHub', url: 'https://github.blog/changelog/feed/', domains: ['github.blog', 'github.com'] },
];
function plain(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
      const map = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (map[entity]) return map[entity];
      const n = entity.startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }).replace(/\s+/g, ' ').trim();
}
export function parseFeed(xml, feed, now = Date.now()) {
  const output = [];
  for (const item of xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []) {
    const value = name => plain(item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '');
    try {
      const title = value('title'), url = new URL(value('link')), time = Date.parse(value('pubDate'));
      if (url.protocol !== 'https:' || url.username || url.password || !feed.domains.some(d => url.hostname === d || url.hostname.endsWith('.' + d))) continue;
      if (!title || !Number.isFinite(time) || time > now + 300_000 || now - time > 72 * 3_600_000) continue;
      url.hash = '';
      output.push({ id: `news:${digest(url.href)}`, title: title.slice(0, 220), url: url.href,
        publisher: feed.publisher, publishedAt: new Date(time).toISOString(), summary: value('description').slice(0, 650) });
    } catch { /* Invalid entries are not news evidence. */ }
  }
  return output;
}
export async function fetchNews({ fetchImpl = fetch, now = Date.now(), feeds = FEEDS } = {}) {
  const results = await Promise.allSettled(feeds.map(async feed => {
    const response = await fetchImpl(feed.url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'ZhixingCompanion/0.1' } });
    if (!response.ok) throw new Error('News feed unavailable');
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 600_000) throw new Error('News feed exceeds size limit'); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return parseFeed(Buffer.concat(chunks).toString('utf8'), feed, now);
  }));
  return [...new Map(results.flatMap(r => r.status === 'fulfilled' ? r.value : []).map(item => [item.id, item])).values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 16);
}
