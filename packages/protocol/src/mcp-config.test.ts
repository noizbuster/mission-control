import { describe, expect, it } from 'vitest';
import {
    LspConfigSchema,
    McpConfigEntrySchema,
    McpConfigSchema,
    McpProjectConfigSchema,
    MissionControlConfigSchema,
} from './mcp-config.js';

const ref = (name: string): string => `\${${name}}`;

describe('McpConfigEntrySchema', () => {
    it('parses a valid local entry with command and environment', () => {
        const parsed = McpConfigEntrySchema.parse({
            type: 'local',
            command: ['node', 'server.js'],
            environment: { API_KEY: ref('API_KEY') },
            enabled: true,
            timeoutMs: 8000,
        });
        expect(parsed.type).toBe('local');
        if (parsed.type === 'local') {
            expect(parsed.command).toEqual(['node', 'server.js']);
            expect(parsed.environment).toEqual({ API_KEY: ref('API_KEY') });
            expect(parsed.enabled).toBe(true);
            expect(parsed.timeoutMs).toBe(8000);
        }
    });

    it('parses a minimal local entry (only command required)', () => {
        const parsed = McpConfigEntrySchema.parse({ type: 'local', command: ['npx'] });
        expect(parsed.type).toBe('local');
        if (parsed.type === 'local') {
            expect(parsed.command).toEqual(['npx']);
            expect(parsed.environment).toBeUndefined();
            expect(parsed.enabled).toBeUndefined();
            expect(parsed.timeoutMs).toBeUndefined();
        }
    });

    it('parses a valid remote entry with url and headers', () => {
        const parsed = McpConfigEntrySchema.parse({
            type: 'remote',
            url: 'https://example.test/mcp',
            headers: { Authorization: `Bearer ${ref('TOKEN')}` },
        });
        expect(parsed.type).toBe('remote');
        if (parsed.type === 'remote') {
            expect(parsed.url).toBe('https://example.test/mcp');
            expect(parsed.headers).toEqual({ Authorization: `Bearer ${ref('TOKEN')}` });
        }
    });

    it('rejects a local entry with an empty command array', () => {
        const result = McpConfigEntrySchema.safeParse({ type: 'local', command: [] });
        expect(result.success).toBe(false);
    });

    it('rejects a remote entry with a malformed url', () => {
        const result = McpConfigEntrySchema.safeParse({ type: 'remote', url: 'not-a-url' });
        expect(result.success).toBe(false);
    });

    it('rejects an unknown discriminator type', () => {
        const result = McpConfigEntrySchema.safeParse({ type: 'websocket', url: 'https://x.test' });
        expect(result.success).toBe(false);
    });

    it('rejects a non-positive or non-integer timeoutMs', () => {
        const negative = McpConfigEntrySchema.safeParse({
            type: 'local',
            command: ['x'],
            timeoutMs: -1,
        });
        const fractional = McpConfigEntrySchema.safeParse({
            type: 'local',
            command: ['x'],
            timeoutMs: 1.5,
        });
        expect(negative.success).toBe(false);
        expect(fractional.success).toBe(false);
    });
});

describe('McpConfigSchema', () => {
    it('parses a map of named server entries', () => {
        const parsed = McpConfigSchema.parse({
            fs: { type: 'local', command: ['npx', 'fs-mcp'] },
            web: { type: 'remote', url: 'https://example.test/mcp' },
        });
        expect(Object.keys(parsed).sort()).toEqual(['fs', 'web']);
    });

    it('rejects a malformed entry value at parse (zod v4 record validates values)', () => {
        expect(() => McpConfigSchema.parse({ broken: { type: 'remote', url: 'nope' } })).toThrow();
        const entryResult = McpConfigEntrySchema.safeParse({ type: 'remote', url: 'nope' });
        expect(entryResult.success).toBe(false);
    });

    it('parses an empty map', () => {
        expect(McpConfigSchema.parse({})).toEqual({});
    });
});

describe('MissionControlConfigSchema', () => {
    it('parses a global config with mcp servers and an env allowlist', () => {
        const parsed = MissionControlConfigSchema.parse({
            mcp: { fs: { type: 'local', command: ['npx', 'fs-mcp'] } },
            mcp_env_allowlist: ['API_KEY'],
        });
        const serverName = 'fs';
        expect(parsed.mcp?.[serverName]?.type).toBe('local');
        expect(parsed.mcp_env_allowlist).toEqual(['API_KEY']);
    });

    it('parses an optional lsp placeholder section alongside mcp', () => {
        const parsed = MissionControlConfigSchema.parse({
            lsp: { enabled: true, command: ['typescript-language-server', '--stdio'] },
        });
        expect(parsed.lsp?.enabled).toBe(true);
        expect(parsed.lsp?.command).toEqual(['typescript-language-server', '--stdio']);
    });

    it('parses a global config with no lsp section (lsp stays optional)', () => {
        const parsed = MissionControlConfigSchema.parse({ mcp_env_allowlist: ['API_KEY'] });
        expect(parsed.lsp).toBeUndefined();
    });

    it('rejects unknown top-level keys (strict)', () => {
        const result = MissionControlConfigSchema.safeParse({ unexpected: 1 });
        expect(result.success).toBe(false);
    });
});

describe('McpProjectConfigSchema', () => {
    it('parses a Claude-Code-compatible .mcp.json with mcpServers', () => {
        const parsed = McpProjectConfigSchema.parse({
            mcpServers: { fs: { type: 'local', command: ['npx', 'fs-mcp'] } },
        });
        const serverName = 'fs';
        expect(parsed.mcpServers?.[serverName]?.type).toBe('local');
    });

    it('rejects unknown top-level keys (strict)', () => {
        const result = McpProjectConfigSchema.safeParse({ mcp_env_allowlist: ['X'] });
        expect(result.success).toBe(false);
    });
});

describe('LspConfigSchema', () => {
    it('parses a minimal enabled placeholder', () => {
        const parsed = LspConfigSchema.parse({ enabled: true });
        expect(parsed.enabled).toBe(true);
        expect(parsed.command).toBeUndefined();
    });

    it('rejects an empty command array', () => {
        const result = LspConfigSchema.safeParse({ command: [] });
        expect(result.success).toBe(false);
    });

    it('rejects unknown keys (strict placeholder)', () => {
        const result = LspConfigSchema.safeParse({ server: 'x' });
        expect(result.success).toBe(false);
    });
});
