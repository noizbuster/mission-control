import { filePatchFailure } from './file-patch-errors.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function isDirtyTrackedTarget(workspaceRoot: string, path: string): Promise<boolean> {
    let stdout: string;
    try {
        const result = await execFileAsync('git', ['status', '--porcelain', '--', path], { cwd: workspaceRoot });
        stdout = result.stdout;
    } catch (error: unknown) {
        throw filePatchFailure('git_status_failed', errorMessage(error));
    }
    return stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .some((line) => !line.startsWith('??') && !line.startsWith('!!'));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
