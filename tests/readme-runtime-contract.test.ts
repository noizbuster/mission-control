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

describe('README runtime contract', () => {
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
            'The read-only safe tool set is `repo.read`, `repo.list`, and `repo.search`; `file.patch` and `command.run` are approval-gated effectful tools.',
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
            'New authoritative session writes use the local libSQL database at `<data-dir>/mission-control.db`, shared with persistent memory storage through the `schema_' +
                'migrations` ledger.',
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
            'Runtime startup does not probe, attach, or import a separate older SQL',
            "Foreground subagent waits and persisted async job rows insert `session_relations` rows with `kind = 'subagent'`",
            'Remote Turso is out of scope',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `session data model missing ${term}`).toContain(term);
        }

        const forbiddenTerms = [
            '`<workspace>/.mc/mission-control' + '.db`',
            'so migrations for memory, sessions, run state, input delivery, and subagent jobs share one `schema_' +
                'migrations` ledger',
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

    it('documents SQL-only session storage and archive import without legacy JSONL auto-discovery', () => {
        const readmeContent = readme();
        const dataModelContent = readDoc('docs/session-data-model.md');
        const readmeTerms = [
            'session store is SQL-only',
            'Archive import writes SQL directly',
            'does not probe or automatically import prior SQL stores',
            'JSONL remains an archive export payload format',
        ] as const;
        const dataModelPatterns = [
            /migrates legacy projection table names in place\s+within the already-open canonical database/u,
            /`session_index_runs` is copied into\s+`session_projection_runs` and then dropped/u,
            /`session_index_diagnostics` is copied into\s+`session_projection_diagnostics` and\s+then dropped/u,
            /does not probe, attach, or import a separate older SQL\s+database file/u,
            /session store is SQL-only/u,
            /does not auto-discover or import `sessions\/\*\.jsonl`/u,
            /archive import writes validated envelopes into SQL/u,
            /JSONL remains the archive export payload format only/u,
            /`desktop_approval_effects`/u,
            /`desktop_tool_proposals`/u,
            /private execution authority, not event, replay,\s+or archive data/u,
            /At-most-once ledger for one approved desktop tool effect, separate from approval decision history/u,
            /`pending -> executing -> settled \| unknown`/u,
            /opaque execution token and lease/u,
            /`desktop_approval_effects_state_idx`/u,
            /Pending, executing, settled, and unknown effect work/u,
        ] as const;

        for (const term of readmeTerms) {
            expect(readmeContent, `README missing ${term}`).toContain(term);
        }
        for (const pattern of dataModelPatterns) {
            expect(dataModelContent, `session data model missing ${pattern.source}`).toMatch(pattern);
        }
        expect(readmeContent).not.toContain('legacy_session_imports');
        expect(dataModelContent).not.toContain('legacy_session_imports');
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
