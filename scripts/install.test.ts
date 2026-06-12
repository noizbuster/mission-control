import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('curl install script contract', () => {
    it('supports expected platform artifact names with public release repo default', () => {
        const source = readFileSync(join(root, 'scripts/install.sh'), 'utf8');

        expect(source).toContain(
            ['MISSION_CONTROL_REPO="', '$', '{MISSION_CONTROL_REPO:-noizbuster/mission-control}"'].join(''),
        );
        expect(source).toContain(
            ['https://github.com/', '$', '{MISSION_CONTROL_REPO}/releases/latest/download/', '$', '{artifact}'].join(
                '',
            ),
        );
        expect(source).not.toContain('OWNER_PLACEHOLDER');
        expect(source).toContain('linux');
        expect(source).toContain('darwin');
        expect(source).toContain('x64');
        expect(source).toContain('arm64');
        expect(source).toContain(['mctrl-', '$', '{os}-', '$', '{arch}.tar.gz'].join(''));
        expect(source).toContain('MISSION_CONTROL_TEST_OS');
        expect(source).toContain('MISSION_CONTROL_TEST_ARCH');
    });
});
