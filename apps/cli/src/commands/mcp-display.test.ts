import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { runMcpCommand } from './mcp.js';
import { envRef, makeTempDirs, type TempDirs, writeRaw } from './mcp-command-test-support.js';
import { formatRemoteUrlForDisplay } from './mcp-display.js';
import { readFile, rm } from 'node:fs/promises';

describe('mcp remote URL display', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('masks credentials, every query value, and fragments without mutating stored URLs', async () => {
        const rawUrl =
            'https://user:pass@example.test:8443/mcp?token=plain-value&encoded=%70%61%73%73&token=duplicate#fragment-secret';
        await writeRaw(dirs.userConfigPath, JSON.stringify({ mcp: { remote: { type: 'remote', url: rawUrl } } }));

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });

        expect(listOutput).toContain('url: https://example.test:8443/mcp?token=***&encoded=***&token=***');
        expect(listOutput).not.toContain('url: https://user:');
        expect(listOutput).not.toContain(':pass@');
        expect(listOutput).not.toContain('plain-value');
        expect(listOutput).not.toContain('%70%61%73%73');
        expect(listOutput).not.toContain('duplicate');
        expect(listOutput).not.toContain('fragment-secret');
        const storedConfig = JSON.parse(await readFile(dirs.userConfigPath, 'utf8'));
        expect(storedConfig.mcp.remote.url).toBe(rawUrl);
    });

    it('masks expanded env secrets embedded in remote URL query values', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp_env_allowlist: ['REMOTE_TOKEN'],
                mcp: { remote: { type: 'remote', url: `https://example.test/mcp?token=${envRef('REMOTE_TOKEN')}` } },
            }),
        );

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: { REMOTE_TOKEN: 'expanded-remote-secret' },
        });

        expect(listOutput).toContain('url: https://example.test/mcp?token=***');
        expect(listOutput).not.toContain('expanded-remote-secret');
    });

    it('masks malformed query values without echoing their raw contents', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: { remote: { type: 'remote', url: 'https://example.test/mcp?token=%E0%A4%A&other=still-secret' } },
            }),
        );

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });

        expect(listOutput).toContain('url: https://example.test/mcp?token=***&other=***');
        expect(listOutput).not.toContain('%E0%A4%A');
        expect(listOutput).not.toContain('still-secret');
    });

    it('returns a fixed mask for a malformed credential-bearing URL', () => {
        expect(formatRemoteUrlForDisplay('https://user:password@[malformed')).toBe('[REDACTED URL]');
    });
});
