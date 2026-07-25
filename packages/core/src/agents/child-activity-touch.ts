/**
 * Throttled activity touch for child subagent sessions.
 *
 * The child graph run (`spawnChildCodingAgent` -> `runAbgGraph`) does NOT append
 * events to a per-child SQLite store, so the child's `sessions.updated_at` /
 * `last_activity_at` and `runtime_agents.updated_at` are otherwise frozen at the
 * spawn-start timestamp for the entire run. Composing this observer into the
 * child graph's `onSignal` stream advances those timestamps while the child is
 * actively producing work (LLM turns, tool calls, state transitions), throttled
 * to one `recordRuntimeAgent` write per interval so high-frequency streaming
 * signals do not flood the write lane.
 */
import type { AbgSignal } from '@mission-control/protocol';
import type { ChildHostCallbacks } from '../behavior/subagents/spawn-child';
import type { RuntimeAgentRegistry } from './runtime-registry';

/** Minimum gap between two activity touches for the same child session. */
export const CHILD_ACTIVITY_TOUCH_MIN_MS = 1000;

/**
 * Build a throttled `(signal) => void` observer that stamps the child's
 * `lastActivity` (and derived `activity` label) on the runtime registry. The
 * first signal after a quiet period always touches; subsequent signals inside
 * the interval are dropped. Unknown registry ids are a silent no-op.
 */
export function createChildActivitySignalObserver(
    sessionId: string,
    registry: RuntimeAgentRegistry,
): (signal: AbgSignal) => void {
    let lastTouchMs = 0;
    let hasTouched = false;
    return (signal) => {
        const nowMs = Date.now();
        if (hasTouched && nowMs - lastTouchMs < CHILD_ACTIVITY_TOUCH_MIN_MS) return;
        hasTouched = true;
        lastTouchMs = nowMs;
        registry.touch(sessionId, childActivityFromSignal(signal));
    };
}

/**
 * Derive a short activity label from a graph signal for the `runtime_agents`
 * observability surface. `emit` signals carry a durable event type
 * (`tool.call`, `run.started`, ...); other signal types fall back to their type
 * (or the progress message when present).
 */
export function childActivityFromSignal(signal: AbgSignal): string | undefined {
    switch (signal.type) {
        case 'emit':
            return signal.event.type;
        case 'progress':
            return signal.message ?? 'progress';
        default:
            return signal.type;
    }
}

/**
 * Compose a throttled activity touch into a {@link ChildHostCallbacks} bag so
 * every child graph signal bumps the child session's timestamps before reaching
 * the host's own `onSignal` (TUI rendering). When `base` is undefined the child
 * was going to run isolated; the returned bag carries only `onSignal` so the
 * child stays isolated for `ask_user` (no `requestUserQuestion`) while still
 * reporting activity.
 */
export function composeChildHostCallbacksWithActivity(
    base: ChildHostCallbacks | undefined,
    sessionId: string,
    registry: RuntimeAgentRegistry,
): ChildHostCallbacks {
    const observeActivity = createChildActivitySignalObserver(sessionId, registry);
    const hostOnSignal = base?.onSignal;
    const onSignal = (signal: AbgSignal): void | Promise<void> => {
        observeActivity(signal);
        return hostOnSignal?.(signal);
    };
    return base === undefined ? { onSignal } : { ...base, onSignal };
}
