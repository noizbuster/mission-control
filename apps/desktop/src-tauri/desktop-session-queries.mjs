import { openLocalSessionProjectionStore, readLocalSessionReplay } from '@mission-control/core';

export async function listSessions(dataDir, observabilityRedactor) {
    const store = await openLocalSessionProjectionStore({ dataDir });
    try {
        const records = await store.listSessions();
        const summaries = [];
        for (const record of records) {
            summaries.push(await sessionSummary(dataDir, store, record, observabilityRedactor));
        }
        return summaries;
    } finally {
        store.close();
    }
}

export async function readSessionEvents(dataDir, sessionId, observabilityRedactor) {
    assertSessionId(sessionId);
    const replay = await readLocalSessionReplay({ dataDir, sessionId, observabilityRedactor });
    if (replay.kind === 'missing') {
        const record = await readSessionRecord(dataDir, sessionId);
        return {
            sessionId,
            state: record === undefined ? 'missing' : stateForEventCount(record.eventCount, []),
            contents: '',
            envelopes: [],
            diagnostics: record?.diagnostics ?? [],
        };
    }
    return {
        sessionId,
        state: stateForProjection(replay.replay.projection, replay.replay.diagnostics),
        contents: '',
        envelopes: replay.replay.projection.envelopes,
        diagnostics: replay.replay.diagnostics.map(replayDiagnostic),
    };
}

