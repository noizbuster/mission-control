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
            '@mission-control/tui',
            '@mission-control/desktop',
            'native/sidecar',
            'mc',
            'mctrl',
            'mission-control-sidecar',
            'desktop product name is `mission-control`',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents @mission-control/tui as private internal', () => {
        const content = readme();
        expect(content, 'README must document @mission-control/tui').toContain('@mission-control/tui');
        expect(content, 'README must document the TUI as Solid/OpenTUI').toContain('Solid/OpenTUI TUI app');
        expect(content, 'README must document @opentui/solid').toContain('@opentui/solid');
        expect(content, 'README must document solid-js').toContain('solid-js');

        expect(content, 'README must state @mission-control/tui is private/not publishable').toContain(
            'Not publishable',
        );
        expect(content, 'README must not claim a public TUI install command').not.toContain(
            'npm install -g @mission-control/tui',
        );
        expect(content, 'README must not claim a dev:tui script').not.toContain('pnpm dev:tui');
        expect(content, 'README must not document the private TUI as OpenTUI React').not.toContain('@opentui/react');
        expect(content, 'README must not keep stale private TUI React prose').not.toContain(
            'React components, TUI mount/store seam, keymap platform',
        );
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

    it('distinguishes legacy demo metadata from executable coding-provider selection', () => {
        const content = readme();
        const requiredTerms = [
            'pnpm dev:cli -- --no-tui --provider local --model local-echo',
            'pnpm dev:cli -- --json --model local/local-echo',
            'provider/model controls',
            'Provider capability statuses',
            'model-discovery-only',
            'Provider-backed coding commands require an executable adapter proof before a provider can run',
            'legacy no-prompt demo uses provider/model selection only as observable event metadata',
            'does not call an LLM',
            'Coding-agent prompt runs use executable provider adapters or the AI-SDK graph resolver',
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
            '`/compact` summarizes older session history into a durable compaction boundary event',
            '`/session` with no argument opens a searchable picker of sessions previously opened in the current project',
            '`/resume` resumes the most recent session for this project',
            '`/continue` resumes a blocked run that is waiting on an approval decision',
            'Workspace trust is controlled interactively with `/trust`',
            '`/trust deny` (deny project-local resources for the workspace)',
            '`/trust reset` (clear the trust decision)',
            '$skill <name> [args]` loads the named skill',
            'real skill loading, replacing the old scaffold recorder',
            'Normal prompt text still sends a prompt',
            'Ctrl+C twice exits',
            'does not run actual Codex host skills',
            'The default `local/local-echo` provider is not a general-purpose tool-calling provider',
            '`/agents` with no argument opens the agent control dashboard',
            '`/agents list` prints the discovered-agents list as text',
            'The reserved subcommands `dashboard`, `list`, `reload`, and `disable`',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents mc agents CLI and /agents dashboard', () => {
        const content = readme();
        const requiredTerms = [
            'mc agents list',
            'mc agents show <name>',
            'mc agents unpack [--all] [<name>] [--force] [--user|--project|--dir <path>] [--json]',
            'mc agents disable <name>',
            'mc agents enable <name>',
            'mc agents import <harness> <path>',
            'copies bundled agent templates to `.mctrl/agents/`',
            'The default scope is the project directory',
            'opens the agent control dashboard in the TUI',
            'prints the discovered-agents list as text when the TUI is unavailable',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents auth commands and credential storage', () => {
        const content = readme();
        const requiredTerms = [
            'mc auth login --provider local --api-key <key>',
            'mc auth login --provider anthropic --api-key <key>',
            'mc auth login --provider openai --method oauth-headless',
            'mc auth login --provider github-copilot --method oauth',
            'mc auth login --provider xai --method oauth',
            'mc auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>',
            'mc auth login --provider amazon-bedrock --credential region=<region> --credential accessKeyId=<key-id> --credential secretAccessKey=<secret>',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc auth login --provider local --api-key local_test_key',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc run "summarize this repository" --session session_demo --jsonl --provider local --model local-echo',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc session replay session_demo --jsonl',
            '--credential FIELD=VALUE',
            'OAuth-capable providers expose OpenCode-style `--method` choices',
            'OpenAI supports browser and headless ChatGPT OAuth plus API key login',
            'GitHub Copilot supports OAuth device login plus API key login',
            'xAI supports SuperGrok / X Premium+ OAuth device login plus API key login',
            'OpenCode/Models.dev provider credential catalog',
            'vendored Models.dev snapshot',
            'supports credential setup for every vendored OpenCode provider',
            'does not implement real LLM provider execution',
            'no runtime fetch to Models.dev',
            'explicit CLI values, matching environment variables, existing stored values, and interactive prompts',
            'mc auth login',
            'mc auth list',
            'mc auth logout --provider local',
            'mc models local',
            'MISSION_CONTROL_AUTH_FILE',
            '$XDG_DATA_HOME/mission-control/auth.json',
            '~/.local/share/mission-control/auth.json',
            'Stored credentials configure the default provider/model for subsequent CLI runs',
            'Interactive `/model` choices are narrower than `mc models`',
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
});
