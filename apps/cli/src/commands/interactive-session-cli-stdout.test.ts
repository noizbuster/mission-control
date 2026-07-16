import { describe, expect, it } from 'vitest';
import { interactiveSessionCliStdout } from './interactive-session-cli-stdout';

describe('interactiveSessionCliStdout', () => {
    it('returns empty string when OpenTUI owned the display', () => {
        expect(
            interactiveSessionCliStdout({
                tuiOwnedDisplay: true,
                getOutput: () => 'You: hi\nassistant reply\n',
            }),
        ).toBe('');
    });

    it('returns buffered output for injected/non-TUI chat outputs', () => {
        expect(
            interactiveSessionCliStdout({
                tuiOwnedDisplay: false,
                getOutput: () => 'You: hi\nassistant reply\n',
            }),
        ).toBe('You: hi\nassistant reply\n');
    });

    it('returns empty string when no getOutput is available', () => {
        expect(interactiveSessionCliStdout({ tuiOwnedDisplay: false })).toBe('');
    });
});
