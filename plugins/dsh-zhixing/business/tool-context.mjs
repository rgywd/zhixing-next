// Source identity comes from consumed native input, never a model-invented ID.
// Queued messages are not part of deriveMessages() until the host consumes them.
export function toolBody({ path: route, method, body }, exec) {
  if (!exec.agent || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const path = new URL(route, 'http://zhixing.invalid').pathname;
  const create = method === 'POST' && /^\/v1\/(?:life\/meals|finance\/transactions|health\/(?:rules|meals|weights|steps|recommendations(?:\/[^/]+\/feedback)?))$/.test(path);
  const correct = method === 'PATCH' && /^\/v1\/life\/meals\/[^/]+$/.test(path);
  if (!create && !correct) return body;
  const user = exec.agent.session.deriveMessages().findLast(m => m.role === 'user' && m.source?.kind === 'user');
  return { ...body, source_id: `${exec.agent.id}:${user?.id ?? exec.rootCallId}`,
    ...(create ? { conversation_id: exec.agent.id } : {}) };
}
