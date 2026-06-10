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
        expect(help).toContain('--jsonl');
        expect(help).toContain('--native');
        expect(help).toContain('--no-native');
        expect(help).toContain('--provider <id>');
        expect(help).toContain('--model <id>');
        expect(help).toContain('--graph <path>');
        expect(help).toContain('--session <id>');
        expect(help).toContain('--method <id>');
        expect(help).toContain('mctrl auth login --provider local --api-key <key>');
        expect(help).toContain('mctrl auth login --provider anthropic --api-key <key>');
        expect(help).toContain('mctrl auth login --provider openai --method oauth-headless');
        expect(help).toContain('mctrl auth login --provider github-copilot --method oauth');
        expect(help).toContain(
            'mctrl auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>',
        );
        expect(help).toContain('--credential FIELD=VALUE');
        expect(help).not.toContain('sk-test');
        expect(help).toContain('mctrl auth list');
        expect(help).toContain('mctrl models local');
        expect(help).toContain('mctrl run "summarize this repository" --session session_demo --jsonl');
        expect(help).toContain(
            'mctrl graph run examples/abg/research-answer.graph.json --session session_graph --jsonl',
        );
        expect(help).toContain('mctrl session list');
        expect(help).toContain('mctrl session replay session_demo --jsonl');
        expect(help).toContain('--version');
        expect(help).toContain('--help');
        expect(help).toContain('mctrl --no-tui --provider local --model local-echo');
        expect(help).toContain('mctrl --json --graph examples/abg/research-answer.graph.json');
        expect(help).toContain('/model <provider>/<model>');
        expect(help).toContain('$<skill> [args]');
        expect(help).toContain('$ skill invocations are scaffolded inside Mission Control');
    });
});
