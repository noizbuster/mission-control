/**
 * Shared team tool context: runtime seam + factory options.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode tool wiring
 * of oh-my-openagent (source-available license). No expression copied. The injectable
 * `TeamToolRuntime` keeps every team_* tool free of real provider/session
 * calls so tests can mock member spawning; the live runtime wires this to the
 * agent/session layer (mirrors the `TaskToolRuntime` pattern).
 */
import type { MemberSpec, TeamModeConfig } from './team-schemas';

/** The workspace root that backs the `.omo/teams/` directory. */
export interface TeamToolContext {
    /** Absolute workspace root containing `.omo/teams/`. */
    readonly root: string;
    /** Resolved team-mode config (the gate lives on `config.enabled`). */
    readonly config: TeamModeConfig;
    /** Injectable runtime for member spawning / id minting / clock. */
    readonly runtime: TeamToolRuntime;
    /**
     * Optional live-delivery bridge. When provided, `team_send_message` forwards
     * a copy to in-process peers via this hook (e.g. the `irc` bus), in addition
     * to the durable mailbox append. Omit for durable-only delivery.
     */
    readonly ircBridge?: TeamIrcBridge;
}

export interface SpawnedMember {
    readonly sessionId: string;
    readonly worktreePath?: string;
}

export interface MemberSpawnRequest {
    readonly teamRunId: string;
    readonly member: MemberSpec;
    readonly leadSessionId: string;
}

/**
 * Injectable seam for the effectful side of team_* tools. The default
 * implementation throws `not_yet_implemented` until the CLI graph-runner
 * connection lights up real member sessions; tests inject a recording double.
 */
export interface TeamToolRuntime {
    readonly spawnMember: (request: MemberSpawnRequest) => Promise<SpawnedMember>;
    readonly generateTeamRunId: (name: string) => string;
    readonly now: () => string;
}

export interface TeamIrcBridge {
    readonly deliver: (message: {
        readonly teamRunId: string;
        readonly from: string;
        readonly to: string;
        readonly body: string;
    }) => Promise<void>;
}

export class TeamToolNotImplementedError extends Error {
    constructor() {
        super(
            'team tool runtime is not wired to a real member spawner yet; inject a TeamToolRuntime ' +
                '(the CLI graph-runner connection is the integration point)',
        );
        this.name = 'TeamToolNotImplementedError';
    }
}

let idCounter = 0;

/** Default runtime: throws on spawn, mints ids from the team name + a counter. */
export function createDefaultTeamToolRuntime(): TeamToolRuntime {
    return {
        async spawnMember() {
            throw new TeamToolNotImplementedError();
        },
        generateTeamRunId(name) {
            idCounter += 1;
            const slug = name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 32);
            return `team_${slug || 'run'}_${idCounter}`;
        },
        now: () => new Date().toISOString(),
    };
}

/** Common option bag for every team tool factory. Self-gates on config.enabled. */
export interface TeamToolFactoryOptions {
    readonly context: TeamToolContext;
}

/** Returns true when team mode is enabled; factories return null otherwise. */
export function teamModeEnabled(config: TeamModeConfig | undefined): boolean {
    return config?.enabled === true;
}
