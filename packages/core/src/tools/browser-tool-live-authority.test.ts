import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectTrustDecision, ProjectTrustLookup, ProjectTrustReader } from '../trust/project-trust-store';
import { createBrowserToolRegistration } from './browser-tool';
import { BrowserHarness, toolContext } from './browser-tool-lifecycle-test-support';

type MutableTrustState = {
    decision: ProjectTrustDecision;
    storeState: ProjectTrustLookup['storeState'];
    lookupFails: boolean;
};

describe('browser tool live authority', () => {
    it('runs an approved action while the live workspace remains trusted', async () => {
        const trust = mutableTrust('trusted');
        const harness = new BrowserHarness();
        const requestPermission = vi.fn(allowPermission);
        const registration = createLiveRegistration(harness, trust.reader, requestPermission);

        const output = await registration.execute({ action: 'extract' }, toolContext());

        expect(output.status).toBe('completed');
        expect(requestPermission).toHaveBeenCalledOnce();
        expect(harness.connections).toHaveLength(1);
    });

    it.each([
        { decision: 'denied' as const, storeState: 'valid' as const },
        { decision: 'unknown' as const, storeState: 'missing' as const },
        { decision: 'unknown' as const, storeState: 'corrupt' as const },
    ])('rejects $decision/$storeState authority before permission or browser work', async ({
        decision,
        storeState,
    }) => {
        const trust = mutableTrust(decision, storeState);
        const harness = new BrowserHarness();
        const requestPermission = vi.fn(allowPermission);
        const registration = createLiveRegistration(harness, trust.reader, requestPermission);

        const execution = registration.execute({ action: 'extract' }, toolContext());

        await expectUntrusted(execution);
        expect(requestPermission).not.toHaveBeenCalled();
        expect(harness.connections).toHaveLength(0);
    });

    it('treats a trust lookup failure as non-retryable untrusted authority', async () => {
        const trust = mutableTrust('trusted');
        trust.state.lookupFails = true;
        const harness = new BrowserHarness();
        const requestPermission = vi.fn(allowPermission);
        const registration = createLiveRegistration(harness, trust.reader, requestPermission);

        const execution = registration.execute({ action: 'extract' }, toolContext());

        await expectUntrusted(execution);
        expect(requestPermission).not.toHaveBeenCalled();
        expect(harness.connections).toHaveLength(0);
    });

    it('closes an existing page and connection exactly once when trust is revoked', async () => {
        const trust = mutableTrust('trusted');
        const harness = new BrowserHarness();
        const requestPermission = vi.fn(allowPermission);
        const registration = createLiveRegistration(harness, trust.reader, requestPermission);
        await registration.execute({ action: 'extract' }, toolContext());
        trust.state.decision = 'denied';

        await expectUntrusted(registration.execute({ action: 'extract' }, toolContext()));
        await expectUntrusted(registration.execute({ action: 'extract' }, toolContext()));

        expect(requestPermission).toHaveBeenCalledOnce();
        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });

    it('catches revocation inside the permission callback before CDP dispatch', async () => {
        const trust = mutableTrust('trusted');
        const harness = new BrowserHarness();
        const requestPermission = vi.fn(async (request: PermissionRequest): Promise<PermissionDecision> => {
            trust.state.decision = 'denied';
            return allowPermission(request);
        });
        const registration = createLiveRegistration(harness, trust.reader, requestPermission);

        const execution = registration.execute({ action: 'extract' }, toolContext());

        await expectUntrusted(execution);
        expect(requestPermission).toHaveBeenCalledOnce();
        expect(harness.connections).toHaveLength(0);
    });

    it.each(
        acquisitionAuthorityCases,
    )('blocks $action when $authorityFailure authority occurs during deferred $acquisition acquisition', async ({
        acquisition,
        authorityFailure,
        input,
    }) => {
        const acquisitionStarted = deferredVoid();
        const releaseAcquisition = deferredVoid();
        const trust = mutableTrust('trusted');
        const acquisitionHook = async (): Promise<void> => {
            acquisitionStarted.resolve();
            await releaseAcquisition.promise;
        };
        const harness = new BrowserHarness(
            acquisition === 'connect' ? { connectHook: acquisitionHook } : { newPageHook: acquisitionHook },
        );
        const registration = createLiveRegistration(harness, trust.reader, vi.fn(allowPermission));
        const execution = registration.execute(input, toolContext());
        await acquisitionStarted.promise;
        if (authorityFailure === 'revoked') trust.state.decision = 'denied';
        else trust.state.lookupFails = true;

        releaseAcquisition.resolve();

        await expectUntrusted(execution);
        expect(harness.pages).toHaveLength(1);
        expect(harness.pages[0]?.gotoCalls).toBe(0);
        expect(harness.pages[0]?.extractTextCalls).toBe(0);
        expect(harness.pages[0]?.extractHtmlCalls).toBe(0);
        expect(harness.pages[0]?.screenshotCalls).toBe(0);
        expect(harness.pages[0]?.titleCalls).toBe(0);
        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });

    it('rechecks authority after waiting in the browser action queue', async () => {
        const firstStarted = deferredVoid();
        const releaseFirst = deferredVoid();
        const sixthTrustRead = deferredVoid();
        let decision: ProjectTrustDecision = 'trusted';
        let trustReads = 0;
        const projectTrustStore: ProjectTrustReader = {
            getDecision: async (workspaceRoot) => {
                trustReads += 1;
                if (trustReads === 6) sixthTrustRead.resolve();
                return {
                    decision,
                    workspaceRoot,
                    filePath: '/test/trust/projects.json',
                    storeState: 'valid',
                };
            },
        };
        const harness = new BrowserHarness({
            gotoHook: async () => {
                firstStarted.resolve();
                await releaseFirst.promise;
            },
        });
        const requestPermission = vi.fn(allowPermission);
        const registration = createLiveRegistration(harness, projectTrustStore, requestPermission);
        const first = registration.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());
        await firstStarted.promise;
        const queued = registration.execute({ action: 'extract' }, toolContext());
        await sixthTrustRead.promise;
        decision = 'denied';
        const queuedResult = expectUntrusted(queued);

        releaseFirst.resolve();
        expect((await first).status).toBe('completed');
        await queuedResult;

        expect(trustReads).toBe(7);
        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });

    it('creates a fresh connection after revoked authority is restored', async () => {
        const trust = mutableTrust('trusted');
        const harness = new BrowserHarness();
        const requestPermission = vi.fn(allowPermission);
        const registration = createLiveRegistration(harness, trust.reader, requestPermission);
        await registration.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());
        trust.state.decision = 'denied';
        await expectUntrusted(registration.execute({ action: 'extract' }, toolContext()));
        trust.state.decision = 'trusted';

        const output = await registration.execute({ action: 'extract' }, toolContext());

        expect(output.url).toBe('about:blank');
        expect(harness.connections).toHaveLength(2);
        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });
});

