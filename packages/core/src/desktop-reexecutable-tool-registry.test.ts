import type { ApprovalRecord } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createDesktopGraphToolRegistry } from './desktop-session-commands';
import { createApprovedDesktopToolRegistry } from './desktop-tool-approval-execution';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DESKTOP_REEXECUTABLE_TOOL_NAMES = [
    'repo.read',
    'repo.list',
    'repo.search',
    'read',
    'ls',
    'grep',
    'find',
    'repo.read.tagged',
    'glob',
    'ripgrep',
    'file.edit',
    'file.write',
    'file.patch',
    'hashline_edit',
    'command.run',
] as const;

const DESKTOP_SESSION_BOUND_TOOL_NAMES = [
    'ast_grep',
    'ast_edit',
    'resolve',
    'job',
    'monitor_start',
    'monitor_stop',
    'monitor_list',
    'monitor_output',
    'interactive_bash',
    'shell.session',
    'ssh',
    'checkpoint',
    'rewind',
    'plan_exit',
    'lsp',
    'lsp_rename',
] as const;

describe('desktop re-executable tool registries', () => {
    it('keeps graph advertisement and approval re-execution in exact lockstep', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-registry-lockstep-'));

        try {
            // When
            const graphRegistry = await createDesktopGraphToolRegistry({ workspaceRoot });
            const approvedRegistry = await createApprovedDesktopToolRegistry({
                workspaceRoot,
                record: approvedRecord('call_lockstep', 'file.write'),
            });
            const graphNames = graphRegistry.advertise().map((tool) => tool.name);
            const approvedNames = approvedRegistry.advertise().map((tool) => tool.name);

            // Then
            expect(graphNames).toEqual(DESKTOP_REEXECUTABLE_TOOL_NAMES);
            expect(approvedNames).toEqual(DESKTOP_REEXECUTABLE_TOOL_NAMES);
            expect(approvedNames).toEqual(graphNames);
            for (const toolName of DESKTOP_SESSION_BOUND_TOOL_NAMES) {
                expect(graphNames).not.toContain(toolName);
                expect(approvedNames).not.toContain(toolName);
            }
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('blocks file.write in the graph registry and re-executes it only with the matching approval', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-registry-file-write-'));
        const toolCallId = 'call_desktop_file_write';
        const argumentsJson = JSON.stringify({ path: 'approved.txt', content: 'approved\n' });

        try {
            const graphRegistry = await createDesktopGraphToolRegistry({ workspaceRoot });
            const graphAdvertisement = graphRegistry.advertise().find((tool) => tool.name === 'file.write');
            if (graphAdvertisement === undefined) throw new TypeError('graph registry must advertise file.write');

            // When
            const blocked = await graphRegistry.invoke({
                toolCallId,
                toolName: 'file.write',
                advertisedVersion: graphAdvertisement.version,
                argumentsJson,
            });
            const approvedRegistry = await createApprovedDesktopToolRegistry({
                workspaceRoot,
                record: approvedRecord(toolCallId, 'file.write'),
            });
            const approvedAdvertisement = approvedRegistry.advertise().find((tool) => tool.name === 'file.write');
            if (approvedAdvertisement === undefined) throw new TypeError('approval registry must advertise file.write');
            const executed = await approvedRegistry.invoke({
                toolCallId,
                toolName: 'file.write',
                advertisedVersion: approvedAdvertisement.version,
                argumentsJson,
            });

            // Then
            expect(blocked.result.status).toBe('failed');
            expect(executed.result.status).toBe('completed');
            expect(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8')).toBe('approved\n');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('executes workspace reads without inventing a desktop approval prompt', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-registry-read-'));
        await writeFile(join(workspaceRoot, 'readable.txt'), 'desktop read\n', 'utf8');

        try {
            const graphRegistry = await createDesktopGraphToolRegistry({ workspaceRoot });
            const advertisement = graphRegistry.advertise().find((tool) => tool.name === 'repo.read');
            if (advertisement === undefined) throw new TypeError('graph registry must advertise repo.read');

            // When
            const settlement = await graphRegistry.invoke({
                toolCallId: 'call_desktop_read',
                toolName: 'repo.read',
                advertisedVersion: advertisement.version,
                argumentsJson: JSON.stringify({ path: 'readable.txt', summary: false }),
            });

            // Then
            expect(settlement.result.status).toBe('completed');
            expect(settlement.structuredOutput).toMatchObject({
                kind: 'file',
                path: 'readable.txt',
                content: 'desktop read\n',
            });
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

function approvedRecord(toolCallId: string, toolName: string): ApprovalRecord {
    const requestId = `permission_${toolCallId}`;
    return {
        approvalId: `approval_${requestId}`,
        requestId,
        policyDecision: 'requires_approval',
        state: 'approved',
        subject: { kind: 'tool', id: toolName },
        requestedAt: '2026-07-17T00:00:00.000Z',
        decidedAt: '2026-07-17T00:00:00.000Z',
    };
}
