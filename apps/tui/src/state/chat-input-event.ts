/**
 * ChatInputEvent — the discriminated union for the imperative chat-loop bridge.
 *
 * Extracted from the CLI terminal-I/O layer so the TUI chat store can reference
 * the event contract without importing CLI runtime. The CLI's
 * `interactive-chat-io.ts` re-exports this type.
 */
export type ChatInputEvent =
    | {
          readonly type: 'line';
          readonly value: string;
      }
    | {
          readonly type: 'interrupt';
          readonly interruptedPartialInput?: boolean;
          /**
           * Origin of the interrupt. Used by the main chat loop to decide
           * whether the event may trigger an exit (second consecutive press
           * while idle). ESC-sourced interrupts never exit; Ctrl+C-sourced
           * (and legacy undefined-source) interrupts preserve the existing
           * "press twice to exit" contract.
           */
          readonly source?: 'ctrl-c' | 'esc';
      };
