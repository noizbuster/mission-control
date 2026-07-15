import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalLibsqlDb, runLocalLibsqlWrite } from './local-libsql-db';
import { runLocalLibsqlClientTransaction } from './local-libsql-transaction';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local libSQL transaction rollback fencing', () => {
    it('quarantines a client after rollback failure before a queued writer can run', async () => {
        const root = await mkdtemp(join(tmpdir(), 'mctrl-libsql-rollback-fence-'));
        roots.push(root);
        const url = pathToFileURL(join(root, 'mission-control.db')).href;
        const runtime = await openLocalLibsqlDb({ url });
        const originalExecute = runtime.client.execute.bind(runtime.client);
        vi.spyOn(runtime.client, 'execute').mockImplementation((statement) => {
            if (statement === 'ROLLBACK') return Promise.reject(new Error('injected rollback failure'));
            return originalExecute(statement);
        });
        const entered = deferred<void>();
        const release = deferred<void>();
        let queuedWriterRan = false;

        const failedWrite = runLocalLibsqlWrite(runtime, (client) =>
            runLocalLibsqlClientTransaction(client, async () => {
                entered.resolve(undefined);
                await release.promise;
                throw new Error('injected write failure');
            }),
        );
        await entered.promise;
        const queuedWrite = runLocalLibsqlWrite(runtime, async () => {
            queuedWriterRan = true;
        });
        release.resolve(undefined);

        await expect(failedWrite).rejects.toThrow('database write and rollback both failed');
        await expect(queuedWrite).rejects.toMatchObject({ code: 'client_quarantined' });
        expect(queuedWriterRan).toBe(false);

        await expect(openLocalLibsqlDb({ url })).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
        runtime.close();
    }, 10_000);
});

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value | PromiseLike<Value>) => void;
} {
    let resolve: ((value: Value | PromiseLike<Value>) => void) | undefined;
    const promise = new Promise<Value>((promiseResolve) => {
        resolve = promiseResolve;
    });
    if (resolve === undefined) throw new TypeError('deferred initialization failed');
    return { promise, resolve };
}
