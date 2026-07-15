import { type TuiPromptHistoryEntry, TuiPromptHistoryEntrySchema } from '@mission-control/protocol';
import { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { atomicWriteTextFile, jsonText, parseJsonText, readOptionalTextFile } from './store-file-io';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const TUI_PROMPT_HISTORY_MAX_ENTRIES = 1000;

const LegacyPromptHistoryFileSchema = z.object({ entries: z.array(z.string()).readonly() }).strict();
const TypedPromptHistoryFileSchema = z.object({ entries: z.array(TuiPromptHistoryEntrySchema).readonly() }).strict();

type TypedPromptHistoryFile = z.infer<typeof TypedPromptHistoryFileSchema>;

export type TuiPromptHistoryStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly maxEntries?: number;
    readonly now?: () => number;
    readonly idFactory?: () => string;
};

export class TuiPromptHistoryStore {
    readonly filePath: string;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private readonly idFactory: () => string;

    constructor(options: TuiPromptHistoryStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'input-history.json');
        this.maxEntries = options.maxEntries ?? TUI_PROMPT_HISTORY_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
        this.idFactory = options.idFactory ?? randomUUID;
    }

    async listEntries(): Promise<readonly TuiPromptHistoryEntry[]> {
        return (await this.readFile()).entries;
    }

    async listTexts(): Promise<readonly string[]> {
        return (await this.listEntries()).map((entry) => entry.text);
    }

    async appendText(text: string): Promise<TuiPromptHistoryEntry | undefined> {
        if (text.length === 0) {
            return undefined;
        }
        const entries = await this.listEntries();
        if (entries.at(-1)?.text === text) {
            return undefined;
        }
        const entry = TuiPromptHistoryEntrySchema.parse({ id: this.idFactory(), text, timestamp: this.now() });
        await this.writeFile({ entries: [...entries, entry].slice(-this.maxEntries) });
        return entry;
    }

    async replaceEntries(entries: readonly TuiPromptHistoryEntry[]): Promise<void> {
        await this.writeFile({ entries: entries.slice(-this.maxEntries) });
    }

    private async readFile(): Promise<TypedPromptHistoryFile> {
        const contents = await readOptionalTextFile(this.filePath);
        if (contents === undefined) {
            return { entries: [] };
        }
        const parsed = parseJsonText(contents);
        if (parsed === undefined) {
            return { entries: [] };
        }
        const typed = TypedPromptHistoryFileSchema.safeParse(parsed);
        if (typed.success) {
            return { entries: typed.data.entries.slice(-this.maxEntries) };
        }
        const legacy = LegacyPromptHistoryFileSchema.safeParse(parsed);
        return legacy.success ? { entries: legacyEntries(legacy.data.entries, this.maxEntries) } : { entries: [] };
    }

    private async writeFile(file: TypedPromptHistoryFile): Promise<void> {
        await atomicWriteTextFile(this.filePath, jsonText(TypedPromptHistoryFileSchema.parse(file)));
    }
}

function legacyEntries(entries: readonly string[], maxEntries: number): readonly TuiPromptHistoryEntry[] {
    return entries
        .filter((entry) => entry.length > 0)
        .slice(-maxEntries)
        .map((text, index) => ({ id: `legacy-${index}`, text, timestamp: 0 }));
}
