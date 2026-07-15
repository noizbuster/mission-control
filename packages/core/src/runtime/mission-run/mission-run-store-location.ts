import { resolveMissionControlDataDir } from '../../memory/data-dir';
import type { ObservabilityRedactor } from '../../providers/observability-redactor';

export type MissionRunStoreLocation =
    | string
    | {
          readonly omoRoot: string;
          readonly dataDir?: string;
          readonly observabilityRedactor?: ObservabilityRedactor;
      };

export type NormalizedMissionRunStoreLocation = {
    readonly omoRoot: string;
    readonly dataDir: string;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

export function normalizeMissionRunStoreLocation(location: MissionRunStoreLocation): NormalizedMissionRunStoreLocation {
    if (typeof location === 'string') {
        return { omoRoot: location, dataDir: resolveMissionControlDataDir() };
    }
    return {
        omoRoot: location.omoRoot,
        dataDir: location.dataDir ?? resolveMissionControlDataDir(),
        ...(location.observabilityRedactor !== undefined
            ? { observabilityRedactor: location.observabilityRedactor }
            : {}),
    };
}
