import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('README distribution contract', () => {
    it('documents GitHub and curl distribution while deferring npm publication', () => {
        const readme = readFileSync(join(root, 'README.md'), 'utf8');
        const terms = [
            'curl -fsSL https://raw.githubusercontent.com/noizbuster/mission-control/main/scripts/install.sh | sh',
            'MISSION_CONTROL_REPO=owner/repo',
            'GitHub Releases',
            'mctrl-linux-x64.tar.gz',
            'mctrl-darwin-arm64.tar.gz',
            '.sha256',
            'Desktop release',
            'GitHub Actions',
            'release TODO',
            'mission-control desktop app',
        ] as const;

        for (const term of terms) {
            expect(readme, `README missing ${term}`).toContain(term);
        }
        expect(readme).toContain(
            'npm publication is deferred while the CLI and its workspace runtime packages remain private.',
        );
        expect(readme).not.toMatch(/(?:^|\s)npm\s+(?:i|install)\b/mu);
        expect(readme).not.toContain('OWNER_PLACEHOLDER');
    });
});
