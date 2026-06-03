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
            'pnpm dev:cli -- --no-tui --provider mock --model mission-control-fast',
            'pnpm dev:cli -- --json --model local/local-echo',
            'provider/model controls',
            'provider/model selection is scaffold metadata',
            'does not call real LLM providers yet',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });

    it('documents auth commands and credential storage', () => {
        const content = readme();
        const requiredTerms = [
            'mctrl auth login --provider mock --api-key <key>',
            'mctrl auth login',
            'mctrl auth list',
            'mctrl auth logout --provider mock',
            'mctrl models local',
            'MISSION_CONTROL_AUTH_FILE',
            '$XDG_DATA_HOME/mission-control/auth.json',
            '~/.local/share/mission-control/auth.json',
            'stored credentials configure the default provider/model for later demo runs',
            'credentials are used for scaffold configuration only',
            'API keys are stored as plaintext JSON',
            'not encrypted keychain storage',
        ] as const;

        for (const term of requiredTerms) {
            expect(content, `README missing ${term}`).toContain(term);
        }
    });
});
