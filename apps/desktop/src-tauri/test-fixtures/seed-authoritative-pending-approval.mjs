/**
 * Test-only seeder for Tauri desktop approval bridge tests.
 *
 * Modes:
 * - pending-approval: openLocalSessionEventStore + store.append of tool call,
 *   permission, approval, and blocked run so desktop_tool_proposals is minted.
 * - imported-approval: the same events seeded through
 *   importSessionEnvelopesToLocalStore — envelopes only, NO proposals minted —
 *   reproducing an imported session whose approvals must stay inert.
 * - unknown-effect: reserve + claim + process restart so the effect becomes
 *   durable unknown for operator resolution without tool replay.
 *
 * Only the imported-approval mode may use appendEnvelopeWithStoreSequence (the
 * non-authoritative import path); every other mode stays authoritative.
 */
import { importSessionEnvelopesToLocalStore, openLocalSessionEventStore } from '@mission-control/core';
const TIMESTAMP = '2026-06-09T00:00:00.000Z';
const MODEL = { providerID: 'mock', modelID: 'mission-control-demo' };

try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === 'pending-approval') {
        await seedPendingApproval(args);
    } else if (args.mode === 'imported-approval') {
        await seedImportedApproval(args);
    } else if (args.mode === 'unknown-effect') {
        await seedUnknownEffect(args);
    } else {
        throw new Error(`unsupported mode: ${args.mode}`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, mode: args.mode })}\n`);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

async function seedPendingApproval(args) {
    const toolCall = buildToolCall(args);
    const store = await openLocalSessionEventStore({
        dataDir: args.dataDir,
        sessionId: args.sessionId,
        now: () => TIMESTAMP,
    });
    try {
        for (const event of [
            providerToolCallEvent(args.sessionId, toolCall),
            permissionRequestedEvent(args.sessionId, toolCall),
            approvalRequestedEvent(args.sessionId, toolCall, args.approvalId),
            runBlockedEvent(args.sessionId, toolCall.toolCallId),
        ]) {
            await store.append(event);
        }
    } finally {
        await store.close();
    }
}

async function seedImportedApproval(args) {
    const toolCall = buildToolCall(args);
    const events = [
        providerToolCallEvent(args.sessionId, toolCall),
        permissionRequestedEvent(args.sessionId, toolCall),
        approvalRequestedEvent(args.sessionId, toolCall, args.approvalId),
        runBlockedEvent(args.sessionId, toolCall.toolCallId),
    ];
    const result = await importSessionEnvelopesToLocalStore({
        dataDir: args.dataDir,
        sessionId: args.sessionId,
        envelopes: events.map((event, index) => ({
            eventId: `imported_seed_${index}`,
            sequence: index,
            createdAt: TIMESTAMP,
            sessionId: args.sessionId,
            durability: 'durable',
            event,
        })),
    });
    if (result !== 'imported') {
        throw new Error(`expected fresh import, got: ${result}`);
    }
}

async function seedUnknownEffect(args) {
    const claimedAt = args.claimedAt ?? '2026-07-15T03:00:00.000Z';
    const leaseExpiresAt = args.leaseExpiresAt ?? '2026-07-15T03:01:00.000Z';
    const recoveredAt = args.recoveredAt ?? '2026-07-15T03:02:00.000Z';
    const toolCallId = deriveToolCallId(args.approvalId);
    const effect = {
        sessionId: args.sessionId,
        approvalId: args.approvalId,
        runId: args.runId ?? `run_${toolCallId}`,
        toolCallId,
        toolName: args.toolName ?? 'command.run',
        argumentsJson:
            args.argumentsJson ??
            JSON.stringify({ command: 'node', args: ['--eval', "console.log('should-not-run')"] }),
        workspaceRoot: args.workspaceRoot ?? '/workspace',
    };

    const first = await openLocalSessionEventStore({
        dataDir: args.dataDir,
        sessionId: args.sessionId,
        now: () => claimedAt,
    });
    try {
        await first.reserveDesktopApprovalEffect(effect);
        await first.claimDesktopApprovalEffect({
            effect,
            executionToken: args.executionToken ?? `execution_token_${toolCallId}`,
            leaseExpiresAt,
        });
    } finally {
        await first.close();
    }

    // Re-open after the lease window so recoverExpiredDesktopApprovalEffects marks unknown.
    const recovery = await openLocalSessionEventStore({
        dataDir: args.dataDir,
        sessionId: args.sessionId,
        now: () => recoveredAt,
    });
    await recovery.close();
}

function buildToolCall(args) {
    const toolCallId = deriveToolCallId(args.approvalId);
    if (args.tool === 'file.patch') {
        const filePath = args.filePath ?? 'approved.txt';
        const content = args.content ?? 'approved write';
        return {
            toolCallId,
            toolName: 'file.patch',
            argumentsJson: JSON.stringify({
                patch: [
                    `diff --git a/${filePath} b/${filePath}`,
                    '--- /dev/null',
                    `+++ b/${filePath}`,
                    '@@ -0,0 +1 @@',
                    `+${content}`,
                    '',
                ].join('\n'),
            }),
        };
    }
    if (args.tool === 'command.run') {
        return {
            toolCallId,
            toolName: 'command.run',
            argumentsJson: JSON.stringify({
                command: 'node',
                args: ['--eval', "console.log('mission-control command.run harness ok')"],
            }),
        };
    }
    throw new Error(`unsupported tool: ${args.tool}`);
}

function deriveToolCallId(approvalId) {
    const requestId = approvalId.startsWith('approval_') ? approvalId.slice('approval_'.length) : approvalId;
    return requestId.startsWith('permission_') ? requestId.slice('permission_'.length) : requestId;
}

function providerToolCallEvent(sessionId, toolCall) {
    return {
        type: 'model.call.completed',
        timestamp: TIMESTAMP,
        sessionId,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: MODEL,
        providerStreamChunk: {
            kind: 'tool_call_completed',
            requestId: 'request_seed',
            sequence: 1,
            toolCall,
        },
    };
}

function permissionRequestedEvent(sessionId, toolCall) {
    const requestId = `permission_${toolCall.toolCallId}`;
    return {
        type: 'permission.requested',
        timestamp: TIMESTAMP,
        sessionId,
        message: `permission requested: ${toolCall.toolName}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: MODEL,
        permissionRequest: {
            id: requestId,
            action: toolCall.toolName,
            reason: `approve ${toolCall.toolName}`,
        },
        permissionDecision: {
            requestId,
            status: 'requires_approval',
            reason: 'approval required',
        },
    };
}

