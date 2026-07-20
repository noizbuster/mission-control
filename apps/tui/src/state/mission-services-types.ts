/**
 * Structural interface for the runtime services consumed by TUI overlays.
 *
 * The concrete {@link MissionControlServices} class lives in the CLI
 * (the CLI package) because it owns
 * runtime manager lifecycle. The TUI overlays depend only on this structural
 * interface; the CLI instance satisfies it via TypeScript structural typing.
 */
import type { AsyncJobManager, RuntimeAgentRegistry } from '@mission-control/core';

export interface MissionControlServicesLike {
    getMcRoot(): string;
    getJobManager(): AsyncJobManager;
    getRuntimeRegistry(): RuntimeAgentRegistry;
}
