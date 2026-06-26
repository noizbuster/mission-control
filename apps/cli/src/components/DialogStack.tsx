/** @jsxImportSource @opentui/react */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type DialogEntry = {
    readonly element: () => ReactNode;
    readonly onClose?: () => void;
};

export type DialogStackValue = {
    readonly push: (entry: DialogEntry) => void;
    readonly replace: (entry: DialogEntry) => void;
    readonly clear: () => void;
    readonly current: DialogEntry | null;
};

const DialogStackContext = createContext<DialogStackValue | null>(null);

export function DialogStackProvider({ children }: { readonly children: ReactNode }): ReactNode {
    const [stack, setStack] = useState<readonly DialogEntry[]>([]);

    const push = useCallback((entry: DialogEntry): void => {
        setStack((prev) => [...prev, entry]);
    }, []);

    const replace = useCallback((entry: DialogEntry): void => {
        setStack((prev) => {
            if (prev.length === 0) return [entry];
            return [...prev.slice(0, -1), entry];
        });
    }, []);

    const clear = useCallback((): void => {
        setStack((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
                prev[i]?.onClose?.();
            }
            return [];
        });
    }, []);

    const value = useMemo<DialogStackValue>(
        () => ({
            push,
            replace,
            clear,
            current: stack.length > 0 ? (stack[stack.length - 1] ?? null) : null,
        }),
        [push, replace, clear, stack],
    );

    return <DialogStackContext.Provider value={value}>{children}</DialogStackContext.Provider>;
}

export function useDialogStack(): DialogStackValue {
    const ctx = useContext(DialogStackContext);
    if (ctx === null) {
        throw new Error('useDialogStack must be used within a DialogStackProvider');
    }
    return ctx;
}

export function useDialogStackOrNull(): DialogStackValue | null {
    return useContext(DialogStackContext);
}
