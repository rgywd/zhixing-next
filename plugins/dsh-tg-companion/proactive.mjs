import { randomUUID } from 'node:crypto';
import { eligible, validateDraft } from './state.mjs';

// One narrow background operation: fetch public news, draft with no tools, deliver once.
export function createProactive({ store, clock = Date.now, isBusy, collect, generate, send, onReceipt = async () => {} }) {
  let running = false;
  return async function check() {
    if (running) return { skipped: 'check-running' };
    const initial = store.get(); const reason = eligible(initial, clock());
    if (reason || isBusy()) return { skipped: reason || 'conversation-busy' };
    running = true;
    try {
      store.change(s => { s.lastCheckAt = clock(); });
      const candidates = (await collect()).filter(c => !initial.deliveries.some(d => d.topicId === c.id && ['sent', 'sending', 'unknown'].includes(d.status)));
      if (!candidates.length) return { skipped: 'no-new-topic' };
      const draft = validateDraft(await generate(candidates), candidates);
      if (!draft) return { skipped: 'nothing-worth-sending' };
      // Recheck after every asynchronous read/model request: user input, pause, or quiet hours wins.
      const current = store.get();
      const recheck = eligible({ ...current, lastCheckAt: initial.lastCheckAt }, clock());
      if (recheck || current.inboundVersion !== initial.inboundVersion || isBusy()) return { skipped: recheck || 'conversation-changed' };
      const attempt = { id: randomUUID(), ...draft, at: clock(), inboundVersion: current.inboundVersion, status: 'sending' };
      store.change(s => { s.deliveries.push(attempt); }); // Durable BEFORE the network side effect.
      let receipt;
      try {
        receipt = await send(draft.text);
        if (!Number.isSafeInteger(receipt?.message_id)) throw new Error('No Telegram message receipt');
      } catch {
        store.change(s => { s.deliveries.find(d => d.id === attempt.id).status = 'unknown'; });
        return { status: 'unknown', id: attempt.id }; // Never retry an ambiguous delivery.
      }
      store.change(s => { Object.assign(s.deliveries.find(d => d.id === attempt.id), { status: 'sent', messageId: receipt.message_id }); });
      await onReceipt({ ...attempt, status: 'sent', messageId: receipt.message_id });
      return { status: 'sent', messageId: receipt.message_id };
    } finally { running = false; }
  };
}
