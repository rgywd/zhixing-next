// Used by the version-checked gateway compatibility copy.
export async function whenIdleWithTimeout(agent, timeoutMs, signal) {
  let timer, abort;
  const timeout = new Promise((_, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error('模型回复超时，已停止本轮。可以重试或换个模型。');
        error.code = 'GATEWAY_TURN_TIMEOUT'; reject(error);
      }, timeoutMs);
      timer.unref?.();
    }
    abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    await Promise.race([agent.whenIdle(), timeout]);
  } catch (error) {
    // Do not clear the gateway's busy flag while its native agent still runs.
    // Abort the underlying provider/tools, then let the native turn record its end.
    agent.cancel({ kind: 'hook', reason: error.code === 'GATEWAY_TURN_TIMEOUT' ? 'Telegram turn timeout' : 'Telegram turn cancelled' });
    await agent.whenIdle();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