const acquisitionAuthorityCases = [
    ...acquisitionCases('connect', 'revoked'),
    ...acquisitionCases('connect', 'lookup-failure'),
    ...acquisitionCases('newPage', 'revoked'),
    ...acquisitionCases('newPage', 'lookup-failure'),
] as const;

function acquisitionCases(acquisition: 'connect' | 'newPage', authorityFailure: 'lookup-failure' | 'revoked') {
    return [
        {
            acquisition,
            authorityFailure,
            action: 'navigate',
            input: { action: 'navigate' as const, url: 'https://page-a.test' },
        },
        { acquisition, authorityFailure, action: 'extract', input: { action: 'extract' as const } },
        { acquisition, authorityFailure, action: 'screenshot', input: { action: 'screenshot' as const } },
    ];
}

function mutableTrust(
    decision: ProjectTrustDecision,
    storeState: ProjectTrustLookup['storeState'] = 'valid',
): { readonly state: MutableTrustState; readonly reader: ProjectTrustReader } {
    const state: MutableTrustState = { decision, storeState, lookupFails: false };
    return {
        state,
        reader: {
            getDecision: async (workspaceRoot) => {
                if (state.lookupFails) throw new Error('trust lookup failed');
                return {
                    decision: state.decision,
                    workspaceRoot,
                    filePath: '/test/trust/projects.json',
                    storeState: state.storeState,
                };
            },
        },
    };
}

function createLiveRegistration(
    harness: BrowserHarness,
    projectTrustStore: ProjectTrustReader,
    requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>,
) {
    const options = {
        workspaceRoot: '/workspace',
        projectTrustStore,
        endpoint: { browserURL: 'http://127.0.0.1:9222' } as const,
        requestPermission,
        connect: harness.connect,
    };
    return createBrowserToolRegistration(options);
}

async function expectUntrusted(execution: unknown): Promise<void> {
    await expect(execution).rejects.toMatchObject({
        message: 'workspace_untrusted: browser authority was revoked',
        error: {
            code: 'tool_failed',
            retryable: false,
        },
    });
}

async function allowPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return { requestId: request.id, status: 'allow' };
}

function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
