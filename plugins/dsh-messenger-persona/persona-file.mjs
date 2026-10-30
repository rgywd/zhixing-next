import { readFileSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const MAX_BYTES = 24 * 1024;

// A stable system section: no clocks, mood dice, retrieval results, or per-turn
// rewrites. Reading at assembly time makes an atomic file replacement effective
// on the next model request, including an already-open conversation.
export function openPersonaFile(path, warn = () => {}) {
  let current;
  let lastError;
  function read() {
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('persona must be a file of at most 24 KiB');
      const text = readFileSync(path, 'utf8').trim();
      if (!text || text.includes('\uFFFD') || text.includes('\0') || Buffer.byteLength(text) > MAX_BYTES) {
        throw new Error('persona must contain nonempty UTF-8 text');
      }
      current = text;
      lastError = undefined;
    } catch (error) {
      if (current === undefined) throw error;
      // A broken edit must not turn an established character into the default
      // assistant. Keep the last valid card and make the failure observable.
      const message = error.code || error.message;
      if (message !== lastError) warn(`Persona reload failed (${message}); keeping the last valid card.`);
      lastError = message;
    }
    return current;
  }
  read(); // Fail installation early if the initial card cannot be loaded.
  return { read };
}

export function isMessengerAgent(agent) {
  const header = agent?.session?.header;
  return typeof agent?.session?.id === 'string' && agent.session.id.startsWith('msgw-') &&
    header?.origin !== 'subagent' && !(header?.delegationDepth > 0);
}
