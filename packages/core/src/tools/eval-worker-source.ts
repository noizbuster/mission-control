/**
 * Inline source for the eval worker thread, evaluated via `new Worker(source, { eval: true })`.
 * Kept as a data asset separate from the TypeScript manager so the worker script
 * (which cannot be type-checked) is isolated from host logic. Runs as a classic
 * script where `require` is available, so no separate worker entry file is needed.
 */
export const EVAL_WORKER_SOURCE = `
'use strict';
const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');

const OUTPUT_CAP = 65536;
let context = null;
let runBuffer = '';
let runCapped = false;

function appendToBuffer(text) {
    if (runCapped) {
        return;
    }
    if (runBuffer.length + text.length > OUTPUT_CAP) {
        runBuffer = runBuffer + text.slice(0, OUTPUT_CAP - runBuffer.length);
        runCapped = true;
        return;
    }
    runBuffer = runBuffer + text;
}

function formatArg(arg) {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg === null) {
        return 'null';
    }
    if (arg === undefined) {
        return 'undefined';
    }
    if (arg instanceof Error) {
        return arg.message;
    }
    if (typeof arg === 'function') {
        return '[Function]';
    }
    try {
        return JSON.stringify(arg);
    } catch (e) {
        return String(arg);
    }
}

function consoleArgsToString(args) {
    let out = '';
    for (let i = 0; i < args.length; i += 1) {
        if (i > 0) {
            out += ' ';
        }
        out += formatArg(args[i]);
    }
    return out + '\\n';
}

function ensureContext() {
    if (context) {
        return context;
    }
    context = vm.createContext({});
    const sandbox = context;
    sandbox.console = {
        log: function () { appendToBuffer(consoleArgsToString(arguments)); },
        error: function () { appendToBuffer(consoleArgsToString(arguments)); },
        warn: function () { appendToBuffer(consoleArgsToString(arguments)); },
        info: function () { appendToBuffer(consoleArgsToString(arguments)); },
        debug: function () { appendToBuffer(consoleArgsToString(arguments)); }
    };
    return context;
}

function formatValue(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined) {
        return '';
    }
    if (value === null) {
        return 'null';
    }
    if (value instanceof Error) {
        return value.message;
    }
    if (typeof value === 'function') {
        return value.toString();
    }
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function runCode(runId, code) {
    runBuffer = '';
    runCapped = false;
    const ctx = ensureContext();
    let value;
    try {
        value = vm.runInContext(code, ctx, { filename: 'eval-cell.js' });
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        parentPort.postMessage({ type: 'result', runId: runId, ok: false, output: runBuffer, error: message });
        return;
    }
    if (value !== undefined) {
        const formatted = formatValue(value);
        if (formatted.length > 0) {
            appendToBuffer(formatted + '\\n');
        }
    }
    parentPort.postMessage({ type: 'result', runId: runId, ok: true, output: runBuffer });
}

parentPort.on('message', function (message) {
    if (!message || typeof message !== 'object') {
        return;
    }
    const type = message.type;
    if (type === 'init') {
        ensureContext();
        parentPort.postMessage({ type: 'ready' });
        return;
    }
    if (type === 'run') {
        runCode(message.runId, message.code);
        return;
    }
    if (type === 'close') {
        context = null;
        parentPort.removeAllListeners('message');
        process.exit(0);
    }
});
`;
