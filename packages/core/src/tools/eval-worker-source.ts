/**
 * Inline source for the eval worker thread, evaluated via `new Worker(source, { eval: true })`.
 * Runs as a classic script where `require` is available, so no separate worker entry
 * file is needed. Owns a persistent `vm` context whose global scope survives across
 * `run` calls (so `var` declarations persist). The prelude injects read-only agent-tool
 * proxies (`read`, `grep`, ...) that re-enter the host through the tool bridge.
 */
export const EVAL_WORKER_SOURCE = `
'use strict';
const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');

const OUTPUT_CAP = 65536;
let context = null;
let runBuffer = '';
let runCapped = false;
let currentRunId = null;
const pendingBridge = new Map();
let bridgeSeq = 0;

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

function installPrelude(sandbox) {
    // Synchronous-looking bridge: posts a tool-call and returns a Promise that the
    // tool-reply handler resolves. Cells must await these (top-level await is
    // enabled for cells containing await).
    function bridgeCall(name, args) {
        var id = 'b' + (bridgeSeq++);
        var runId = currentRunId;
        return new Promise(function (resolve, reject) {
            pendingBridge.set(id, { resolve: resolve, reject: reject });
            parentPort.postMessage({ type: 'tool-call', id: id, runId: runId, name: name, args: args });
        });
    }
    sandbox.__bridgeCall = bridgeCall;
    sandbox.read = function (path) { return bridgeCall('read', { path: path }); };
    sandbox.grep = function (pattern, path) { return bridgeCall('grep', { pattern: pattern, path: path }); };
    sandbox.search = function (pattern, path) { return bridgeCall('search', { pattern: pattern, path: path }); };
    sandbox.find = function (pattern) { return bridgeCall('find', { pattern: pattern }); };
    sandbox.ls = function (path) { return bridgeCall('ls', { path: path }); };
    sandbox.glob = function (pattern) { return bridgeCall('glob', { pattern: pattern }); };
    sandbox['repo.read'] = function (path) { return bridgeCall('repo.read', { path: path }); };
    sandbox['repo.list'] = function (path) { return bridgeCall('repo.list', { path: path }); };
    sandbox['repo.search'] = function (pattern, path) { return bridgeCall('repo.search', { pattern: pattern, path: path }); };
}

function ensureContext() {
    if (context) {
        return context;
    }
    context = vm.createContext({});
    var sandbox = context;
    sandbox.console = {
        log: function () { appendToBuffer(consoleArgsToString(arguments)); },
        error: function () { appendToBuffer(consoleArgsToString(arguments)); },
        warn: function () { appendToBuffer(consoleArgsToString(arguments)); },
        info: function () { appendToBuffer(consoleArgsToString(arguments)); },
        debug: function () { appendToBuffer(consoleArgsToString(arguments)); }
    };
    installPrelude(sandbox);
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

function settleBridge(id, reply) {
    var entry = pendingBridge.get(id);
    if (!entry) {
        return;
    }
    pendingBridge.delete(id);
    if (reply.ok) {
        entry.resolve(reply.value);
    } else {
        entry.reject(new Error(reply.error || 'tool call failed'));
    }
}

function hasTopLevelAwait(code) {
    return /\\bawait\\b/.test(code);
}

function runCode(runId, code) {
    runBuffer = '';
    runCapped = false;
    currentRunId = runId;
    var ctx = ensureContext();
    var wrapped = code;
    var isAsync = hasTopLevelAwait(code);
    if (isAsync) {
        wrapped = '(async function __evalCell__() {\\n' + code + '\\n})()';
    }
    var value;
    try {
        value = vm.runInContext(wrapped, ctx, { filename: 'eval-cell.js' });
    } catch (err) {
        currentRunId = null;
        var message = err && err.message ? err.message : String(err);
        parentPort.postMessage({ type: 'result', runId: runId, ok: false, output: runBuffer, error: message });
        return;
    }
    function finish(formattedValue) {
        if (formattedValue !== undefined && formattedValue !== null) {
            var formatted = formatValue(formattedValue);
            if (formatted.length > 0) {
                appendToBuffer(formatted + '\\n');
            }
        }
        currentRunId = null;
        parentPort.postMessage({ type: 'result', runId: runId, ok: true, output: runBuffer });
    }
    if (isAsync) {
        Promise.resolve(value).then(function (v) {
            // Async cells are statement-oriented; the wrapped IIFE has no return value,
            // so do not echo a completion value for the await path.
            finish(undefined);
        }).catch(function (err) {
            currentRunId = null;
            var message = err && err.message ? err.message : String(err);
            parentPort.postMessage({ type: 'result', runId: runId, ok: false, output: runBuffer, error: message });
        });
    } else {
        finish(value);
    }
}

parentPort.on('message', function (message) {
    if (!message || typeof message !== 'object') {
        return;
    }
    var type = message.type;
    if (type === 'init') {
        ensureContext();
        parentPort.postMessage({ type: 'ready' });
        return;
    }
    if (type === 'run') {
        runCode(message.runId, message.code);
        return;
    }
    if (type === 'tool-reply') {
        settleBridge(message.id, message.reply);
        return;
    }
    if (type === 'close') {
        context = null;
        pendingBridge.clear();
        parentPort.removeAllListeners('message');
        process.exit(0);
    }
});
`;
