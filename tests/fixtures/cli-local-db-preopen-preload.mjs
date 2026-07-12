import { getOrCreateMissionControlServices } from '../../apps/cli/dist/commands/mission-control-services.js';
import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const workspaceRoot = process.env.MCTRL_WORKSPACE;
const releasePath = process.env.MCTRL_TASK12_PREOPEN_RELEASE_PATH;
if (workspaceRoot === undefined || releasePath === undefined) {
    throw new TypeError('Task 12 preopen preload requires workspace and release paths');
}

await getOrCreateMissionControlServices(workspaceRoot);
process.stdout.write('PREOPENED\n');
await waitForRelease(releasePath);

function waitForRelease(filePath) {
    const signal = AbortSignal.timeout(10_000);
    return new Promise((resolve, reject) => {
        let settled = false;
        const watcher = watch(dirname(filePath), { signal }, (_eventType, filename) => {
            if (filename === null || filename.toString() === basename(filePath)) void check();
        });
        const finish = (error) => {
            if (settled) return;
            settled = true;
            watcher.close();
            if (error === undefined) resolve();
            else reject(error);
        };
        const check = async () => {
            try {
                await access(filePath);
                finish();
            } catch (error) {
                if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return;
                finish(error);
            }
        };
        watcher.on('error', (error) => {
            if (!signal.aborted) finish(error);
        });
        signal.addEventListener('abort', () => finish(new Error(`preopen release deadline: ${filePath}`)), {
            once: true,
        });
        void check();
    });
}
