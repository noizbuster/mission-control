import { type TuiLocalPreferences, TuiLocalPreferencesSchema, type TuiUiToggle } from '@mission-control/protocol';
import { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { atomicWriteTextFile, jsonText, parseJsonText, readOptionalTextFile } from './store-file-io.js';
import { join } from 'node:path';

export const TUI_LOCAL_PREFERENCES_MAX_ENTRIES = 100;

const TuiLocalPreferencesFileSchema = z
    .object({
        version: z.literal(1),
        preferences: TuiLocalPreferencesSchema,
    })
    .strict();

type TuiLocalPreferencesFile = z.infer<typeof TuiLocalPreferencesFileSchema>;

export type TuiLocalPreferencesStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly maxEntries?: number;
};

export class TuiLocalPreferencesStore {
    readonly filePath: string;
    private readonly maxEntries: number;

    constructor(options: TuiLocalPreferencesStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'tui', 'local-preferences.json');
        this.maxEntries = options.maxEntries ?? TUI_LOCAL_PREFERENCES_MAX_ENTRIES;
    }

    async getPreferences(): Promise<TuiLocalPreferences> {
        return (await this.readFile()).preferences;
    }

    async savePreferences(preferences: TuiLocalPreferences): Promise<void> {
        await this.writeFile({ version: 1, preferences: trimPreferences(preferences, this.maxEntries) });
    }

    async addRecentModel(modelId: string): Promise<void> {
        const preferences = await this.getPreferences();
        await this.savePreferences({
            ...preferences,
            recentModels: [...preferences.recentModels.filter((candidate) => candidate !== modelId), modelId],
        });
    }

    async setUiToggle(toggle: TuiUiToggle): Promise<void> {
        const preferences = await this.getPreferences();
        await this.savePreferences({
            ...preferences,
            uiToggles: [...preferences.uiToggles.filter((candidate) => candidate.key !== toggle.key), toggle],
        });
    }

    private async readFile(): Promise<TuiLocalPreferencesFile> {
        const contents = await readOptionalTextFile(this.filePath);
        if (contents === undefined) {
            return emptyFile();
        }
        const parsed = parseJsonText(contents);
        const result = parsed === undefined ? undefined : TuiLocalPreferencesFileSchema.safeParse(parsed);
        return result?.success === true
            ? { version: 1, preferences: trimPreferences(result.data.preferences, this.maxEntries) }
            : emptyFile();
    }

    private async writeFile(file: TuiLocalPreferencesFile): Promise<void> {
        await atomicWriteTextFile(this.filePath, jsonText(TuiLocalPreferencesFileSchema.parse(file)));
    }
}

export function emptyTuiLocalPreferences(): TuiLocalPreferences {
    return {
        recentModels: [],
        favoriteModels: [],
        variantCyclingHints: [],
        sessionPins: [],
        uiToggles: [],
    };
}

function emptyFile(): TuiLocalPreferencesFile {
    return { version: 1, preferences: emptyTuiLocalPreferences() };
}

function trimPreferences(preferences: TuiLocalPreferences, maxEntries: number): TuiLocalPreferences {
    return TuiLocalPreferencesSchema.parse({
        recentModels: preferences.recentModels.slice(-maxEntries),
        favoriteModels: preferences.favoriteModels.slice(-maxEntries),
        variantCyclingHints: preferences.variantCyclingHints.slice(-maxEntries),
        sessionPins: preferences.sessionPins.slice(-maxEntries),
        uiToggles: preferences.uiToggles.slice(-maxEntries),
    });
}
