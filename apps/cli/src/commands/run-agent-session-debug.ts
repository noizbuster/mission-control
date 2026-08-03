import { type SessionDebugConfig, SessionDebugConfigSchema } from '@mission-control/protocol';
import type { CliSessionDebugIntent } from '../args';

/** Resolves the documented flag → user profile → disabled precedence. */
export function resolveRunSessionDebugConfig(
    configured: SessionDebugConfig | undefined,
    intent: CliSessionDebugIntent | undefined,
): SessionDebugConfig {
    const baseline = configured ?? SessionDebugConfigSchema.parse({});
    return {
        ...baseline,
        enabled: intent?.enabledOverride ?? baseline.enabled,
    };
}
