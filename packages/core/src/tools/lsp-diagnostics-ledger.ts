// Adapted from oh-my-pi diagnostics-ledger logic (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Boluk
// Source: https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/lsp/diagnostics-ledger.ts
//
// Reimplemented fresh for mission-control: the oh-my-pi ledger works on flat
// `file:line:col message` strings; this version works on the structured
// `LspDiagnostic` type and uses message+severity as the stable identity so the
// same error surfacing again after a re-analysis is recognised as stale.

import type { LspDiagnostic } from './lsp-tool.js';

/**
 * Stable identity for a diagnostic, independent of its line/character position.
 * Two diagnostics with the same message and severity are treated as the same
 * issue even if they shifted lines after an edit. This is what lets the ledger
 * drop stale diagnostics: the server re-pushes the same error after an edit
 * (before it has re-analysed), and the ledger recognises it as already-seen.
 */
function diagnosticIdentity(diag: LspDiagnostic): string {
    return `${diag.severity}:${diag.message}`;
}

/**
 * Per-URI ledger of diagnostic identities that have already been surfaced to
 * the model. `reduce` returns only the diagnostics whose identities were NOT
 * previously recorded, then updates the ledger so the next call only surfaces
 * genuinely new issues.
 *
 * Stale-drop scenario: the model edits a file, the LSP server re-pushes the
 * pre-edit diagnostics before re-analysing, and the ledger drops them because
 * their identities match the pre-edit set. The model never acts on stale state.
 */
export class LspDiagnosticsLedger {
    private readonly seen = new Map<string, Set<string>>();

    /**
     * Filter `diagnostics` to those not yet surfaced for `uri`, then record the
     * full set as the new baseline. When `diagnostics` is empty the entry is
     * cleared (a clean file should not retain a stale identity set).
     */
    reduce(uri: string, diagnostics: readonly LspDiagnostic[]): readonly LspDiagnostic[] {
        const previous = this.seen.get(uri);
        const currentIdentities = new Set<string>();
        const fresh: LspDiagnostic[] = [];

        for (const diag of diagnostics) {
            const identity = diagnosticIdentity(diag);
            currentIdentities.add(identity);
            if (previous === undefined || !previous.has(identity)) {
                fresh.push(diag);
            }
        }

        if (currentIdentities.size === 0) {
            this.seen.delete(uri);
        } else {
            this.seen.set(uri, currentIdentities);
        }

        return fresh;
    }

    /**
     * Forget the baseline for `uri`. Call this after a file mutation so the
     * next diagnostics request surfaces the post-edit set as fresh rather than
     * suppressing them as "already seen".
     */
    forget(uri: string): void {
        this.seen.delete(uri);
    }
}
