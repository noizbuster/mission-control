import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../../packages/core/dist/db/local-libsql-db.js';
import {
    openLocalSessionEventStore,
    type SessionControlAttachment,
    SessionControlHost,
} from '../../packages/core/dist/index.js';
import { openCanonicalRuntimeDb } from '../../packages/core/dist/runtime/local-runtime-db.js';
import type { AgentEvent } from '../../packages/protocol/dist/index.js';
import {
    blockedSessionEvents,
    createDeferredHandle,
    createOwnerFixtureAck,
    createOwnerFixtureReady,
    type DeferredHandle,
    type OwnerFixtureCommand,
    type OwnerFixtureScenario,
    parseOwnerFixtureArgs,
    parseOwnerFixtureCommand,
    sessionRunStarted,
    sessionStarted,
    writeInterruptedRun,
} from './session-stop-owner-support.ts';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export * from './session-stop-owner-support.ts';

class OwnerFixtureRuntime {
    private readonly attachments: SessionControlAttachment[] = [];
    private readonly handles = new Map<string, DeferredHandle>();
    private readonly generations = new Map<string, number>();
    private readonly dataDir: string;
    private readonly runtime: LocalLibsqlDb;

    constructor(dataDir: string, runtime: LocalLibsqlDb) {
        this.dataDir = dataDir;
        this.runtime = runtime;
    }

    host: SessionControlHost | undefined;

    async seed(scenario: OwnerFixtureScenario): Promise<void> {
        switch (scenario) {
            case 'active':
                await this.createActiveSession('mc-stop-root', null, true);
                await this.createActiveSession('mc-stop-child', 'mc-stop-root', true);
                return;
            case 'blocked':
                await this.createActiveSession('mc-stop-root', null, true);
                await this.createBlockedSession('mc-stop-child', 'mc-stop-root');
                return;
            case 'tree':
                await this.createActiveSession('mc-stop-root', null, true);
                await this.createActiveSession('mc-stop-child', 'mc-stop-root', true);
                await this.createQueuedSession('mc-stop-grandchild', 'mc-stop-child');
                return;
            case 'noncooperative':
                await this.createActiveSession('mc-stop-root', null, true);
                await this.createActiveSession('mc-stop-child', 'mc-stop-root', true);
                await this.createActiveSession('mc-stop-grandchild', 'mc-stop-root', false);
                return;
            case 'owner-death':
                await this.createActiveSession('mc-stop-root', null, false);
                await this.createActiveSession('mc-stop-child', 'mc-stop-root', false);
                await this.createActiveSession('mc-stop-grandchild', 'mc-stop-child', false);
                return;
        }
    }

