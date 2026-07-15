import { describe, expect, it } from 'vitest';
import { mcpToolName, sanitizeMcpName } from './surfacing';

describe('sanitizeMcpName', () => {
    it('keeps alphanumeric and underscores unchanged', () => {
        expect(sanitizeMcpName('my_server_01')).toBe('my_server_01');
    });

    it('collapses non-alphanumeric runs into a single underscore', () => {
        expect(sanitizeMcpName('my-server.name')).toBe('my_server_name');
    });

    it('strips leading and trailing separators', () => {
        expect(sanitizeMcpName('---hello---')).toBe('hello');
    });

    it('strips leading separators (e.g. @ in package scopes)', () => {
        expect(sanitizeMcpName('@scope/server')).toBe('scope_server');
    });

    it('returns empty string for fully non-alphanumeric input', () => {
        expect(sanitizeMcpName('---')).toBe('');
    });
});

describe('mcpToolName', () => {
    it('produces mcp__ prefix with sanitized server and tool names', () => {
        expect(mcpToolName('my-server', 'read_file')).toBe('mcp__my_server__read_file');
    });

    it('handles dot-scoped server names', () => {
        expect(mcpToolName('@acme/mcp', 'search')).toBe('mcp__acme_mcp__search');
    });
});
