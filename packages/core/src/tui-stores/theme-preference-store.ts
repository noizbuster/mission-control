import { type TuiThemePreference, TuiThemePreferenceSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { atomicWriteTextFile, jsonText, parseJsonText, readOptionalTextFile } from './store-file-io.js';
import { join } from 'node:path';

export const TUI_THEME_OVERRIDE_MAX_ENTRIES = 200;

const TuiThemePreferenceFileSchema = z
    .object({
        version: z.literal(1),
        preference: TuiThemePreferenceSchema,
    })
    .strict();

type TuiThemePreferenceFile = z.infer<typeof TuiThemePreferenceFileSchema>;

export type TuiThemePreferenceStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly maxEntries?: number;
};

export class TuiThemePreferenceStore {
    readonly filePath: string;
    private readonly maxEntries: number;

    constructor(options: TuiThemePreferenceStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'tui', 'theme-preference.json');
        this.maxEntries = options.maxEntries ?? TUI_THEME_OVERRIDE_MAX_ENTRIES;
    }

    async getPreference(): Promise<TuiThemePreference> {
        return (await this.readFile()).preference;
    }

    async savePreference(preference: TuiThemePreference): Promise<void> {
        await this.writeFile({ version: 1, preference: trimPreference(preference, this.maxEntries) });
    }

    private async readFile(): Promise<TuiThemePreferenceFile> {
        const contents = await readOptionalTextFile(this.filePath);
        if (contents === undefined) {
            return emptyFile();
        }
        const parsed = parseJsonText(contents);
        const result = parsed === undefined ? undefined : TuiThemePreferenceFileSchema.safeParse(parsed);
        return result?.success === true
            ? { version: 1, preference: trimPreference(result.data.preference, this.maxEntries) }
            : emptyFile();
    }

    private async writeFile(file: TuiThemePreferenceFile): Promise<void> {
        await atomicWriteTextFile(this.filePath, jsonText(TuiThemePreferenceFileSchema.parse(file)));
    }
}

export function defaultTuiThemePreference(): TuiThemePreference {
    return { activeThemeId: 'default', customOverrides: [] };
}

function emptyFile(): TuiThemePreferenceFile {
    return { version: 1, preference: defaultTuiThemePreference() };
}

function trimPreference(preference: TuiThemePreference, maxEntries: number): TuiThemePreference {
    return TuiThemePreferenceSchema.parse({
        activeThemeId: preference.activeThemeId,
        customOverrides: preference.customOverrides.slice(-maxEntries),
    });
}
