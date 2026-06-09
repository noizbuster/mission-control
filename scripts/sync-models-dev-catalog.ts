import { buildModelsDevCatalogSnapshot, modelsDevURL, parseModelsDevCatalog } from './models-dev-catalog-builder.js';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export { buildModelsDevCatalogSnapshot } from './models-dev-catalog-builder.js';

const outputPath = resolve('packages/config/src/generated/models-dev-catalog.json');

async function main(): Promise<void> {
    const rawCatalog = parseModelsDevCatalog(JSON.parse(await fetchText(modelsDevURL)));
    const snapshot = buildModelsDevCatalogSnapshot(rawCatalog);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    formatSnapshot(outputPath);
    process.stdout.write(
        `wrote ${outputPath} with ${snapshot.providerCount} providers and ${snapshot.modelCount} models\n`,
    );
}

async function fetchText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        get(url, (response) => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Models.dev request failed with status ${statusCode}`));
                return;
            }
            response.setEncoding('utf8');
            let data = '';
            response.on('data', (chunk: string) => {
                data += chunk;
            });
            response.on('end', () => {
                resolve(data);
            });
        }).on('error', reject);
    });
}

function formatSnapshot(path: string): void {
    const result = spawnSync('pnpm', ['exec', 'biome', 'format', '--write', path], { stdio: 'inherit' });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        const reason = result.signal !== null ? `signal ${result.signal}` : `status ${result.status ?? 'unknown'}`;
        throw new Error(`Biome format failed with ${reason}`);
    }
}

function isCliEntrypoint(): boolean {
    const entryPath = process.argv[1];
    return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isCliEntrypoint()) {
    await main().catch((error: unknown) => {
        if (error instanceof Error) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
            return;
        }
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
    });
}
