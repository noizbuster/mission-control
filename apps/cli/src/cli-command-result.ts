export type CliCommandExitCode = 0 | 1 | 2;

export type CliCommandResult = {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: CliCommandExitCode;
};

export function successfulCliCommand(stdout: string): CliCommandResult {
    return { stdout, stderr: '', exitCode: 0 };
}