export async function readSessionSnapshot(dataDir, sessionId, observabilityRedactor) {
    assertSessionId(sessionId);
    const store = await openLocalSessionProjectionStore({ dataDir });
    try {
        const record = (await store.getSession(sessionId)) ?? undefined;
        const projectionDiagnostics = (await store.getDiagnostics(sessionId)).map(projectionDiagnostic);
        const replay = await readLocalSessionReplay({ dataDir, sessionId, observabilityRedactor });
        if (replay.kind === 'missing') {
            return {
                sessionId,
                state: record === undefined ? 'missing' : stateForEventCount(record.eventCount, projectionDiagnostics),
                ...(record?.status !== undefined ? { status: record.status } : {}),
                ...statusTextFields(record),
                ...(record?.awaiting !== undefined ? { awaiting: record.awaiting } : {}),
                eventCount: record?.eventCount ?? 0,
                graphIds: [],
                ...(record?.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
                diagnostics: projectionDiagnostics,
            };
        }
        const projection = replay.replay.projection;
        const diagnostics = [...replay.replay.diagnostics.map(replayDiagnostic), ...projectionDiagnostics];
        return {
            sessionId,
            state: stateForProjection(projection, diagnostics),
            status: record?.status ?? projection.snapshot.status,
            ...statusTextFields(record, projection.snapshot),
            ...(record?.awaiting !== undefined
                ? { awaiting: record.awaiting }
                : projection.snapshot.awaiting !== undefined
                  ? { awaiting: projection.snapshot.awaiting }
                  : {}),
            eventCount: projection.events.length,
            graphIds: projection.graphSnapshots.map((snapshot) => snapshot.graphId),
            updatedAt: record?.updatedAt ?? projection.events.at(-1)?.timestamp ?? projection.snapshot.startedAt,
            diagnostics,
            sessionTree: sessionTreeSummary(projection.sessionTree),
            stats: statsFromProjection(projection),
        };
    } finally {
        store.close();
    }
}

async function sessionSummary(dataDir, store, record, observabilityRedactor) {
    const projectionDiagnostics = (await store.getDiagnostics(record.sessionId)).map(projectionDiagnostic);
    const replay = await readLocalSessionReplay({
        dataDir,
        sessionId: record.sessionId,
        observabilityRedactor,
    });
    if (replay.kind === 'missing') {
        return {
            sessionId: record.sessionId,
            fileName: record.sessionId,
            state: stateForEventCount(record.eventCount, projectionDiagnostics),
            status: record.status,
            ...statusTextFields(record),
            ...(record.awaiting !== undefined ? { awaiting: record.awaiting } : {}),
            eventCount: record.eventCount,
            updatedAt: record.updatedAt,
            diagnostics: projectionDiagnostics,
        };
    }
    const projection = replay.replay.projection;
    const diagnostics = [...replay.replay.diagnostics.map(replayDiagnostic), ...projectionDiagnostics];
    return {
        sessionId: record.sessionId,
        fileName: record.sessionId,
        state: stateForProjection(projection, diagnostics),
        status: record.status,
        ...statusTextFields(record, projection.snapshot),
        ...(record.awaiting !== undefined
            ? { awaiting: record.awaiting }
            : projection.snapshot.awaiting !== undefined
              ? { awaiting: projection.snapshot.awaiting }
              : {}),
        eventCount: projection.events.length,
        updatedAt: record.updatedAt,
        diagnostics,
        sessionTree: sessionTreeSummary(projection.sessionTree),
        stats: statsFromProjection(projection),
    };
}

async function readSessionRecord(dataDir, sessionId) {
    const store = await openLocalSessionProjectionStore({ dataDir });
    try {
        const record = (await store.getSession(sessionId)) ?? undefined;
        if (record === undefined) {
            return undefined;
        }
        return {
            ...record,
            diagnostics: (await store.getDiagnostics(sessionId)).map(projectionDiagnostic),
        };
    } finally {
        store.close();
    }
}

function stateForProjection(projection, diagnostics) {
    if (diagnostics.length > 0 || projection.diagnostics.length > 0) {
        return 'corrupt';
    }
    return projection.envelopes.length > 0 ? 'available' : 'empty';
}

function stateForEventCount(eventCount, diagnostics) {
    if (diagnostics.length > 0) {
        return 'corrupt';
    }
    return eventCount > 0 ? 'available' : 'empty';
}

function statusTextFields(record, snapshot) {
    const status = record?.status ?? snapshot?.status;
    const awaiting = record?.awaiting ?? snapshot?.awaiting;
    if (status === 'awaiting' && awaiting?.reason !== undefined) {
        return { statusText: `awaiting ${awaiting.reason.replaceAll('_', ' ')}` };
    }
    return {};
}

function sessionTreeSummary(sessionTree) {
    return {
        ...(sessionTree.sessionName !== undefined ? { sessionName: sessionTree.sessionName } : {}),
        ...(sessionTree.cwd !== undefined ? { cwd: sessionTree.cwd } : {}),
        ...(sessionTree.trustedRoot !== undefined ? { trustedRoot: sessionTree.trustedRoot } : {}),
        ...(sessionTree.workspaceTrust !== undefined ? { workspaceTrust: sessionTree.workspaceTrust } : {}),
        ...(sessionTree.parentSessionId !== undefined ? { parentSessionId: sessionTree.parentSessionId } : {}),
        ...(sessionTree.activeLeafId !== undefined ? { activeLeafId: sessionTree.activeLeafId } : {}),
        entryCount: sessionTree.nodes.length,
        branchCount: branchCount(sessionTree),
        ...(sessionTree.forkSource?.sessionId !== undefined
            ? { forkSourceSessionId: sessionTree.forkSource.sessionId }
            : {}),
        ...(sessionTree.cloneSource?.sessionId !== undefined
            ? { cloneSourceSessionId: sessionTree.cloneSource.sessionId }
            : {}),
    };
}

function branchCount(sessionTree) {
    if (sessionTree.nodes.length === 0) {
        return 0;
    }
    const leafCount = sessionTree.nodes.filter((node) => node.childEntryIds.length === 0).length;
    return leafCount > 0 ? leafCount : 1;
}

function statsFromProjection(projection) {
    return {
        eventCount: projection.events.length,
        pendingApprovalCount: projection.approvals.filter((approval) => approval.state === 'pending').length,
        blockedRunCount: currentBlockedRunCount(projection.codingSteps),
        commandEventCount: projection.events.filter((event) => event.command !== undefined).length,
        diffEventCount: projection.events.filter((event) => (event.diffFiles?.length ?? 0) > 0).length,
        toolOutcomeCount: projection.toolOutcomes.length,
    };
}

function currentBlockedRunCount(steps) {
    const blockedRunIds = new Set();
    for (const step of steps) {
        if (step.kind !== 'run.state' || step.runId === undefined) {
            continue;
        }
        if (step.state === 'blocked_on_approval') {
            blockedRunIds.add(step.runId);
            continue;
        }
        if (step.state === 'running' || step.state === 'idle') {
            blockedRunIds.delete(step.runId);
        }
    }
    return blockedRunIds.size;
}

function projectionDiagnostic(diagnostic) {
    return {
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.lineNumber !== undefined ? { lineNumber: diagnostic.lineNumber } : {}),
    };
}

function replayDiagnostic(diagnostic) {
    return {
        code: diagnostic.code,
        message: replayDiagnosticMessage(diagnostic),
        ...(diagnostic.lineNumber !== undefined ? { lineNumber: diagnostic.lineNumber } : {}),
    };
}

function replayDiagnosticMessage(diagnostic) {
    switch (diagnostic.code) {
        case 'corrupt_trailing_record':
            return 'session replay stopped at a corrupt trailing record';
        case 'missing_provider_continuation':
            return 'provider tool call is missing a continuation message';
        default:
            return diagnostic.code;
    }
}

function assertSessionId(sessionId) {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        throw new Error('desktop command field sessionId must be a safe session id');
    }
}
