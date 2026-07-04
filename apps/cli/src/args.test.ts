import { describe, expect, it } from 'vitest';
import { parseArgs, parseProfileName } from './args.js';

describe('parseArgs', () => {
    it('parses all supported mctrl flags', () => {
        expect(parseArgs([])).toEqual({
            mode: 'tui',
            useNative: undefined,
            command: 'run',
            showHelp: false,
            showVersion: false,
            thinking: false,
        });
        expect(parseArgs(['--no-tui']).mode).toBe('plain');
        expect(parseArgs(['--json']).mode).toBe('json');
        expect(parseArgs(['--jsonl']).mode).toBe('jsonl');
        expect(parseArgs(['--native']).useNative).toBe(true);
        expect(parseArgs(['--no-native']).useNative).toBe(false);
        expect(parseArgs(['--graph', 'examples/abg/research-answer.graph.json'])).toMatchObject({
            graphPath: 'examples/abg/research-answer.graph.json',
        });
        expect(parseArgs(['--session', 'session_cli'])).toMatchObject({
            sessionId: 'session_cli',
        });
        expect(parseArgs(['--workspace', '/tmp/some-project'])).toMatchObject({
            workspacePath: '/tmp/some-project',
        });
        expect(() => parseArgs(['--workspace'])).toThrow('--workspace requires a value');
        expect(() => parseArgs(['--workspace', '--json'])).toThrow('--workspace requires a value');
        expect(parseArgs(['--version']).showVersion).toBe(true);
        expect(parseArgs(['--help']).showHelp).toBe(true);
    });

    it('parses the --thinking flag as a boolean defaulting to false', () => {
        expect(parseArgs(['--thinking']).thinking).toBe(true);
        expect(parseArgs([]).thinking).toBe(false);
        expect(parseArgs(['--no-tui']).thinking).toBe(false);
        expect(parseArgs(['--thinking', '--json'])).toMatchObject({ thinking: true, mode: 'json' });
        expect(parseArgs(['--json', '--thinking'])).toMatchObject({ thinking: true, mode: 'json' });
        expect(parseArgs(['--thinking', 'do something'])).toMatchObject({ thinking: true, prompt: 'do something' });
        // --thinking is a bare boolean flag (mirrors --native); =value syntax is not supported.
        expect(() => parseArgs(['--thinking=true'])).toThrow('Unsupported argument: --thinking=true');
        expect(() => parseArgs(['--thinking=false'])).toThrow('Unsupported argument: --thinking=false');
    });

    it('rejects unsupported arguments', () => {
        expect(() => parseArgs(['--bad-flag'])).toThrow('Unsupported argument: --bad-flag');
    });

    it('parses explicit provider and model flags', () => {
        expect(parseArgs(['--provider', 'local', '--model', 'local-echo'])).toMatchObject({
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
    });

    it('parses the --engine flag (graph engine cutover seam) and rejects invalid values', () => {
        expect(parseArgs(['--engine', 'graph', 'do something'])).toMatchObject({
            engine: 'graph',
            prompt: 'do something',
        });
        expect(parseArgs([]).engine).toBeUndefined();
        expect(() => parseArgs(['--engine', 'turbo'])).toThrow('--engine only supports graph');
        expect(() => parseArgs(['--engine', 'flat'])).toThrow('--engine only supports graph');
        expect(() => parseArgs(['--engine'])).toThrow('--engine requires a value');
        // --engine graph without --prompt is valid in interactive (tui) mode — the prompt arrives via
        // the chat loop — but requires a prompt in the non-interactive modes (plain/json/jsonl).
        expect(parseArgs(['--engine', 'graph']).engine).toBe('graph');
        expect(() => parseArgs(['--no-tui', '--engine', 'graph'])).toThrow('--engine graph requires a prompt');
    });

    it('parses opencode-style provider model shorthand', () => {
        expect(parseArgs(['--model', 'local/local-echo'])).toMatchObject({
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        expect(parseArgs(['--model', 'local/local-echo#fast'])).toMatchObject({
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
                variantID: 'fast',
            },
        });
        expect(parseArgs(['--provider', 'local', '--model', 'local-echo#thinking'])).toMatchObject({
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
                variantID: 'thinking',
            },
        });
    });

    it('rejects incomplete or conflicting provider model flags', () => {
        expect(() => parseArgs(['--provider', 'local'])).toThrow('--provider requires --model');
        expect(() => parseArgs(['--provider'])).toThrow('--provider requires a value');
        expect(() => parseArgs(['--graph'])).toThrow('--graph requires a value');
        expect(() => parseArgs(['--model'])).toThrow('--model requires a value');
        expect(() => parseArgs(['--model', 'local-echo'])).toThrow(
            '--model without --provider must use provider/model',
        );
        expect(() => parseArgs(['--provider', 'local', '--model', 'anthropic/claude-3-5-haiku-20241022'])).toThrow(
            '--model provider/model cannot be combined with --provider',
        );
    });

    it('parses auth login list logout and models commands', () => {
        expect(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_key'])).toMatchObject({
            command: 'auth-login',
            authProviderID: 'local',
            authApiKey: 'local_key',
        });
        expect(
            parseArgs(['auth', 'login', '-p', 'local', '--model', 'local-echo', '--api-key', 'local_key']),
        ).toMatchObject({
            command: 'auth-login',
            authProviderID: 'local',
            authModelID: 'local-echo',
            authApiKey: 'local_key',
        });
        expect(parseArgs(['auth', 'login', '--provider', 'openai', '--method', 'oauth'])).toMatchObject({
            command: 'auth-login',
            authProviderID: 'openai',
            authMethodID: 'oauth',
        });
        expect(
            parseArgs([
                'auth',
                'login',
                '--provider',
                'cloudflare-ai-gateway',
                '--credential',
                'accountId=acct_test',
                '--credential',
                'gatewayId=gw_test',
            ]),
        ).toMatchObject({
            command: 'auth-login',
            authProviderID: 'cloudflare-ai-gateway',
            authCredentials: [
                { fieldID: 'accountId', value: 'acct_test' },
                { fieldID: 'gatewayId', value: 'gw_test' },
            ],
        });
        expect(parseArgs(['auth', 'list']).command).toBe('auth-list');
        expect(parseArgs(['auth', 'ls']).command).toBe('auth-list');
        expect(parseArgs(['auth', 'logout', '--provider', 'local'])).toMatchObject({
            command: 'auth-logout',
            authProviderID: 'local',
        });
        expect(parseArgs(['auth', 'logout'])).toMatchObject({
            command: 'auth-logout',
        });
        expect(parseArgs(['models']).command).toBe('models');
        expect(parseArgs(['models', 'local'])).toMatchObject({
            command: 'models',
            modelsProviderID: 'local',
        });
        expect(parseArgs(['session', 'list']).command).toBe('session-list');
        expect(parseArgs(['session', 'show', 'session_cli'])).toMatchObject({
            command: 'session-show',
            sessionId: 'session_cli',
        });
        expect(parseArgs(['session', 'replay', 'session_cli', '--jsonl'])).toMatchObject({
            command: 'session-replay',
            mode: 'jsonl',
            sessionId: 'session_cli',
        });
        expect(parseArgs(['run', 'summarize this repository', '--session', 'session_cli', '--jsonl'])).toMatchObject({
            command: 'run',
            mode: 'jsonl',
            prompt: 'summarize this repository',
            sessionId: 'session_cli',
        });
        expect(
            parseArgs([
                'graph',
                'run',
                'examples/abg/research-answer.graph.json',
                '--session',
                'session_graph',
                '--jsonl',
            ]),
        ).toMatchObject({
            command: 'run',
            mode: 'jsonl',
            graphPath: 'examples/abg/research-answer.graph.json',
            sessionId: 'session_graph',
        });
        expect(() => parseArgs(['auth', 'login', '--api-key'])).toThrow('--api-key requires a value');
        expect(() => parseArgs(['auth', 'login', '--credential', 'missing-equals'])).toThrow(
            '--credential requires FIELD=VALUE',
        );
        expect(() => parseArgs(['auth', 'login', '--method'])).toThrow('--method requires a value');
        expect(() => parseArgs(['auth', 'login', 'sk_positional_secret'])).toThrow(/^Unsupported auth login argument$/);
        expect(() => parseArgs(['auth', 'sk_command_secret'])).toThrow(/^Unsupported auth command$/);
        expect(() => parseArgs(['session', 'replay', 'session_cli'])).toThrow(
            'session replay requires --jsonl for event output',
        );
        expect(parseArgs(['session', 'export', 'session_cli', '/tmp/session_cli.mctrl-session.json'])).toMatchObject({
            command: 'session-export',
            sessionId: 'session_cli',
            filePath: '/tmp/session_cli.mctrl-session.json',
        });
        expect(parseArgs(['session', 'import', '/tmp/session_cli.mctrl-session.json'])).toMatchObject({
            command: 'session-import',
            filePath: '/tmp/session_cli.mctrl-session.json',
        });
        expect(() => parseArgs(['graph', 'run'])).toThrow('graph run requires a graph file');
        expect(() => parseArgs(['--json', '--jsonl'])).toThrow('--json and --jsonl cannot be combined');
    });

    it('parses the agents subcommand dispatcher and carries the argv tail', () => {
        expect(parseArgs(['agents']).command).toBe('agents');
        expect(parseArgs(['agents']).agentsArgv).toEqual([]);
        expect(parseArgs(['agents', 'list']).command).toBe('agents');
        expect(parseArgs(['agents', 'list']).agentsArgv).toEqual(['list']);
        expect(parseArgs(['agents', 'show', 'oracle']).command).toBe('agents');
        expect(parseArgs(['agents', 'show', 'oracle']).agentsArgv).toEqual(['show', 'oracle']);
    });

    it('parses the long-only --profile flag in every command position', () => {
        expect(parseArgs(['--profile', 'dev'])).toMatchObject({
            command: 'run',
            profileName: 'dev',
        });
        expect(parseArgs(['run', '--profile', 'dev', 'prompt'])).toMatchObject({
            command: 'run',
            profileName: 'dev',
            prompt: 'prompt',
        });
        expect(parseArgs(['mcp', 'list', '--profile', 'dev'])).toMatchObject({
            command: 'mcp-list',
            profileName: 'dev',
        });
        expect(parseArgs(['mcp', 'ls', '--profile', 'dev'])).toMatchObject({
            command: 'mcp-list',
            profileName: 'dev',
        });
        expect(parseArgs(['mcp', 'add', 'myserver', '--scope', 'user', '--profile', 'dev'])).toMatchObject({
            command: 'mcp-add',
            mcpName: 'myserver',
            mcpScope: 'user',
            profileName: 'dev',
        });
        expect(parseArgs(['mcp', 'remove', 'myserver', '--profile', 'dev'])).toMatchObject({
            command: 'mcp-remove',
            mcpName: 'myserver',
            profileName: 'dev',
        });
        expect(parseArgs(['mcp', 'rm', 'myserver', '--profile', 'dev'])).toMatchObject({
            command: 'mcp-remove',
            profileName: 'dev',
        });
        expect(parseArgs(['mcp', 'test', 'myserver', '--profile', 'dev'])).toMatchObject({
            command: 'mcp-test',
            mcpName: 'myserver',
            profileName: 'dev',
        });
        expect(parseArgs(['run', '--profile', 'dev'])).toMatchObject({
            profileName: 'dev',
        });
        expect(parseArgs(['run', '--profile', 'dev']).prompt).toBeUndefined();
    });

    it('preserves the auth -p provider shorthand and rejects -p as a profile flag', () => {
        expect(parseArgs(['auth', 'login', '-p', 'local', '--api-key', 'k'])).toMatchObject({
            command: 'auth-login',
            authProviderID: 'local',
            authApiKey: 'k',
        });
        expect(parseArgs(['auth', 'logout', '-p', 'local'])).toMatchObject({
            command: 'auth-logout',
            authProviderID: 'local',
        });
        expect(() => parseArgs(['-p', 'dev'])).toThrow('Unsupported argument: -p');
        expect(() => parseArgs(['run', '-p', 'dev'])).toThrow('Unsupported argument: -p');
    });

    it('rejects missing or invalid --profile values with the offending value named', () => {
        expect(() => parseArgs(['--profile'])).toThrow('--profile requires a value');
        expect(() => parseArgs(['run', '--profile'])).toThrow('--profile requires a value');
        expect(() => parseArgs(['mcp', 'list', '--profile'])).toThrow('--profile requires a value');
        // Mirror the implementation's JSON.stringify formatting so backslash/space escaping stays correct.
        for (const bad of ['../bad', '.', '..', '.hidden', 'a/b', 'a\\b', 'UPPER', 'has space']) {
            expect(() => parseArgs(['--profile', bad])).toThrow(
                `Invalid --profile value: ${JSON.stringify(bad)}`,
            );
        }
    });
});

describe('parseProfileName', () => {
    it('returns undefined for undefined input', () => {
        expect(parseProfileName(undefined)).toBeUndefined();
    });

    it('accepts lowercase letters, digits, underscores, and hyphens', () => {
        expect(parseProfileName('dev')).toBe('dev');
        expect(parseProfileName('prod-1')).toBe('prod-1');
        expect(parseProfileName('a')).toBe('a');
        expect(parseProfileName('0start')).toBe('0start');
        expect(parseProfileName('with_underscore')).toBe('with_underscore');
        expect(parseProfileName('a1-b2_c3')).toBe('a1-b2_c3');
    });

    it('accepts the maximum 64-character length', () => {
        const max = 'a'.repeat(64);
        expect(parseProfileName(max)).toBe(max);
    });

    it('rejects names longer than 64 characters', () => {
        const tooLong = 'a'.repeat(65);
        expect(() => parseProfileName(tooLong)).toThrow('Invalid --profile value');
    });

    it('rejects empty, path-like, and uppercase values naming the offender', () => {
        for (const bad of ['', '.', '..', '.dev', 'dev/x', 'dev\\x', 'Dev', 'UPPER', 'has space', '-lead', '_lead']) {
            expect(() => parseProfileName(bad)).toThrow('Invalid --profile value');
        }
    });
});
