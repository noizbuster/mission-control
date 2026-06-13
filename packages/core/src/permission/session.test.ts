import type { PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionSession } from './session.js';
import { PermissionRuleStore } from './store.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PermissionSession', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
        roots.length = 0;
    });

    it('uses the last matching rule for a permission pattern', async () => {
        const session = new PermissionSession({
            builtInRules: [
                { permission: 'patch', pattern: '*', decision: 'ask' },
                { permission: 'patch', pattern: 'src/**', decision: 'always' },
            ],
        });

        await expect(session.evaluate(patchRequest('src/app.ts', '/workspace-a'), 'session_a')).resolves.toMatchObject({
            decision: { status: 'allow', matchedRule: { decision: 'always', pattern: 'src/**' } },
        });
        await expect(session.evaluate(patchRequest('README.md', '/workspace-a'), 'session_a')).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    it('consumes built-in once rules after the first matching request in a session', async () => {
        const session = new PermissionSession({
            builtInRules: [{ permission: 'patch', pattern: 'src/**', decision: 'once' }],
        });
        const request = patchRequest('src/app.ts', '/workspace-a');

        const first = await session.evaluate(request, 'session_once_builtin');
        expect(first.decision).toMatchObject({ status: 'allow', matchedRule: { decision: 'once' } });
        session.consumeOnceRules('session_once_builtin', first.consumeOnceRules);

        await expect(session.evaluate(request, 'session_once_builtin')).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
        await expect(session.evaluate(request, 'session_other')).resolves.toMatchObject({
            decision: { status: 'allow', matchedRule: { decision: 'once' } },
        });
    });

    it('consumes persisted once rules after the first matching request in a session', async () => {
        const dataDir = await tempRoot('mctrl-permission-store-');
        const store = new PermissionRuleStore({ dataDir });
        const workspaceRoot = await tempRoot('mctrl-permission-workspace-');
        await store.appendRules([{ permission: 'patch', pattern: 'src/**', decision: 'once', workspaceRoot }]);

        const session = new PermissionSession({ persistedRuleStore: store });
        const request = patchRequest('src/app.ts', workspaceRoot);

        const first = await session.evaluate(request, 'session_once_persisted');
        expect(first.decision).toMatchObject({ status: 'allow', matchedRule: { decision: 'once' } });
        session.consumeOnceRules('session_once_persisted', first.consumeOnceRules);

        await expect(session.evaluate(request, 'session_once_persisted')).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
        await expect(session.evaluate(request, 'session_once_other')).resolves.toMatchObject({
            decision: { status: 'allow', matchedRule: { decision: 'once' } },
        });
    });

    it('scopes persisted always rules to the normalized workspace root', async () => {
        const dataDir = await tempRoot('mctrl-permission-store-');
        const store = new PermissionRuleStore({ dataDir });
        const firstWorkspace = await tempRoot('mctrl-permission-workspace-a-');
        const secondWorkspace = await tempRoot('mctrl-permission-workspace-b-');
        const session = new PermissionSession({ persistedRuleStore: store });

        await session.rememberReply(patchRequest('src/app.ts', firstWorkspace), 'session_a', {
            approvalId: 'approval_patch',
            reply: 'always',
            reason: 'persist',
            persist: true,
        });

        const resumed = new PermissionSession({ persistedRuleStore: store });
        await expect(resumed.evaluate(patchRequest('src/app.ts', firstWorkspace), 'session_b')).resolves.toMatchObject({
            decision: { status: 'allow', matchedRule: { workspaceRoot: firstWorkspace } },
        });
        await expect(resumed.evaluate(patchRequest('src/app.ts', secondWorkspace), 'session_c')).resolves.toMatchObject(
            {
                decision: { status: 'requires_approval' },
            },
        );
    });

    it('ignores raw relative persisted workspace roots on load and still matches absolute stored roots', async () => {
        const dataDir = await tempRoot('mctrl-permission-store-');
        const store = new PermissionRuleStore({ dataDir });
        const trustedWorkspace = await tempRoot('mctrl-permission-workspace-trusted-');
        const unrelatedWorkspace = await tempRoot('mctrl-permission-workspace-other-');
        await mkdir(join(dataDir, 'trust'), { recursive: true });
        await writeFile(
            store.filePath,
            `${JSON.stringify(
                {
                    version: 1,
                    rules: [
                        {
                            permission: 'patch',
                            pattern: 'src/app.ts',
                            decision: 'always',
                            workspaceRoot: '.',
                        },
                        {
                            permission: 'patch',
                            pattern: 'src/app.ts',
                            decision: 'always',
                            workspaceRoot: trustedWorkspace,
                        },
                    ],
                },
                null,
                2,
            )}\n`,
            'utf8',
        );

        const session = new PermissionSession({ persistedRuleStore: store });
        await expect(
            session.evaluate(patchRequest('src/app.ts', trustedWorkspace), 'session_relative_root'),
        ).resolves.toMatchObject({
            decision: { status: 'allow', matchedRule: { workspaceRoot: trustedWorkspace, decision: 'always' } },
        });
        await expect(
            session.evaluate(patchRequest('src/app.ts', unrelatedWorkspace), 'session_relative_other'),
        ).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    it('normalizes symlinked persisted workspace roots before matching', async () => {
        const dataDir = await tempRoot('mctrl-permission-store-');
        const store = new PermissionRuleStore({ dataDir });
        const workspaceRoot = await tempRoot('mctrl-permission-workspace-');
        const symlinkRoot = `${workspaceRoot}-link`;
        roots.push(symlinkRoot);
        await symlink(workspaceRoot, symlinkRoot);
        const unrelatedWorkspace = await tempRoot('mctrl-permission-workspace-other-');

        await store.appendRules([
            {
                permission: 'patch',
                pattern: 'src/app.ts',
                decision: 'always',
                workspaceRoot: symlinkRoot,
            },
        ]);

        const session = new PermissionSession({ persistedRuleStore: store });
        await expect(
            session.evaluate(patchRequest('src/app.ts', workspaceRoot), 'session_symlink_root'),
        ).resolves.toMatchObject({
            decision: { status: 'allow', matchedRule: { workspaceRoot, decision: 'always' } },
        });
        await expect(
            session.evaluate(patchRequest('src/app.ts', unrelatedWorkspace), 'session_symlink_other'),
        ).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    it('keeps deny replies session-scoped and does not persist once replies', async () => {
        const dataDir = await tempRoot('mctrl-permission-store-');
        const workspaceRoot = await tempRoot('mctrl-permission-workspace-');
        const store = new PermissionRuleStore({ dataDir });
        const session = new PermissionSession({ persistedRuleStore: store });
        const request = patchRequest('src/app.ts', workspaceRoot);

        await session.rememberReply(request, 'session_a', {
            approvalId: 'approval_patch_deny',
            reply: 'deny',
            reason: 'deny once',
        });
        await expect(session.evaluate(request, 'session_a')).resolves.toMatchObject({
            decision: { status: 'deny', matchedRule: { decision: 'deny' } },
        });

        await session.rememberReply(request, 'session_a', {
            approvalId: 'approval_patch_once',
            reply: 'once',
            reason: 'current request only',
            persist: true,
        });
        await expect(session.evaluate(request, 'session_a')).resolves.toMatchObject({
            decision: { status: 'deny', matchedRule: { decision: 'deny' } },
        });
        const freshSession = new PermissionSession({ persistedRuleStore: store });
        await expect(freshSession.evaluate(request, 'session_b')).resolves.toMatchObject({
            decision: { status: 'requires_approval' },
        });
    });

    async function tempRoot(prefix: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        return root;
    }
});

function patchRequest(path: string, workspaceRoot: string): PermissionRequest {
    return {
        id: `permission_${path.replaceAll('/', '_')}`,
        action: 'file.patch',
        reason: `apply patch to ${path}`,
        permission: {
            kind: 'patch',
            patterns: [path],
            workspaceRoot,
        },
    };
}
