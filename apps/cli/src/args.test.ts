import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
    it('parses all supported mctrl flags', () => {
        expect(parseArgs([])).toEqual({
            mode: 'ink',
            useNative: undefined,
            command: 'run',
            showHelp: false,
            showVersion: false,
        });
        expect(parseArgs(['--ui', 'ink']).mode).toBe('ink');
        expect(parseArgs(['--no-tui']).mode).toBe('plain');
        expect(parseArgs(['--json']).mode).toBe('json');
        expect(parseArgs(['--native']).useNative).toBe(true);
        expect(parseArgs(['--no-native']).useNative).toBe(false);
        expect(parseArgs(['--graph', 'examples/abg/research-answer.graph.json'])).toMatchObject({
            graphPath: 'examples/abg/research-answer.graph.json',
        });
        expect(parseArgs(['--version']).showVersion).toBe(true);
        expect(parseArgs(['--help']).showHelp).toBe(true);
    });

    it('rejects unsupported arguments', () => {
        expect(() => parseArgs(['--bad-flag'])).toThrow('Unsupported argument: --bad-flag');
    });

    it('parses explicit provider and model flags', () => {
        expect(parseArgs(['--provider', 'mock', '--model', 'mission-control-fast'])).toMatchObject({
            modelProviderSelection: {
                providerID: 'mock',
                modelID: 'mission-control-fast',
            },
        });
    });

    it('parses opencode-style provider model shorthand', () => {
        expect(parseArgs(['--model', 'local/local-echo'])).toMatchObject({
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
    });

    it('rejects incomplete or conflicting provider model flags', () => {
        expect(() => parseArgs(['--provider', 'mock'])).toThrow('--provider requires --model');
        expect(() => parseArgs(['--provider'])).toThrow('--provider requires a value');
        expect(() => parseArgs(['--graph'])).toThrow('--graph requires a value');
        expect(() => parseArgs(['--model'])).toThrow('--model requires a value');
        expect(() => parseArgs(['--model', 'mission-control-demo'])).toThrow(
            '--model without --provider must use provider/model',
        );
        expect(() => parseArgs(['--provider', 'mock', '--model', 'local/local-echo'])).toThrow(
            '--model provider/model cannot be combined with --provider',
        );
    });

    it('parses auth login list logout and models commands', () => {
        expect(parseArgs(['auth', 'login', '--provider', 'mock', '--api-key', 'mc_test_key'])).toMatchObject({
            command: 'auth-login',
            authProviderID: 'mock',
            authApiKey: 'mc_test_key',
        });
        expect(
            parseArgs(['auth', 'login', '-p', 'local', '--model', 'local-echo', '--api-key', 'local_key']),
        ).toMatchObject({
            command: 'auth-login',
            authProviderID: 'local',
            authModelID: 'local-echo',
            authApiKey: 'local_key',
        });
        expect(parseArgs(['auth', 'list']).command).toBe('auth-list');
        expect(parseArgs(['auth', 'ls']).command).toBe('auth-list');
        expect(parseArgs(['auth', 'logout', '--provider', 'mock'])).toMatchObject({
            command: 'auth-logout',
            authProviderID: 'mock',
        });
        expect(parseArgs(['models']).command).toBe('models');
        expect(parseArgs(['models', 'local'])).toMatchObject({
            command: 'models',
            modelsProviderID: 'local',
        });
        expect(() => parseArgs(['auth', 'login', '--api-key'])).toThrow('--api-key requires a value');
        expect(() => parseArgs(['auth', 'logout'])).toThrow('auth logout requires --provider');
    });
});
