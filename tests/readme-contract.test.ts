import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readme(): string {
    return readFileSync(join(root, 'README.md'), 'utf8');
}

function readDoc(path: string): string {
    return readFileSync(join(root, path), 'utf8');
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
            'the default `local/local-echo` provider does not call tools',
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
            'mc auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>',
            'mc auth login --provider amazon-bedrock --credential region=<region> --credential accessKeyId=<key-id> --credential secretAccessKey=<secret>',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc auth login --provider local --api-key local_test_key',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc run "summarize this repository" --session session_demo --jsonl --provider local --model local-echo',
            'MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc session replay session_demo --jsonl',
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
            'mc auth login',
            'mc auth list',
            'mc auth logout --provider local',
            'mc models local',
            'MISSION_CONTROL_AUTH_FILE',
            '$XDG_DATA_HOME/mission-control/auth.json',
            '~/.local/share/mission-control/auth.json',
            'Stored credentials configure the default provider/model for later demo runs',
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

    it('documents the implemented coding-agent runtime scope and safety boundaries', () => {
        const content = readme();
        const requiredTerms = [
            'Coding Agent Runtime',
            'OpenAI Responses adapter is implemented behind stored provider credentials',
            'MCTRL_DATA_DIR',
            'sessions/<session-id>.jsonl',
            'New authoritative session event/replay writes use the local libSQL database at `<data-dir>/mission-control.db`',
            'Each canonical database file has one leased libSQL client and Drizzle handle per process',
            'Every in-process mutation, including schema initialization, enters the explicit file-scoped write lane',
            '`journal_mode=WAL`, `synchronous=NORMAL`, and a 5000 ms cross-process busy timeout',
            'The product opener opens `<data-dir>/mission-control.db` directly',
            '`LocalDbConfigError` or `LocalDbInitializationError`, including WAL refusal, is fatal',
            'Runtime coordination SQL for session input delivery, Mission/Run records, context epochs, runtime agents, async jobs, and relation rows uses the same local `<data-dir>/mission-control.db` path as the public session projection',
            'Production `approval`, `user_input`, and foreground `subagent` waits surface through the public `mission-control.db` session-list/read path',
            '[`docs/session-data-model.md`](docs/session-data-model.md)',
            'Remote Turso is out of scope for session storage',
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

        const forbiddenSessionStoreClaims = [
            'The append-only event ledger is `session_events`; projection tables derive session lists, transcript messages, approvals, tool calls, provider failures, awaiting state, subagent lineage, and async jobs from those events and runtime mirrors.',
            'New authoritative session writes use the local libSQL database at `<data-dir>/mission-control.db`, shared with persistent memory storage through the `schema_migrations` ledger.',
            '`user_input` and `subagent` wait adapters exist on the runtime ' +
                'DB ' +
                'path, but are not yet ' +
                'surfaced by the public data-dir session-list path without a unifying ' +
                'projection',
        ] as const;

        for (const forbiddenClaim of forbiddenSessionStoreClaims) {
            expect(content, `README must not overstate unified session storage: ${forbiddenClaim}`).not.toContain(
                forbiddenClaim,
            );
        }
    });

    it('documents the current local session DB awaiting projection without stale blocker claims', () => {
        const content = readDoc('docs/session-data-model.md');
        const requiredTerms = [
            '`<MCTRL_DATA_DIR>/mission-control.db` is the authoritative session event/replay',
            '`user_input` and foreground `subagent` waits are mirrored there',
            'Runtime coordination SQL',
            'async jobs, and relation rows uses the same local-only data-dir `mission-control.db`',
            'The full `approval` / `user_input` / `subagent` priority order is production-wired',
            '`session_awaits` stores active waits in the public `mission-control.db` projection',
            'agent/job mirror tables intentionally share `mission-control.db`',
            'every canonical database file has one',
            'Every in-process mutation, including schema initialization, enters the explicit',
            'Cross-process contention is bounded by a 5000 ms busy timeout',
            '`journal_mode=WAL`, `synchronous=NORMAL`',
            '`LocalDbConfigError` and `LocalDbInitializationError` are',
            'Runtime startup does not probe an older SQL filename and has no legacy',
            "Foreground subagent waits and persisted async job rows insert `session_relations` rows with `kind = 'subagent'`",
            'Remote Turso is out of scope',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `session data model missing ${term}`).toContain(term);
        }

        const forbiddenTerms = [
            '`<workspace>/.omo/mission-control' + '.db`',
            'so migrations for memory, sessions, run state, input delivery, and subagent jobs share one `schema_migrations` ledger',
            'The same file also stores persistent memory rows',
            'does not yet ' + 'populate relation rows',
            'not yet ' + 'unified into the data-dir `mission-control.db` public session-list surface',
            'Production `user_input` and foreground `subagent` wait adapters currently write the runtime ' + 'DB',
            '`mission-control.db` remains follow-up ' + 'work',
        ] as const;

        for (const term of forbiddenTerms) {
            expect(content, `session data model must not contain stale claim ${term}`).not.toContain(term);
        }
    });

    it('documents workspace trust permission profiles and expanded coding-agent tool set', () => {
        const content = readme();
        const requiredTerms = [
            'Workspace trust',
            'project trust store',
            'trust/projects.json',
            '`bash.run`, `file.edit`, and `file.write` are only available when the workspace is trusted',
            'Permission profiles',
            'Built-in rules allow `read` always, and ask for `edit`, `write`, `patch`, and `bash` by default',
            'Interactive replies support `once`',
            '`always` replies can persist to the permission rule store',
            'Noninteractive `--no-tui` and `--json` runs use the pending-approval-block behavior',
            'Coding-agent tool set',
            'Read-only: `repo.read`, `repo.list`, `repo.search`, plus aliases `read`, `ls`, `grep`, and `find`',
            'Exact replacement: `file.edit` replaces exact text in an existing file',
            'Full create/replace: `file.write` creates or replaces a file with full text content',
            'Trusted bash: `bash.run` runs non-interactive bash with strict command-line parsing',
            '`file.edit`, `file.write`, `file.patch`, `command.run`, and `bash.run` require approval before executing',
            '`bash.run` additionally requires a trusted workspace',
            'shared workspace mutation queue with pre-approval and post-approval target revalidation',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents noninteractive JSON/JSONL run states and session management', () => {
        const content = readme();
        const requiredTerms = [
            'Noninteractive JSON/JSONL run states',
            'Run receipts settle as `completed`, `failed`, `interrupted`, or `blocked_on_approval`',
            'blocked_on_approval',
            'Session export, import, compaction, deletion, and stats',
            'checksummed session archive file',
            '`mc session export <id> <path>`',
            '`mc session import <path>`',
            '`mc session list` lists sessions with lifecycle status',
            '`mc session show <id>` shows the session snapshot',
            "Each session's SQLite rows, compatibility JSONL log if present, and projection rows are removed",
            'durable compaction boundary event',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents implemented MCP, web, subagent, and skills capabilities plus deferred LSP transport', () => {
        const content = readme();
        const implementedClauses = [
            'MCP tools are implemented',
            'web tools (glob, todowrite, webfetch) are implemented',
            'subagent orchestration via the task tool is implemented',
            'Skills are implemented',
            'LSP integration transport is deferred',
        ] as const;

        for (const clause of implementedClauses) {
            expect(content, `README must document implemented capability: ${clause}`).toContain(clause);
        }

        const stillDeferredClauses = [
            'full desktop terminal parity is not implemented',
            'LSP integration transport is deferred',
        ] as const;

        for (const clause of stillDeferredClauses) {
            expect(content, `README must document deferral: ${clause}`).toContain(clause);
        }

        const forbiddenOverclaims = [
            'ACP protocol is implemented',
            'LSP integration is implemented',
            'all tools execute without approval',
            'MCP tools, ACP protocol, LSP integration, web tools, and subagent orchestration are not implemented',
        ] as const;

        for (const forbidden of forbiddenOverclaims) {
            expect(content, `README must not overclaim or restate deferral: ${forbidden}`).not.toContain(forbidden);
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
