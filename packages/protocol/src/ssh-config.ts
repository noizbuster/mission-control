/**
 * SSH host configuration schema (config-gated credential surface for the `ssh` tool).
 *
 * Hosts are declared in user/project config and passed into the ssh tool at
 * registration time. The tool is config-gated: when no hosts are configured the
 * tool is not registered, so the model can never discover a half-wired ssh
 * surface. This mirrors oh-my-pi's `capability/ssh` shape (MIT), ported to Zod
 * and stripped of the source-metadata + compat-detection fields that belong to
 * oh-my-pi's capability loader rather than the static credential contract.
 *
 * Credential fields (`keyPath`) are declarative config; the ssh tool never
 * serializes them into events, JSONL logs, CLI output, or model output.
 */
import { z } from 'zod';

export const SshHostConfigSchema = z
    .object({
        /** Config key the model addresses the host by (`ssh host <name>`). */
        name: z.string().min(1).max(128),
        /** Host address or DNS name. */
        host: z.string().min(1).max(256),
        /** Optional username override. */
        username: z.string().min(1).max(128).optional(),
        /** Optional port override (default 22). */
        port: z.number().int().min(1).max(65535).optional(),
        /** Optional identity key path. Declarative config; never echoed to the model. */
        keyPath: z.string().min(1).max(1_024).optional(),
        /** Optional human-readable description surfaced in the tool description. */
        description: z.string().min(1).max(512).optional(),
    })
    .strict();

export type SshHostConfig = z.infer<typeof SshHostConfigSchema>;

/** Map of host name to its config (the on-disk `ssh.hosts` shape). */
export const SshHostsConfigSchema = z.record(z.string(), SshHostConfigSchema);
export type SshHostsConfig = z.infer<typeof SshHostsConfigSchema>;
