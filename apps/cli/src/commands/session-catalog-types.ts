import type { ReplayDiagnostic } from '@mission-control/core';
import type { AgentSnapshot, SessionAwaitingDetails } from '@mission-control/protocol';

export type CliSessionListStatus = AgentSnapshot['status'] | 'corrupt' | 'missing';
export type CliSessionCatalogDiagnostic =
    | ReplayDiagnostic
    | {
          readonly code: 'corrupt_index' | 'index_diagnostic';
          readonly sessionId: string;
          readonly message: string;
          readonly lineNumber?: number | undefined;
      };

export type CliSessionCatalogEntry = {
    readonly sessionId: string;
    readonly status: CliSessionListStatus;
    readonly awaiting?: SessionAwaitingDetails | undefined;
    readonly eventCount: number;
    readonly messageCount: number;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
    readonly cwd?: string | undefined;
    readonly trustedRoot?: string | undefined;
    readonly name?: string | undefined;
    readonly activeLeafId?: string | undefined;
    readonly parentSessionId?: string | undefined;
    readonly trustStatus: 'trusted' | 'denied' | 'unknown';
    readonly diagnostics: readonly CliSessionCatalogDiagnostic[];
};
