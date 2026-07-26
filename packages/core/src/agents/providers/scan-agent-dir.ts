/**
 * Shared directory scanner for cross-harness agent providers. Each provider
 * (cline, windsurf, VS Code, GitHub Copilot, OpenCode, Codex, Gemini)
 * delegates its directory walk to this helper so the scan/parse/skip contract
 * lives in one place.
 *
 * Contract:
 * - Flat scan (immediate children only); no recursion.
 * - Only regular `.md` files are read — symlinks and directories are skipped.
 * - `AGENTS.md` is always excluded (it is a context file, not an agent).
 * - Missing directory → empty array (never throws).
 * - Per-file read or parse failures are silently skipped so one broken file
 *   never halts the scan; the provider interface surfaces no per-file
 *   diagnostics.
 * - Optional `opts.sort` sorts candidate entries by basename via
 *   `localeCompare` for deterministic order independent of listing order
 *   (default: off — original insertion order is preserved).
 * - Optional `opts.maxBytes` skips files whose `stat().size` exceeds the
 *   limit, silently (default: off — no size guard). Oversized files emit no
 *   diagnostic, matching the per-file skip contract.
 */
import { type AgentDefinition, type AgentSource } from '@mission-control/protocol';
import { parseAgentFile } from '../agent-parser';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const AGENT_FILE_SUFFIX = '.md';
const EXCLUDED_BASENAMES: ReadonlySet<string> = new Set(['agents.md']);

export async function scanAgentMarkdownDir(
    dir: string,
    source: AgentSource,
    opts?: { readonly sort?: boolean; readonly maxBytes?: number },
): Promise<readonly AgentDefinition[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const ordered = opts?.sort ? [...entries].sort((a, b) => a.name.localeCompare(b.name)) : entries;
    const maxBytes = opts?.maxBytes;

    const agents: AgentDefinition[] = [];
    for (const entry of ordered) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(AGENT_FILE_SUFFIX)) continue;
        if (EXCLUDED_BASENAMES.has(entry.name.toLowerCase())) continue;

        const filePath = join(dir, entry.name);

        if (maxBytes !== undefined) {
            try {
                if ((await stat(filePath)).size > maxBytes) continue;
            } catch {
                continue;
            }
        }

        let content: string;
        try {
            content = await readFile(filePath, 'utf8');
        } catch {
            continue;
        }

        try {
            agents.push(parseAgentFile(filePath, content, source));
        } catch {
            // Parse failure — skip silently.
        }
    }
    return agents;
}
