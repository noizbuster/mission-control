import { describe, expect, it } from 'vitest';
import { parseAuthCommand, parseAuthSlashLine } from './auth-command';

describe('parseAuthCommand', () => {
    it('rejects bare /auth with a usage message', () => {
        expect(parseAuthCommand('')).toEqual({
            kind: 'invalid',
            message: '/auth requires a subcommand: login, list, logout',
        });
        expect(parseAuthCommand('   ')).toEqual({
            kind: 'invalid',
            message: '/auth requires a subcommand: login, list, logout',
        });
    });

    it('parses login with provider and api-key flags', () => {
        const command = parseAuthCommand('login --provider local --api-key local_key');
        expect(command).toMatchObject({
            kind: 'login',
            args: {
                command: 'auth-login',
                authProviderID: 'local',
                authApiKey: 'local_key',
            },
        });
    });

    it('parses login short flags plus model, method, and credential', () => {
        const command = parseAuthCommand(
            'login -p openai --model gpt-4o -m api-key --credential org=acme --credential project=demo',
        );
        expect(command).toMatchObject({
            kind: 'login',
            args: {
                command: 'auth-login',
                authProviderID: 'openai',
                authModelID: 'gpt-4o',
                authMethodID: 'api-key',
                authCredentials: [
                    { fieldID: 'org', value: 'acme' },
                    { fieldID: 'project', value: 'demo' },
                ],
            },
        });
    });

    it('parses logout -p shorthand', () => {
        expect(parseAuthCommand('logout -p anthropic')).toMatchObject({
            kind: 'logout',
            args: {
                command: 'auth-logout',
                authProviderID: 'anthropic',
            },
        });
    });

    it('parses bare login without flags', () => {
        const command = parseAuthCommand('login');
        expect(command).toMatchObject({
            kind: 'login',
            args: {
                command: 'auth-login',
            },
        });
        if (command.kind !== 'login') {
            throw new Error('expected login command');
        }
        expect(command.args.authProviderID).toBeUndefined();
    });

    it('parses list and ls aliases', () => {
        expect(parseAuthCommand('list')).toMatchObject({
            kind: 'list',
            args: { command: 'auth-list' },
        });
        expect(parseAuthCommand('ls')).toMatchObject({
            kind: 'list',
            args: { command: 'auth-list' },
        });
    });

    it('rejects list with trailing arguments', () => {
        expect(parseAuthCommand('list extra')).toEqual({
            kind: 'invalid',
            message: '/auth list does not accept arguments',
        });
        expect(parseAuthCommand('ls extra')).toEqual({
            kind: 'invalid',
            message: '/auth list does not accept arguments',
        });
    });

    it('parses logout with optional provider flag', () => {
        expect(parseAuthCommand('logout')).toMatchObject({
            kind: 'logout',
            args: { command: 'auth-logout' },
        });
        expect(parseAuthCommand('logout --provider local')).toMatchObject({
            kind: 'logout',
            args: {
                command: 'auth-logout',
                authProviderID: 'local',
            },
        });
    });

    it('rejects unknown subcommands with usage', () => {
        expect(parseAuthCommand('whoami')).toEqual({
            kind: 'invalid',
            message: '/auth requires a subcommand: login, list, logout',
        });
    });

    it('surfaces flag parse errors from auth-args', () => {
        expect(parseAuthCommand('login --provider')).toEqual({
            kind: 'invalid',
            message: '--provider requires a value',
        });
        expect(parseAuthCommand('login sk_positional_secret')).toEqual({
            kind: 'invalid',
            message: 'Unsupported auth login argument',
        });
        expect(parseAuthCommand('logout --model x')).toEqual({
            kind: 'invalid',
            message: 'Unsupported auth logout argument',
        });
    });
});

describe('parseAuthSlashLine', () => {
    it('parses /auth as invalid usage', () => {
        expect(parseAuthSlashLine('/auth')).toEqual({
            kind: 'invalid',
            message: '/auth requires a subcommand: login, list, logout',
        });
    });

    it('parses /auth login list logout lines', () => {
        expect(parseAuthSlashLine('/auth login --provider local')).toMatchObject({
            kind: 'login',
            args: { command: 'auth-login', authProviderID: 'local' },
        });
        expect(parseAuthSlashLine('/auth list')).toMatchObject({
            kind: 'list',
            args: { command: 'auth-list' },
        });
        expect(parseAuthSlashLine('/auth logout --provider openai')).toMatchObject({
            kind: 'logout',
            args: { command: 'auth-logout', authProviderID: 'openai' },
        });
    });

    it('returns undefined for non-auth slash commands', () => {
        expect(parseAuthSlashLine('/model')).toBeUndefined();
        expect(parseAuthSlashLine('/agents list')).toBeUndefined();
        expect(parseAuthSlashLine('hello')).toBeUndefined();
        expect(parseAuthSlashLine('')).toBeUndefined();
    });

    it('does not match /authlist or similar prefixed lines', () => {
        expect(parseAuthSlashLine('/authlist')).toBeUndefined();
        expect(parseAuthSlashLine('/authx login')).toBeUndefined();
    });

    it('trims surrounding whitespace from the slash line', () => {
        expect(parseAuthSlashLine('  /auth list  ')).toMatchObject({ kind: 'list' });
    });
});
