import {
    type TuiPluginCapability,
    TuiPluginCapabilitySchema,
    type TuiPluginDiagnostic,
    TuiPluginDiagnosticSchema,
    type TuiPluginManifest,
    type TuiPluginManifestInput,
    TuiPluginManifestSchema,
} from '@mission-control/protocol';
import { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { atomicWriteTextFile, jsonText, parseJsonText, readOptionalTextFile } from './store-file-io';
import { join } from 'node:path';

export const TUI_PLUGIN_MANIFEST_MAX_ENTRIES = 200;

const TuiPluginManifestFileSchema = z
    .object({
        version: z.literal(1),
        manifests: z.array(TuiPluginManifestSchema).readonly(),
        diagnostics: z.array(TuiPluginDiagnosticSchema).readonly(),
    })
    .strict();

type TuiPluginManifestFile = z.infer<typeof TuiPluginManifestFileSchema>;

export type TuiPluginManifestStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly maxEntries?: number;
};

export class TuiPluginManifestStore {
    readonly filePath: string;
    private readonly maxEntries: number;

    constructor(options: TuiPluginManifestStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'tui', 'plugin-manifests.json');
        this.maxEntries = options.maxEntries ?? TUI_PLUGIN_MANIFEST_MAX_ENTRIES;
    }

    async listManifests(): Promise<readonly TuiPluginManifest[]> {
        return (await this.readFile()).manifests;
    }

    async saveManifest(manifest: TuiPluginManifestInput): Promise<void> {
        const parsedManifest = TuiPluginManifestSchema.parse(manifest);
        const file = await this.readFile();
        await this.writeFile({
            ...file,
            manifests: [
                ...file.manifests.filter((candidate) => candidate.name !== parsedManifest.name),
                parsedManifest,
            ].slice(-this.maxEntries),
        });
    }

    async removeManifest(name: string): Promise<void> {
        const file = await this.readFile();
        await this.writeFile({ ...file, manifests: file.manifests.filter((manifest) => manifest.name !== name) });
    }

    async listCapabilities(): Promise<readonly TuiPluginCapability[]> {
        return (await this.listManifests()).flatMap((manifest) =>
            manifest.capabilities.map((capability) =>
                TuiPluginCapabilitySchema.parse({ pluginName: manifest.name, capability, enabled: true }),
            ),
        );
    }

    async listDiagnostics(): Promise<readonly TuiPluginDiagnostic[]> {
        return (await this.readFile()).diagnostics;
    }

    async appendDiagnostic(diagnostic: TuiPluginDiagnostic): Promise<void> {
        const file = await this.readFile();
        await this.writeFile({
            ...file,
            diagnostics: [...file.diagnostics, TuiPluginDiagnosticSchema.parse(diagnostic)].slice(-this.maxEntries),
        });
    }

    private async readFile(): Promise<TuiPluginManifestFile> {
        const contents = await readOptionalTextFile(this.filePath);
        if (contents === undefined) {
            return emptyFile();
        }
        const parsed = parseJsonText(contents);
        const result = parsed === undefined ? undefined : TuiPluginManifestFileSchema.safeParse(parsed);
        return result?.success === true ? trimFile(result.data, this.maxEntries) : emptyFile();
    }

    private async writeFile(file: TuiPluginManifestFile): Promise<void> {
        await atomicWriteTextFile(
            this.filePath,
            jsonText(TuiPluginManifestFileSchema.parse(trimFile(file, this.maxEntries))),
        );
    }
}

function emptyFile(): TuiPluginManifestFile {
    return { version: 1, manifests: [], diagnostics: [] };
}

function trimFile(file: TuiPluginManifestFile, maxEntries: number): TuiPluginManifestFile {
    return {
        version: 1,
        manifests: file.manifests.slice(-maxEntries),
        diagnostics: file.diagnostics.slice(-maxEntries),
    };
}
