import {
    createDesktopSessionCommandService,
    createLocalSessionIndexStore,
    createProviderAuthStore,
    createProviderAuthStoreCredentialResolver,
    createProviderRouter,
    readLocalSessionReplay,
} from '@mission-control/core';

const ACTION_METHODS = new Map([
    ['listSessions', 'listSessions'],
    ['readSessionEvents', 'readSessionEvents'],
    ['readSessionSnapshot', 'readSessionSnapshot'],
    ['submitPrompt', 'submitPrompt'],
    ['queueFollowUp', 'queueFollowUp'],
    ['steerRun', 'steerRun'],
    ['resumeRun', 'resumeRun'],
    ['interruptRun', 'interruptRun'],
    ['decideApproval', 'decideApproval'],
    ['listProviderCredentials', 'listProviderCredentials'],
    ['saveProviderCredential', 'saveProviderCredential'],
]);

try {
    if (process.argv.includes('--stream')) {
        await runStreamBridge();
    } else {
        await runOneShotBridge();
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

async function runOneShotBridge() {
    const context = createBridgeContext();
    const request = parseRequest(JSON.parse(await readStdin()));
    process.stdout.write(JSON.stringify(await executeRequest(request, context)));
}

async function runStreamBridge() {
    const context = createBridgeContext();
    for await (const line of readLines(process.stdin)) {
        void handleStreamLine(line, context);
    }
}

async function handleStreamLine(line, context) {
    let request;
    try {
        request = parseStreamRequest(JSON.parse(line));
        const result = await executeRequest(request, context);
        writeStreamResponse(request.id, result);
    } catch (error) {
        if (request === undefined) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`${message}\n`);
            return;
        }
        writeStreamError(request.id, error);
    }
}

async function executeRequest(request, context) {
    if (request.method === 'listSessions') {
        return listSessions(request.dataDir);
    }
    if (request.method === 'readSessionEvents') {
        return readSessionEvents(request.dataDir, readString(request.input, 'sessionId'));
    }
    if (request.method === 'readSessionSnapshot') {
        return readSessionSnapshot(request.dataDir, readString(request.input, 'sessionId'));
    }
    if (request.method === 'listProviderCredentials') {
        return context.authStore.listCredentialSummaries();
    }
    if (request.method === 'saveProviderCredential') {
        await context.authStore.saveCredential({
            providerID: readString(request.input, 'providerID'),
            modelID: readString(request.input, 'modelID'),
            ...readOptionalStringField(request.input, 'variantID'),
            apiKey: readString(request.input, 'apiKey'),
            now: new Date().toISOString(),
        });
        return savedCredentialSummary(context.authStore, readString(request.input, 'providerID'));
    }
    const service = commandService(request, context);
    return service[request.method](request.input);
}

async function listSessions(dataDir) {
    const store = await createLocalSessionIndexStore({ dataDir });
    try {
        const records = await store.listSessions();
        const summaries = [];
        for (const record of records) {
            summaries.push(await sessionSummary(dataDir, store, record));
        }
        return summaries;
    } finally {
        store.close();
    }
}

