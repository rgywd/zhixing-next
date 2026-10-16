import type { Run } from "./api";

/** Waiting for another chat is still the user's current, steerable reply. */
export function isSteerableUserRun(run?: Run | null): run is Run {
  return !!run && !run.cancel_requested && !run.origin
    && (run.status === "running" || (run.status === "queued" && run.phase === "agent_wait"));
}
