export function sessionStartedEvent(sessionId: string) {
    return {
        type: 'session.started' as const,
        timestamp: '2026-06-13T00:00:00.000Z',
        sessionId,
        message: 'smoke session started',
        nativeSidecarStatus: 'mock' as const,
    };
}

export function providerToolCallEvent(sessionId: string, toolCallId: string) {
    return {
        type: 'model.call.completed' as const,
        timestamp: '2026-06-13T00:00:01.000Z',
        sessionId,
        message: 'tool call completed: file.patch',
        nativeSidecarStatus: 'mock' as const,
        modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        providerStreamChunk: {
            kind: 'tool_call_completed' as const,
            requestId: 'provider_request_smoke_patch',
            sequence: 1,
            toolCall: {
                toolCallId,
                toolName: 'file.patch',
                argumentsJson: '{"patch":"diff --git a/.smoke-approved.txt b/.smoke-approved.txt"}',
            },
        },
    };
}

export function permissionRequestedEvent(sessionId: string, toolCallId: string) {
    return {
        type: 'permission.requested' as const,
        timestamp: '2026-06-13T00:00:02.000Z',
        sessionId,
        message: 'permission requested: file.patch',
        nativeSidecarStatus: 'mock' as const,
        permissionRequest: {
            id: `permission_${toolCallId}`,
            action: 'file.patch',
            reason: 'approve file.patch',
            permission: {
                kind: 'write' as const,
                patterns: ['.smoke-approved.txt'],
                workspaceRoot: '/tmp/smoke-workspace',
            },
        },
        permissionDecision: {
            requestId: `permission_${toolCallId}`,
            status: 'requires_approval' as const,
            reason: 'approval required',
        },
    };
}

export function runBlockedEvent(sessionId: string, toolCallId: string) {
    return {
        type: 'run.blocked' as const,
        timestamp: '2026-06-13T00:00:03.000Z',
        sessionId,
        message: 'waiting for approval: file.patch',
        nativeSidecarStatus: 'mock' as const,
        run: {
            command: 'run' as const,
            state: 'blocked_on_approval' as const,
            runId: 'run_smoke_blocked',
            reason: 'waiting for approval: file.patch',
            toolCallId,
        },
    };
}