async function readSessionEvents(dataDir, sessionId) {
    assertSessionId(sessionId);
    const replay = await readLocalSessionReplay({ dataDir, sessionId });
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

async function readSessionSnapshot(dataDir, sessionId) {
    assertSessionId(sessionId);
    const store = await createLocalSessionIndexStore({ dataDir });
    try {
        const record = (await store.getSession(sessionId)) ?? undefined;
        const indexDiagnostics = (await store.getDiagnostics(sessionId)).map(indexDiagnostic);
        const replay = await readLocalSessionReplay({ dataDir, sessionId });
        if (replay.kind === 'missing') {
            return {
                sessionId,
                state: record === undefined ? 'missing' : stateForEventCount(record.eventCount, indexDiagnostics),
                ...(record?.status !== undefined ? { status: record.status } : {}),
                ...statusTextFields(record),
                ...(record?.awaiting !== undefined ? { awaiting: record.awaiting } : {}),
                eventCount: record?.eventCount ?? 0,
                graphIds: [],
                ...(record?.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
                diagnostics: indexDiagnostics,
            };
        }
        const projection = replay.replay.projection;
        const diagnostics = [...replay.replay.diagnostics.map(replayDiagnostic), ...indexDiagnostics];
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

async function sessionSummary(dataDir, store, record) {
    const indexDiagnostics = (await store.getDiagnostics(record.sessionId)).map(indexDiagnostic);
    const replay = await readLocalSessionReplay({ dataDir, sessionId: record.sessionId });
    if (replay.kind === 'missing') {
        return {
            sessionId: record.sessionId,
            fileName: `${record.sessionId}.jsonl`,
            state: stateForEventCount(record.eventCount, indexDiagnostics),
            status: record.status,
            ...statusTextFields(record),
            ...(record.awaiting !== undefined ? { awaiting: record.awaiting } : {}),
            eventCount: record.eventCount,
            updatedAt: record.updatedAt,
            diagnostics: indexDiagnostics,
        };
    }
    const projection = replay.replay.projection;
    const diagnostics = [...replay.replay.diagnostics.map(replayDiagnostic), ...indexDiagnostics];
    return {
        sessionId: record.sessionId,
        fileName: `${record.sessionId}.jsonl`,
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
    const store = await createLocalSessionIndexStore({ dataDir });
    try {
        const record = (await store.getSession(sessionId)) ?? undefined;
        if (record === undefined) {
            return undefined;
        }
        return {
            ...record,
            diagnostics: (await store.getDiagnostics(sessionId)).map(indexDiagnostic),
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

function indexDiagnostic(diagnostic) {
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

function createBridgeContext() {
    const authStore = createProviderAuthStore();
    const credentialResolver = createProviderAuthStoreCredentialResolver(authStore);
    return {
        authStore,
        provider: createProviderRouter(credentialResolver),
        services: new Map(),
    };
}

function commandService(request, context) {
    const cacheKey = [request.dataDir, request.workspaceRoot].join('\0');
    const cached = context.services.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const service = createDesktopSessionCommandService({
        dataDir: request.dataDir,
        workspaceRoot: request.workspaceRoot,
        provider: context.provider,
    });
    context.services.set(cacheKey, service);
    return service;
}

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function* readLines(stream) {
    let buffer = '';
    for await (const chunk of stream) {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (line.length > 0) {
                yield line;
            }
        }
    }
    if (buffer.length > 0) {
        yield buffer;
    }
}

function parseRequest(value) {
    if (!isRecord(value)) {
        throw new Error('desktop command request must be an object');
    }
    const action = readString(value, 'action');
    const method = ACTION_METHODS.get(action);
    if (method === undefined) {
        throw new Error(`unsupported desktop command action: ${action}`);
    }
    const input = readRecord(value, 'input');
    return {
        method,
        input,
        dataDir: readString(value, 'dataDir'),
        workspaceRoot: readString(value, 'workspaceRoot'),
    };
}

function parseStreamRequest(value) {
    return {
        id: readNumber(value, 'id'),
        ...parseRequest(value),
    };
}

function readRecord(value, key) {
    const field = value[key];
    if (!isRecord(field)) {
        throw new Error(`desktop command field ${key} must be an object`);
    }
    return field;
}

function readString(value, key) {
    const field = value[key];
    if (typeof field !== 'string' || field.length === 0) {
        throw new Error(`desktop command field ${key} must be a non-empty string`);
    }
    return field;
}

function readNumber(value, key) {
    const field = value[key];
    if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
        throw new Error(`desktop command field ${key} must be a safe integer`);
    }
    return field;
}

function readOptionalStringField(value, key) {
    const field = value[key];
    if (field === undefined) {
        return {};
    }
    if (typeof field !== 'string' || field.length === 0) {
        throw new Error(`desktop command field ${key} must be a non-empty string when provided`);
    }
    return { [key]: field };
}

async function savedCredentialSummary(authStore, providerID) {
    const summary = (await authStore.listCredentialSummaries()).find(
        (credential) => credential.providerID === providerID,
    );
    if (summary === undefined) {
        throw new Error(`saved credential summary missing for ${providerID}`);
    }
    return summary;
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeStreamResponse(id, result) {
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function writeStreamError(id, error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ id, error: message })}\n`);
}
