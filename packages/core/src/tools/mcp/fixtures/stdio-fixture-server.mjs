// Minimal MCP stdio fixture server for StdioMcpClient tests. Hand-rolled JSON-RPC 2.0 over
// stdin/stdout (no SDK dependency) so the fixture is stable across SDK versions. Modes via argv[2]:
//   normal — exposes echo/greet/fail, responds to initialize + tools/list + tools/call
//   cwd    — exposes report_cwd, which returns the server process working directory
//   hung   — completes the initialize handshake, then never replies to tools/list (stuck server)
//   crash  — exits non-zero immediately (server failure)
//   metadata-secret — exposes metadata containing MCP_TEST_SECRET for redaction tests

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const exitMarker = process.env.MCP_TEST_EXIT_MARKER;
let exitMarked = false;

function markExit() {
    if (exitMarked || typeof exitMarker !== 'string') return;
    exitMarked = true;
    writeFileSync(exitMarker, 'closed\n', 'utf8');
}

process.once('exit', markExit);
process.once('SIGTERM', () => process.exit(0));

if (mode === 'crash') {
    process.stderr.write('fixture: crashing on startup\n');
    process.exit(17);
}

const rl = createInterface({ input: process.stdin });

function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const ordinaryTools = [
    {
        name: 'echo',
        description: 'echo the text argument back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
        name: 'greet',
        description: 'return a greeting',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
    {
        name: 'fail',
        description: 'respond with a JSON-RPC error echoing the reason argument',
        inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
];
const cwdTools = [
    {
        name: 'report_cwd',
        description: 'return the server process working directory',
        inputSchema: { type: 'object', properties: {} },
    },
];
const metadataSecret = process.env.MCP_TEST_SECRET;
const tools =
    mode === 'metadata-secret' && typeof metadataSecret === 'string'
        ? [
              {
                  name: 'metadata',
                  description: `metadata contains ${metadataSecret}`,
                  inputSchema: {
                      type: 'object',
                      properties: { [metadataSecret]: { type: 'string', description: metadataSecret } },
                  },
              },
          ]
        : mode === 'cwd'
          ? cwdTools
          : ordinaryTools;

rl.on('line', (line) => {
    if (!line || line.trim() === '') {
        return;
    }
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (msg === null || typeof msg !== 'object') {
        return;
    }
    const id = msg.id;
    const method = msg.method;
    const params = msg.params ?? {};

    if (method === 'initialize' && id !== undefined) {
        const clientVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
        send({
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: clientVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'stdio-fixture', version: '0.0.1' },
            },
        });
        return;
    }
    if (method === 'notifications/initialized') {
        return;
    }
    if (method === 'ping' && id !== undefined) {
        send({ jsonrpc: '2.0', id, result: {} });
        return;
    }
    if (mode === 'hung') {
        // Complete the handshake (above) but never answer requests after it. This simulates a
        // server that accepts the connection then stalls.
        return;
    }
    if (method === 'tools/list' && id !== undefined) {
        send({ jsonrpc: '2.0', id, result: { tools } });
        return;
    }
    if (method === 'tools/call' && id !== undefined) {
        const toolName = params.name;
        if (mode === 'cwd' && toolName === 'report_cwd') {
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: process.cwd() }] } });
            return;
        }
        if (toolName === 'echo') {
            const text = params.arguments?.text ?? '';
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
            return;
        }
        if (toolName === 'greet') {
            const who = params.arguments?.name ?? 'world';
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `hello ${who}` }] } });
            return;
        }
        if (toolName === 'fail') {
            const reason = params.arguments?.reason ?? 'unspecified';
            send({ jsonrpc: '2.0', id, error: { code: -32603, message: `server error: ${reason}` } });
            return;
        }
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${toolName}` } });
        return;
    }
});
