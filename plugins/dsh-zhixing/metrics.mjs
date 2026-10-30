/** Read native projection values at turn/end cuts. Never reconstruct billing or timing in the App. */
export function createMetrics(ctx) {
  const sessions = new Map();
  return {
    async turns(id, reader, page) {
      const registry = ctx.get?.('sessionProjections');
      const ends = page.filter(event => event.type === 'turn/end' && event.data.reason?.kind !== 'forked');
      if (!registry || !ends.length) return [];
      let entry = sessions.get(id);
      if (!entry) {
        entry = { next: 0, checkpoint: {}, snapshots: new Map(), pending: Promise.resolve() };
        sessions.set(id, entry);
      }
      // A small disposable replay cache, not another persistent statistics store.
      sessions.delete(id); sessions.set(id, entry);
      if (sessions.size > 24) sessions.delete(sessions.keys().next().value);
      const read = entry.pending.catch(() => {}).then(async () => {
        const target = ends.at(-1).seq;
        while (entry.next <= target) {
          // Native restore requires the previous watermark as an anchor.
          const offset = Math.max(0, entry.next - 1);
          const { events } = await reader.read(offset, Math.min(256, target - offset + 1));
          if (!events.some(event => event.seq >= entry.next)) break;
          let start = 0;
          for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (event.seq < entry.next) continue;
            const ended = event.type === 'turn/end';
            if (!ended && i !== events.length - 1) continue;
            const slice = events.slice(start, i + 1);
            const restored = registry.restore(entry.checkpoint, slice, slice[0].seq, reader.header, reader.inheritedEventCount);
            entry.checkpoint = restored.checkpoint; entry.next = event.seq + 1;
            if (ended && event.data.reason?.kind !== 'forked') {
              const { sessionStats, tokenUsage } = restored.snapshot.values;
              entry.snapshots.set(event.seq, { seq: event.seq, turn: event.data.turn,
                stats: sessionStats ?? null, usage: tokenUsage ?? null });
            }
            // Retain the preceding event for the next native checkpoint restore.
            start = i;
          }
        }
        return ends.flatMap(event => entry.snapshots.has(event.seq) ? [entry.snapshots.get(event.seq)] : []);
      });
      entry.pending = read;
      return read;
    },
  };
}

/** Reuse the projections already read by the chat poll; context is a reference, not a live billing meter. */
export function contextSnapshot(projection) {
  return { pressure: projection?.values.contextPressure ?? null, breakdown: projection?.values.contextBreakdown ?? null };
}
