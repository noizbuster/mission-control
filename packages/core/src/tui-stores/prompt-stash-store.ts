import { type TuiPromptStashEntry, TuiPromptStashEntrySchema } from '@mission-control/protocol';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { atomicWriteTextFile, jsonlText, parseJsonlRecords, readOptionalTextFile } from './store-file-io';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const TUI_PROMPT_STASH_MAX_ENTRIES = 50;

export type TuiPromptStashStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly maxEntries?: number;
    readonly now?: () => number;
    readonly idFactory?: () => string;
};

export type PushPromptStashEntryInput = {
    readonly text: string;
    readonly cursorOffset: number;
};

export class TuiPromptStashStore {
    readonly filePath: string;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private readonly idFactory: () => string;

    constructor(options: TuiPromptStashStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'tui', 'prompt-stash.jsonl');
        this.maxEntries = options.maxEntries ?? TUI_PROMPT_STASH_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
        this.idFactory = options.idFactory ?? randomUUID;
    }

    async listEntries(): Promise<readonly TuiPromptStashEntry[]> {
        const contents = await readOptionalTextFile(this.filePath);
        return contents === undefined
            ? []
            : parseJsonlRecords(contents, TuiPromptStashEntrySchema).slice(-this.maxEntries);
    }

    async pushEntry(input: PushPromptStashEntryInput): Promise<TuiPromptStashEntry> {
        const entry = TuiPromptStashEntrySchema.parse({
            id: this.idFactory(),
            text: input.text,
            cursorOffset: input.cursorOffset,
            timestamp: this.now(),
        });
        await this.writeEntries([...(await this.listEntries()), entry].slice(-this.maxEntries));
        return entry;
    }

    async popEntry(): Promise<TuiPromptStashEntry | undefined> {
        const entries = await this.listEntries();
        const entry = entries.at(-1);
        if (entry === undefined) {
            return undefined;
        }
        await this.writeEntries(entries.slice(0, -1));
        return entry;
    }

    async replaceEntries(entries: readonly TuiPromptStashEntry[]): Promise<void> {
        await this.writeEntries(entries.slice(-this.maxEntries));
    }

    private async writeEntries(entries: readonly TuiPromptStashEntry[]): Promise<void> {
        await atomicWriteTextFile(
            this.filePath,
            jsonlText(entries.map((entry) => TuiPromptStashEntrySchema.parse(entry))),
        );
    }
}
