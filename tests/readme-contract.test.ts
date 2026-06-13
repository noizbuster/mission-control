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
            'release provenance',
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
            'Provider capability statuses',
            'model-discovery-only',
            'Provider-backed coding commands require an executable adapter proof before a provider can run',
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
            '`/new [session-id]` starts a new durable session',
            '`/session <session-id>` switches to an existing durable session',
            '`/sessions` lists durable sessions',
            '`/tree` shows the durable session tree and active leaf',
            '`/branch <entry-id>` selects an existing branch leaf',
            '`/branch <message-id> <prompt>` continues from a parent message in a new branch',
            '`/fork <entry-id> [session-id]` forks from a tree entry into a new durable session',
            '`/clone [session-id]` clones the current durable session into a fresh one',
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
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mctrl auth login --provider local --api-key local_test_key',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mctrl run "summarize this repository" --session session_demo --jsonl --provider local --model local-echo',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mctrl session replay session_demo --jsonl',
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
            'Use --json for transient JSON Lines rendering and --jsonl for JSON Lines rendering plus replayable session persistence',
            'approval.requested',
            'approval.updated',
            'approval.resumed',
            'approval.blocked',
            'repo.read',
            'repo.list',
            'repo.search',
            'file.patch',
            'command.run',
            'Reference repositories under `temp/ref-repos` are planning evidence only',
            '`repo.read`, `repo.list`, and `repo.search` deny `temp/ref-repos` by default',
            'Runtime prompts and tool instructions must not load AGENTS.md or other instructions from reference repos',
            'Providers without execution adapters remain catalog/auth entries and must not be documented as executable',
            'graph node concurrency defaults to 2',
            'provider parallel tool calls default to 4',
            'shell/process concurrency defaults to 1',
            'desktop Tauri write commands call the core desktop session command service through the Rust shell bridge and return real `eventsWritten` counts',
            'The desktop shell never mutates files directly',
            'Sidecar protocol v1 negotiates `task.run` by default',
            'Feature-flagged sidecar protocol v2 negotiates `task.cancel`',
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
        const forbiddenExecutionClaims = [
            'all catalog providers execute',
            'all catalog providers can execute',
            'every catalog provider executes',
            'every catalog provider can execute',
            'every vendored provider can run coding prompts',
            'all vendored providers can run coding prompts',
        ] as const;

        for (const forbiddenClaim of forbiddenExecutionClaims) {
            expect(content, `README must not overstate provider execution: ${forbiddenClaim}`).not.toContain(
                forbiddenClaim,
            );
        }
    });

    it('documents the built-dist coding-agent smoke command honestly', () => {
        const content = readme();
        const requiredTerms = [
            'pnpm smoke:coding-agent-built-dist',
            'built-dist coding-agent smoke',
            'Todo 18',
            'tarball artifact smoke',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });
});
