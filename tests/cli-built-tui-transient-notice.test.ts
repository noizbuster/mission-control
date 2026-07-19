import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = resolve(process.cwd(), 'apps/cli/dist/index.js');
const promptMarker = 'local local-echo';
const notice = 'Press Ctrl+C again to exit';
const VIEWPORTS = [
    { width: 128, height: 40 },
    { width: 48, height: 24 },
] as const;

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
    });
}

async function capturePane(session: string): Promise<string> {
    const result = await execFileAsync('tmux', ['capture-pane', '-p', '-t', session, '-S', '-80']);
    return result.stdout;
}

async function waitForPaneText(session: string, text: string): Promise<string> {
    let frame = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
        frame = await capturePane(session);
        if (frame.includes(text)) {
            return frame;
        }
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${text} in terminal frame:\n${frame}`);
}

async function paneState(session: string): Promise<string> {
    const result = await execFileAsync('tmux', ['list-panes', '-t', session, '-F', '#{pane_dead} #{pane_dead_status}']);
    return result.stdout.trim();
}

async function waitForPaneState(session: string, expected: string): Promise<void> {
    let state = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
        state = await paneState(session);
        if (state === expected) {
            return;
        }
        await delay(100);
    }
    throw new Error(`Timed out waiting for pane state ${expected}; received ${state}`);
}

describe('built TUI transient Ctrl+C notice', () => {
    for (const viewport of VIEWPORTS) {
        it(`paints the first raw ETX notice and only exits on the second ETX at ${viewport.width}x${viewport.height}`, async () => {
            const root = await mkdtemp(join(tmpdir(), 'mission-control-tui-notice-'));
            const session = `mctrl-notice-${process.pid}-${Date.now()}`;
            const command = [
                `MCTRL_DATA_DIR=${join(root, 'data')}`,
                `MCTRL_CONFIG_DIR=${join(root, 'config')}`,
                `MISSION_CONTROL_AUTH_FILE=${join(root, 'auth.json')}`,
                'node',
                '--experimental-ffi',
                cliPath,
                '--provider',
                'local',
                '--model',
                'local-echo',
            ].join(' ');
            let sessionStarted = false;

            try {
                await execFileAsync('tmux', [
                    'new-session',
                    '-d',
                    '-s',
                    session,
                    '-x',
                    String(viewport.width),
                    '-y',
                    String(viewport.height),
                    '-c',
                    process.cwd(),
                    command,
                ]);
                sessionStarted = true;
                await execFileAsync('tmux', ['set-option', '-t', session, 'remain-on-exit', 'on']);
                await waitForPaneText(session, promptMarker);

                await execFileAsync('tmux', ['send-keys', '-t', session, '-H', '03']);
                const noticeFrame = await waitForPaneText(session, notice);

                expect(noticeFrame).toContain(notice);
                expect(await paneState(session)).toBe('0');

                await execFileAsync('tmux', ['send-keys', '-t', session, '-H', '03']);
                await waitForPaneState(session, '1 0');
            } finally {
                if (sessionStarted) {
                    await execFileAsync('tmux', ['kill-session', '-t', session]);
                }
                await rm(root, { recursive: true, force: true });
            }
        }, 15_000);
    }
});
