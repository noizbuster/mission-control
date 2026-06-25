import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectGitBranch } from './opentui-chat-bridge.js';

describe('detectGitBranch', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns the current git branch of the actual mission-control repo', () => {
        const branch = detectGitBranch(process.cwd());
        // The dev checkout is a git repo; branch must be a non-empty string and not "HEAD"
        expect(typeof branch).toBe('string');
        expect(branch?.length).toBeGreaterThan(0);
        expect(branch).not.toBe('HEAD');
    });

    it('returns undefined when workspaceRoot is undefined', () => {
        expect(detectGitBranch(undefined)).toBeUndefined();
    });

    it('returns undefined when the workspace is not a git repo', () => {
        const branch = detectGitBranch('/tmp');
        expect(branch).toBeUndefined();
    });

    it('returns undefined when the path does not exist', () => {
        expect(detectGitBranch('/nonexistent/mctrl-no-such-path')).toBeUndefined();
    });
});
