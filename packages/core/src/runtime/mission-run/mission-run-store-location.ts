import { resolveMissionControlDataDir } from '../../memory/data-dir.js';

export type MissionRunStoreLocation =
    | string
    | {
          readonly omoRoot: string;
          readonly dataDir?: string;
      };

export type NormalizedMissionRunStoreLocation = {
    readonly omoRoot: string;
    readonly dataDir: string;
};

export function normalizeMissionRunStoreLocation(location: MissionRunStoreLocation): NormalizedMissionRunStoreLocation {
    if (typeof location === 'string') {
        return { omoRoot: location, dataDir: resolveMissionControlDataDir() };
    }
    return {
        omoRoot: location.omoRoot,
        dataDir: location.dataDir ?? resolveMissionControlDataDir(),
    };
}
