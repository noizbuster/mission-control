import { createDesktopSessionCommandService } from '@mission-control/core';

const ACTION_METHODS = new Map([
    ['submitPrompt', 'submitPrompt'],
    ['interruptRun', 'interruptRun'],
]);

const started = deferred();
const serviceCache = new Map();
const provider = {
    streamTurn() {
        return {
            [Symbol.asyncIterator]() {
                return {
                    next() {
                        started.resolve();
                        return new Promise(() => undefined);
                    },
                    async return() {
                        return { done: true, value: undefined };
                    },
                };
            },
        };
    },
};

for await (const line of readLines(process.stdin)) {
    void handleLine(line);
}

async function handleLine(line) {
    const request = parseStreamRequest(JSON.parse(line));
    try {
        if (request.action === 'waitStarted') {
            await started.promise;
            writeResponse(request.id, {
                sessionId: readString(request.input, 'sessionId'),
                status: 'completed',
                eventsWritten: 0,
            });
            return;
        }
        const method = ACTION_METHODS.get(request.action);
        if (method === undefined) {
            throw new Error(`unsupported desktop test action: ${request.action}`);
        }
        const receipt = await commandService(request)[method](request.input);
        writeResponse(request.id, receipt);
    } catch (error) {
        writeError(request.id, error);
    }
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

function commandService(request) {
    const cacheKey = [request.dataDir, request.workspaceRoot].join('\0');
    const cached = serviceCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const service = createDesktopSessionCommandService({
        dataDir: request.dataDir,
        workspaceRoot: request.workspaceRoot,
        provider,
    });
    serviceCache.set(cacheKey, service);
    return service;
}

function parseStreamRequest(value) {
    if (!isRecord(value)) {
        throw new Error('desktop stream command request must be an object');
    }
    return {
        id: readNumber(value, 'id'),
        action: readString(value, 'action'),
        input: readRecord(value, 'input'),
        dataDir: readString(value, 'dataDir'),
        workspaceRoot: readString(value, 'workspaceRoot'),
    };
}

function readRecord(value, key) {
    const field = value[key];
    if (!isRecord(field)) {
        throw new Error(`desktop command field ${key} must be an object`);
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

function readString(value, key) {
    const field = value[key];
    if (typeof field !== 'string' || field.length === 0) {
        throw new Error(`desktop command field ${key} must be a non-empty string`);
    }
    return field;
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeResponse(id, result) {
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function writeError(id, error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ id, error: message })}\n`);
}

function deferred() {
    let resolve = () => undefined;
    const promise = new Promise((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}
