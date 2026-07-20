import { resolveMissionControlDataDir } from '../../memory/data-dir';
import type { ObservabilityRedactor } from '../../providers/observability-redactor';

export type MissionRunStoreLocation =
    | string
    | {
          readonly mcRoot: string;
          readonly dataDir?: string;
          readonly observabilityRedactor?: ObservabilityRedactor;
      };

export type NormalizedMissionRunStoreLocation = {
    readonly mcRoot: string;
    readonly dataDir: string;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

export function normalizeMissionRunStoreLocation(location: MissionRunStoreLocation): NormalizedMissionRunStoreLocation {
    if (typeof location === 'string') {
        return { mcRoot: location, dataDir: resolveMissionControlDataDir() };
    }
    return {
        mcRoot: location.mcRoot,
        dataDir: location.dataDir ?? resolveMissionControlDataDir(),
        ...(location.observabilityRedactor !== undefined
            ? { observabilityRedactor: location.observabilityRedactor }
            : {}),
    };
}
