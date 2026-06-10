import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readme(): string {
    return readFileSync(join(root, 'README.md'), 'utf8');
}

describe('README stage-01 contract', () => {
    it('documents required run and build commands', () => {
        const content = readme();
        const commands = [
            'pnpm install',
            'pnpm dev:cli',
            'pnpm dev:cli -- --no-tui',
            'pnpm dev:cli -- --json',
            'pnpm dev:sidecar',
            'pnpm dev:desktop',
            'pnpm typecheck',
            'pnpm --filter @mission-control/cli build',
            'node apps/cli/dist/index.js --no-tui',
        ] as const;

        for (const command of commands) {
            expect(content, `README missing ${command}`).toContain(command);
        }
    });

    it('documents package responsibilities and product/bin names', () => {
        const content = readme();
        const requiredTerms = [
            '@mission-control/protocol',
            '@mission-control/core',
            '@mission-control/config',
            '@mission-control/cli',
            '@mission-control/desktop',
            'native/sidecar',
            'mctrl',
            'mission-control-sidecar',
            'desktop product name is `mission-control`',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents native fallback, ABG reflection, and next-stage TODOs', () => {
        const content = readme();
        const requiredTerms = [
            'native.warning',
            'mock sidecar',
            'ABG full engine is not implemented',
            'behavior/action graph execution',
            'Next Stage TODO',
            'cancellation propagation',
            'distribution packaging',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents scaffold-safe model provider selection', () => {
        const content = readme();
        const requiredTerms = [
            'pnpm dev:cli -- --no-tui --provider local --model local-echo',
            'pnpm dev:cli -- --json --model local/local-echo',
            'provider/model controls',
            'provider/model selection is scaffold metadata',
            'does not call real LLM providers yet',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents interactive chat commands', () => {
        const content = readme();
        const requiredTerms = [
            'Interactive chat commands',
            '/model opens a searchable model picker',
            '/model provider/model selects the model for the current chat only',
            '$skill args records a scaffold agent skill invocation',
            'Normal prompt text still sends a prompt',
            'Ctrl+C twice exits',
            'does not run actual Codex host skills',
            'real LLM calls are not implemented',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents auth commands and credential storage', () => {
        const content = readme();
        const requiredTerms = [
            'mctrl auth login --provider local --api-key <key>',
            'mctrl auth login --provider anthropic --api-key <key>',
            'mctrl auth login --provider openai --method oauth-headless',
            'mctrl auth login --provider github-copilot --method oauth',
            'mctrl auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>',
            'mctrl auth login --provider amazon-bedrock --credential region=<region> --credential accessKeyId=<key-id> --credential secretAccessKey=<secret>',
            '--credential FIELD=VALUE',
            'OAuth-capable providers expose OpenCode-style `--method` choices',
            'OpenAI supports browser and headless ChatGPT OAuth plus API key login',
            'GitHub Copilot supports OAuth device login plus API key login',
            'OpenCode/Models.dev provider credential catalog',
            'vendored Models.dev snapshot',
            'supports credential setup for every vendored OpenCode provider',
            'does not implement real LLM provider execution',
            'no runtime fetch to Models.dev',
            'explicit CLI values, matching environment variables, existing stored values, and interactive prompts',
            'mctrl auth login',
            'mctrl auth list',
            'mctrl auth logout --provider local',
            'mctrl models local',
            'MISSION_CONTROL_AUTH_FILE',
            '$XDG_DATA_HOME/mission-control/auth.json',
            '~/.local/share/mission-control/auth.json',
            'Stored credentials configure the default provider/model for later demo runs',
            'Interactive `/model` choices are narrower than `mctrl models`',
            "call the provider's model-list API at chat startup",
            'OAuth credentials, unsupported providers, failed requests, and malformed responses fall back to the vendored models',
            'credentials are used for scaffold configuration only',
            'API keys, OAuth tokens, and multi-field provider credentials are stored as plaintext JSON',
            'not encrypted keychain storage',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents the implemented coding-agent runtime scope and safety boundaries', () => {
        const content = readme();
        const requiredTerms = [
            'Coding Agent Runtime',
            'OpenAI Responses adapter is implemented behind stored provider credentials',
            'MCTRL_DATA_DIR',
            'sessions/<session-id>.jsonl',
            'approval.requested',
            'approval.updated',
            'approval.resumed',
            'approval.blocked',
            'repo.read',
            'repo.list',
            'repo.search',
            'file.patch',
            'command.run',
            'graph node concurrency defaults to 2',
            'provider parallel tool calls default to 4',
            'shell/process concurrency defaults to 1',
            'desktop Tauri write commands are placeholder receipt bridges until the Rust shell is wired to the core command service',
            'The desktop shell never mutates files directly',
            'Sidecar protocol v1 negotiates task.run only',
            'file.patch and command.run stay on the TypeScript core path by default',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
        expect(content).not.toContain(
            'real providers, real tools, durable persistence, and visual graph editor remain out of scope',
        );
        expect(content).not.toContain(
            'Mission Control does not implement real LLM provider execution in this scaffold',
        );
    });
});
