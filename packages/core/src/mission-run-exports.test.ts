import {
    ALLOWED_RUN_TRANSITIONS,
    assertRunTransition,
    completeRun,
    createMission,
    createRun,
    ensureOmoDirs,
    failRun,
    listMissions,
    listRunsForMission,
    materializeMission,
    normalizeMissionRunStoreLocation,
    readMission,
    readRun,
    resolveOmoRoot,
    startRun,
    TERMINAL_RUN_STATUSES,
    updateMission,
    updateRunStatus,
} from '@mission-control/core';
import { describe, expect, it } from 'vitest';

/**
 * Import-contract test: the mission-run and `.omo` persistence APIs the CLI
 * consumes must be reachable as named imports from the `@mission-control/core`
 * package entry point. `RunCoordinatorV2` is intentionally out of scope and must
 * NOT be exported by this change.
 */
describe('mission-run and .omo persistence public exports', () => {
    const VALUES: ReadonlyArray<readonly [string, unknown]> = [
        ['createMission', createMission],
        ['readMission', readMission],
        ['updateMission', updateMission],
        ['listMissions', listMissions],
        ['createRun', createRun],
        ['readRun', readRun],
        ['updateRunStatus', updateRunStatus],
        ['listRunsForMission', listRunsForMission],
        ['ALLOWED_RUN_TRANSITIONS', ALLOWED_RUN_TRANSITIONS],
        ['TERMINAL_RUN_STATUSES', TERMINAL_RUN_STATUSES],
        ['assertRunTransition', assertRunTransition],
        ['materializeMission', materializeMission],
        ['normalizeMissionRunStoreLocation', normalizeMissionRunStoreLocation],
        ['startRun', startRun],
        ['completeRun', completeRun],
        ['failRun', failRun],
        ['resolveOmoRoot', resolveOmoRoot],
        ['ensureOmoDirs', ensureOmoDirs],
    ];

    it.each(VALUES)('%s is exported and defined', (_name, value) => {
        expect(value).toBeDefined();
    });

    it('exports ALLOWED_RUN_TRANSITIONS as a non-empty record', () => {
        expect(typeof ALLOWED_RUN_TRANSITIONS).toBe('object');
        expect(Object.keys(ALLOWED_RUN_TRANSITIONS).length).toBeGreaterThan(0);
    });

    it('exports TERMINAL_RUN_STATUSES as a set containing the terminal statuses', () => {
        expect(TERMINAL_RUN_STATUSES).toBeInstanceOf(Set);
        expect(TERMINAL_RUN_STATUSES.has('completed')).toBe(true);
        expect(TERMINAL_RUN_STATUSES.has('failed')).toBe(true);
        expect(TERMINAL_RUN_STATUSES.has('cancelled')).toBe(true);
    });

    it('exports the lifecycle functions as actual functions', () => {
        expect(typeof createMission).toBe('function');
        expect(typeof materializeMission).toBe('function');
        expect(typeof startRun).toBe('function');
        expect(typeof assertRunTransition).toBe('function');
        expect(typeof resolveOmoRoot).toBe('function');
        expect(typeof ensureOmoDirs).toBe('function');
    });
});
