import {
    createDesktopSessionCommandService,
    createProviderAuthStore,
    createProviderAuthStoreCredentialResolver,
    createProviderRouter,
} from '@mission-control/core';

const ACTION_METHODS = new Map([
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
