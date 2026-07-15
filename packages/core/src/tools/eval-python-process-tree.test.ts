import { describe, expect, it, vi } from 'vitest';
import {
    createPythonProcessTreeTerminator,
    type ProcessTreeCommandRunFn,
    PythonProcessTreeTerminationError,
    pythonSpawnOptionsFor,
} from './eval-python-kernel';

describe('Python eval process-tree lifecycle', () => {
    it('creates a detached process group for POSIX kernels', () => {
        // Given / When
        const options = pythonSpawnOptionsFor('linux');

        // Then
        expect(options).toMatchObject({ detached: true, shell: false, stdio: 'pipe' });
    });

    it('uses direct taskkill arguments for Windows process trees', async () => {
        // Given
        const calls: Array<{
            readonly command: string;
            readonly args: readonly string[];
            readonly options: { readonly shell: false; readonly windowsHide: true; readonly stdio: 'ignore' };
        }> = [];
        const runCommand: ProcessTreeCommandRunFn = async (command, args, options) => {
            calls.push({ command, args, options });
            return { exitCode: 0, signal: null };
        };
        const terminate = createPythonProcessTreeTerminator({ platform: 'win32', runCommand });

        // When
        await terminate(4312);

        // Then
        expect(calls).toEqual([
            {
                command: 'taskkill.exe',
                args: ['/PID', '4312', '/T', '/F'],
                options: { shell: false, windowsHide: true, stdio: 'ignore' },
            },
        ]);
    });

    it('treats a missing PID as an already-terminated process tree', async () => {
        // Given
        const kill = vi.fn();
        const terminate = createPythonProcessTreeTerminator({ platform: 'linux', kill });

        // When
        await terminate(undefined);

        // Then
        expect(kill).not.toHaveBeenCalled();
    });

    it('treats POSIX ESRCH as an already-terminated process tree', async () => {
        // Given
        const kill = vi.fn(() => {
            throw Object.assign(new Error('missing process group'), { code: 'ESRCH' });
        });
        const terminate = createPythonProcessTreeTerminator({ platform: 'linux', kill });

        // When
        await terminate(4312);

        // Then
        expect(kill).toHaveBeenCalledWith(-4312, 'SIGKILL');
    });

    it('surfaces non-ESRCH POSIX termination failures as typed errors', async () => {
        // Given
        const kill = vi.fn(() => {
            throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        });
        const terminate = createPythonProcessTreeTerminator({ platform: 'linux', kill });

        // When / Then
        await expect(terminate(4312)).rejects.toMatchObject({
            name: 'PythonProcessTreeTerminationError',
            reason: 'posix_kill_failed',
            pid: 4312,
        } satisfies Partial<PythonProcessTreeTerminationError>);
    });

    it('surfaces taskkill failures as typed errors', async () => {
        // Given
        const runCommand: ProcessTreeCommandRunFn = async () => ({ exitCode: 1, signal: null });
        const terminate = createPythonProcessTreeTerminator({ platform: 'win32', runCommand });

        // When / Then
        await expect(terminate(4312)).rejects.toMatchObject({
            name: 'PythonProcessTreeTerminationError',
            reason: 'windows_taskkill_failed',
            pid: 4312,
        } satisfies Partial<PythonProcessTreeTerminationError>);
    });
});
