import {
    type TuiKvEntry,
    TuiKvEntrySchema,
    type TuiKvNamespace,
    TuiKvNamespaceSchema,
} from '@mission-control/protocol';
import { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { atomicWriteTextFile, jsonText, parseJsonText, readOptionalTextFile } from './store-file-io';
import { join } from 'node:path';

export const TUI_KV_STORE_MAX_ENTRIES = 500;

const TuiKvFileSchema = z
    .object({
        version: z.literal(1),
        namespaces: z.array(TuiKvNamespaceSchema).readonly(),
    })
    .strict();

type TuiKvFile = z.infer<typeof TuiKvFileSchema>;

export type TuiKvStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly maxEntries?: number;
};

export class TuiKvStore {
    readonly filePath: string;
    private readonly maxEntries: number;

    constructor(options: TuiKvStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'tui', 'kv.json');
        this.maxEntries = options.maxEntries ?? TUI_KV_STORE_MAX_ENTRIES;
    }

    async listNamespaces(): Promise<readonly TuiKvNamespace[]> {
        return (await this.readFile()).namespaces;
    }

    async listEntries(namespace: string): Promise<readonly TuiKvEntry[]> {
        return (await this.readNamespace(namespace)).entries;
    }

    async getEntry(namespace: string, key: string): Promise<TuiKvEntry | undefined> {
        return (await this.listEntries(namespace)).find((entry) => entry.key === key);
    }

    async getString(namespace: string, key: string): Promise<string | undefined> {
        const entry = await this.getEntry(namespace, key);
        return entry?.schemaKey === 'string' ? entry.value : undefined;
    }

    async getNumber(namespace: string, key: string): Promise<number | undefined> {
        const entry = await this.getEntry(namespace, key);
        return entry?.schemaKey === 'number' ? entry.value : undefined;
    }

    async getBoolean(namespace: string, key: string): Promise<boolean | undefined> {
        const entry = await this.getEntry(namespace, key);
        return entry?.schemaKey === 'boolean' ? entry.value : undefined;
    }

    async setEntry(namespace: string, entry: TuiKvEntry): Promise<void> {
        const parsedEntry = TuiKvEntrySchema.parse(entry);
        const file = await this.readFile();
        const existingNamespace = file.namespaces.find((candidate) => candidate.namespace === namespace);
        const nextEntries = [
            ...(existingNamespace?.entries ?? []).filter((candidate) => candidate.key !== entry.key),
            parsedEntry,
        ].slice(-this.maxEntries);
        const nextNamespace = TuiKvNamespaceSchema.parse({ namespace, entries: nextEntries });
        await this.writeFile({
            version: 1,
            namespaces: [...file.namespaces.filter((candidate) => candidate.namespace !== namespace), nextNamespace],
        });
    }

    async deleteEntry(namespace: string, key: string): Promise<void> {
        const file = await this.readFile();
        const existingNamespace = file.namespaces.find((candidate) => candidate.namespace === namespace);
        if (existingNamespace === undefined) {
            return;
        }
        const nextEntries = existingNamespace.entries.filter((entry) => entry.key !== key);
        const namespaces = file.namespaces.filter((candidate) => candidate.namespace !== namespace);
        await this.writeFile({
            version: 1,
            namespaces: nextEntries.length === 0 ? namespaces : [...namespaces, { namespace, entries: nextEntries }],
        });
    }

    private async readNamespace(namespace: string): Promise<TuiKvNamespace> {
        return (
            (await this.readFile()).namespaces.find((candidate) => candidate.namespace === namespace) ?? {
                namespace,
                entries: [],
            }
        );
    }

    private async readFile(): Promise<TuiKvFile> {
        const contents = await readOptionalTextFile(this.filePath);
        if (contents === undefined) {
            return emptyFile();
        }
        const parsed = parseJsonText(contents);
        const result = parsed === undefined ? undefined : TuiKvFileSchema.safeParse(parsed);
        return result?.success === true ? trimFile(result.data, this.maxEntries) : emptyFile();
    }

    private async writeFile(file: TuiKvFile): Promise<void> {
        await atomicWriteTextFile(this.filePath, jsonText(TuiKvFileSchema.parse(trimFile(file, this.maxEntries))));
    }
}

function emptyFile(): TuiKvFile {
    return { version: 1, namespaces: [] };
}

function trimFile(file: TuiKvFile, maxEntries: number): TuiKvFile {
    return {
        version: 1,
        namespaces: file.namespaces.map((namespace) => ({
            namespace: namespace.namespace,
            entries: namespace.entries.slice(-maxEntries),
        })),
    };
}