    async release(handleId: string): Promise<void> {
        const handle = this.handles.get(handleId);
        if (handle === undefined) throw new TypeError(`unknown owner fixture handle: ${handleId}`);
        handle.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    async spawnChild(parentId: string, childId: string): Promise<void> {
        await this.createActiveSession(childId, parentId, true);
    }

    async close(): Promise<void> {
        for (const handle of this.handles.values()) handle.resolve();
        await Promise.all(this.attachments.map((attachment) => attachment.detach()));
        await this.host?.close();
        this.runtime.close();
    }

    private async createActiveSession(sessionId: string, parentId: string | null, cooperative: boolean): Promise<void> {
        await this.append(sessionId, [sessionStarted(sessionId), sessionRunStarted(sessionId)]);
        await this.setParent(sessionId, parentId);
        const deferred = createDeferredHandle();
        const generation = (this.generations.get(sessionId) ?? 0) + 1;
        this.generations.set(sessionId, generation);
        const handleId = `provider:${sessionId}${generation === 1 ? '' : `:${generation}`}`;
        this.handles.set(handleId, deferred);
        const host = this.requireHost();
        this.attachments.push(
            await host.attachEntity({
                sessionId,
                kind: 'run',
                entityId: `run-${sessionId}`,
                handles: [
                    {
                        kind: 'provider',
                        handleId,
                        abort: (context) => {
                            if (cooperative && context.kind === 'operator_stop') deferred.resolve();
                        },
                        settled: deferred.promise,
                        writeSettlement: (client, context) => writeInterruptedRun(client, sessionId, context),
                    },
                ],
            }),
        );
    }

    private async createBlockedSession(sessionId: string, parentId: string): Promise<void> {
        await this.append(sessionId, blockedSessionEvents(sessionId));
        await this.setParent(sessionId, parentId);
        const host = this.requireHost();
        const deferred = createDeferredHandle();
        const handleId = `provider:${sessionId}`;
        this.handles.set(handleId, deferred);
        this.attachments.push(
            await host.attachEntity({
                sessionId,
                kind: 'approval',
                entityId: 'approval-blocked',
                handles: [
                    {
                        kind: 'provider',
                        handleId,
                        abort: (context) => {
                            if (context.kind === 'operator_stop') deferred.resolve();
                        },
                        settled: deferred.promise,
                        writeSettlement: (client, context) => writeInterruptedRun(client, sessionId, context),
                    },
                ],
            }),
        );
    }

    private async createQueuedSession(sessionId: string, parentId: string): Promise<void> {
        await this.append(sessionId, [sessionStarted(sessionId)]);
        await this.setParent(sessionId, parentId);
        await runLocalLibsqlWrite(this.runtime, (client) =>
            client
                .execute({
                    sql:
                        'INSERT INTO async_jobs ' +
                        '(job_id,parent_session_id,status,queued_at,metadata_json) VALUES (?,?,?,?,?)',
                    args: [`job-${sessionId}`, sessionId, 'queued', new Date().toISOString(), '{}'],
                })
                .then(() => undefined),
        );
        const host = this.requireHost();
        this.attachments.push(
            await host.attachEntity({ sessionId, kind: 'job', entityId: `job-${sessionId}`, handles: [] }),
        );
    }

    private async append(sessionId: string, events: readonly AgentEvent[]): Promise<void> {
        const store = await openLocalSessionEventStore({ dataDir: this.dataDir, sessionId });
        try {
            for (const event of events) await store.append(event);
        } finally {
            await store.close();
        }
    }

    private async setParent(sessionId: string, parentId: string | null): Promise<void> {
        await runLocalLibsqlWrite(this.runtime, (client) =>
            client
                .execute({
                    sql: 'UPDATE sessions SET parent_session_id = ?, title = ?, workspace_path = ? WHERE session_id = ?',
                    args: [parentId, sessionId, this.dataDir, sessionId],
                })
                .then(() => undefined),
        );
    }

    private requireHost(): SessionControlHost {
        if (this.host === undefined) throw new TypeError('owner fixture host is unavailable');
        return this.host;
    }
}

async function main(): Promise<void> {
    const { dataDir, scenario } = parseOwnerFixtureArgs(process.argv.slice(2));
    const dbPath = `${dataDir}/mission-control.db`;
    const opened = await openCanonicalRuntimeDb({ dataDir });
    const runtime = new OwnerFixtureRuntime(dataDir, opened.runtime);
    runtime.host = new SessionControlHost({
        runtime: opened.runtime,
        dbIdentity: opened.identity.dbIdentity,
        dataDir,
        fenceGraceMs: 5_000,
    });
    await runtime.seed(scenario);
    writeNdjson(createOwnerFixtureReady(scenario, dbPath));
    if (scenario === 'owner-death') return process.stdout.write('', () => process.exit(0));
    const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    let commands = Promise.resolve();
    input.on('line', (line) => {
        commands = commands.then(() => executeCommand(runtime, parseOwnerFixtureCommand(line)));
    });
}

async function executeCommand(runtime: OwnerFixtureRuntime, command: OwnerFixtureCommand): Promise<void> {
    if (command.command === 'release') await runtime.release(command.handleId);
    if (command.command === 'spawn-child') await runtime.spawnChild(command.parentId, command.childId);
    writeNdjson(createOwnerFixtureAck(command.command));
    if (command.command === 'shutdown') {
        await runtime.close();
        process.stdout.write('', () => process.exit(0));
    }
}

function writeNdjson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
