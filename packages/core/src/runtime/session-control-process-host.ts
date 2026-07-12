import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { openCanonicalRuntimeDb } from './local-runtime-db.js';
import { SessionControlHost } from './session-control-host.js';
import { resolve } from 'node:path';

type ProcessHostResource = { readonly host: SessionControlHost; readonly runtime: LocalLibsqlDb };

const processHosts = new Map<string, Promise<ProcessHostResource>>();

export function getProcessSessionControlHost(dataDir?: string): Promise<SessionControlHost> {
    const canonicalDataDir = resolve(dataDir ?? resolveMissionControlDataDir());
    const existing = processHosts.get(canonicalDataDir);
    if (existing !== undefined) return existing.then((resource) => resource.host);
    const created = createProcessHost(canonicalDataDir);
    processHosts.set(canonicalDataDir, created);
    void created.catch(() => processHosts.delete(canonicalDataDir));
    return created.then((resource) => resource.host);
}

export async function closeProcessSessionControlHosts(): Promise<void> {
    const resources = await Promise.allSettled(processHosts.values());
    processHosts.clear();
    await Promise.all(
        resources.map(async (result) => {
            if (result.status !== 'fulfilled') return;
            await result.value.host.close();
            result.value.runtime.close();
        }),
    );
}

export async function fenceProcessSessionControlHosts(): Promise<void> {
    const resources = await Promise.allSettled(processHosts.values());
    await Promise.all(
        resources.map(async (result) => {
            if (result.status === 'fulfilled') await result.value.host.close();
        }),
    );
}

async function createProcessHost(dataDir: string): Promise<ProcessHostResource> {
    const { identity, runtime } = await openCanonicalRuntimeDb({ dataDir, legacyRoots: [dataDir] });
    return { host: new SessionControlHost({ runtime, dbIdentity: identity.dbIdentity, dataDir }), runtime };
}