function approvalRequestedEvent(sessionId, toolCall, approvalId) {
    return {
        type: 'approval.requested',
        timestamp: TIMESTAMP,
        sessionId,
        message: `approval requested: ${toolCall.toolName}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: MODEL,
        approvalRecord: {
            approvalId,
            requestId: `permission_${toolCall.toolCallId}`,
            policyDecision: 'requires_approval',
            state: 'pending',
            subject: { kind: 'tool', id: toolCall.toolName },
            requestedAt: TIMESTAMP,
            reason: `approve ${toolCall.toolName}`,
        },
    };
}

function runBlockedEvent(sessionId, toolCallId) {
    return {
        type: 'run.blocked',
        timestamp: TIMESTAMP,
        sessionId,
        message: 'waiting for approval',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: MODEL,
        run: {
            command: 'run',
            state: 'blocked_on_approval',
            runId: `run_${toolCallId}`,
            reason: 'waiting for approval',
            toolCallId,
        },
    };
}

function parseArgs(argv) {
    const out = { mode: 'pending-approval' };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) {
            throw new Error(`unexpected argument: ${token}`);
        }
        const key = token.slice(2);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`missing value for --${key}`);
        }
        out[key] = value;
        index += 1;
    }
    requireArg(out, 'dataDir');
    requireArg(out, 'sessionId');
    requireArg(out, 'approvalId');
    if (out.mode === 'pending-approval') {
        requireArg(out, 'tool');
    }
    return out;
}

function requireArg(args, key) {
    if (typeof args[key] !== 'string' || args[key].length === 0) {
        throw new Error(`missing required --${key}`);
    }
}
