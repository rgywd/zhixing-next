// One durable preference set shared by native DSH, the App and the owner's TG chat.
export const DEFAULT_FEEDS = [
  { publisher: 'NASA', url: 'https://www.nasa.gov/feed/', domains: ['nasa.gov'] },
  { publisher: 'GitHub', url: 'https://github.blog/changelog/feed/', domains: ['github.blog', 'github.com'] },
];
export function preferences(state) {
  return {
    enabled: state.enabled, maxPerDay: state.maxPerDay,
    activeHours: state.activeHours ?? { start: 10, end: 22 }, timezone: 'Asia/Shanghai',
    feeds: state.feeds ?? structuredClone(DEFAULT_FEEDS),
    excludedTopics: state.excludedTopics ?? [], interests: state.interests ?? '',
    noRepeatedUnansweredMessages: true, revision: state.preferenceRevision ?? 0,
  };
}
function strings(value, max, length) {
  return Array.isArray(value) && value.length <= max && value.every(s => typeof s === 'string' && s.trim() && s.length <= length);
}
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error('Provide settings to change');
  const allowed = ['enabled', 'maxPerDay', 'activeHours', 'feeds', 'excludedTopics', 'interests'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown contact setting');
  if ('enabled' in value && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if ('maxPerDay' in value && (!Number.isSafeInteger(value.maxPerDay) || value.maxPerDay < 1 || value.maxPerDay > 24)) throw new Error('maxPerDay must be 1–24');
  if ('activeHours' in value) {
    const h = value.activeHours;
    if (!h || Object.keys(h).some(k => !['start', 'end'].includes(k)) || !Number.isInteger(h.start) || !Number.isInteger(h.end) ||
      h.start < 0 || h.start > 23 || h.end < 1 || h.end > 24 || h.start === h.end) throw new Error('activeHours needs start (0–23) and end (1–24), Beijing time');
  }
  if ('interests' in value && (typeof value.interests !== 'string' || value.interests.length > 1000)) throw new Error('interests must be at most 1000 characters');
  if ('excludedTopics' in value && !strings(value.excludedTopics, 30, 80)) throw new Error('excludedTopics must be an array of at most 30 short phrases');
  if ('feeds' in value) {
    if (!Array.isArray(value.feeds) || value.feeds.length > 20) throw new Error('feeds must be an array of at most 20 sources');
    for (const feed of value.feeds) {
      if (!feed || Object.keys(feed).some(k => !['publisher', 'url', 'domains'].includes(k)) ||
        typeof feed.publisher !== 'string' || !feed.publisher.trim() || feed.publisher.length > 80 ||
        typeof feed.url !== 'string' || feed.url.length > 2048 || !strings(feed.domains, 20, 253)) throw new Error('Each feed needs publisher, HTTPS url and article domains');
      const url = new URL(feed.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
        feed.domains.some(d => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(d))) throw new Error('Use an HTTPS feed without credentials and valid article domains');
    }
  }
  return structuredClone(value);
}
export function changePreferences(store, { action, perDay, settings }) {
  if (action === 'status') return preferences(store.get());
  const change = action === 'configure' ? validateSettings(settings)
    : action === 'pause' ? { enabled: false } : action === 'resume' ? { enabled: true }
      : action === 'less' ? { maxPerDay: 1 } : action === 'set_limit' ? validateSettings({ maxPerDay: perDay }) : null;
  if (!change) throw new Error('Unknown preference action');
  return preferences(store.change(s => { Object.assign(s, change); s.preferenceRevision = (s.preferenceRevision ?? 0) + 1; }));
}
export function allowedTopic(candidate, state) {
  const text = JSON.stringify(candidate).toLocaleLowerCase();
  return !(state.excludedTopics ?? []).some(topic => text.includes(topic.toLocaleLowerCase()));
}
