import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('README distribution contract', () => {
    it('documents npm curl artifacts desktop release and CI/CD', () => {
        const readme = readFileSync(join(root, 'README.md'), 'utf8');
        const terms = [
            'npm install -g @mission-control/cli',
            'npm install -g mission-control',
            'curl -fsSL https://raw.githubusercontent.com/noizbuster/mission-control/main/scripts/install.sh | sh',
            'mctrl-linux-x64.tar.gz',
            'mctrl-darwin-arm64.tar.gz',
            'Desktop release',
            'GitHub Actions',
            'release TODO',
            'mission-control desktop app',
        ] as const;

        for (const term of terms) {
            expect(readme, `README missing ${term}`).toContain(term);
        }
    });
});
