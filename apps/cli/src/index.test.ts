import { describe, expect, it } from 'vitest';
import { createHelpText, getVersion } from './index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('CLI entrypoint', () => {
    it('entrypoint exposes shebang and version/help output', () => {
        const source = readFileSync(join(process.cwd(), 'apps/cli/src/index.tsx'), 'utf8');
        const help = createHelpText();

        expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
        expect(getVersion()).toBe('0.1.0');
        expect(help).toContain('mctrl');
        expect(help).toContain('--no-tui');
        expect(help).toContain('--json');
        expect(help).toContain('--native');
        expect(help).toContain('--no-native');
        expect(help).toContain('--provider <id>');
        expect(help).toContain('--model <id>');
        expect(help).toContain('mctrl auth login --provider mock --api-key <key>');
        expect(help).toContain('mctrl auth list');
        expect(help).toContain('mctrl models local');
        expect(help).toContain('--version');
        expect(help).toContain('--help');
        expect(help).toContain('mctrl --no-tui --provider mock --model mission-control-fast');
    });
});
