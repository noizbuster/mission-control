/**
 * Ambient minimal type declaration for `better-sqlite3`.
 *
 * `better-sqlite3` is an OPERATOR-SUPPLIED runtime dependency — a native module that is
 * intentionally NOT a manifest dependency of `@mission-control/core` (a dependency guard
 * gates that; the JSONL ledger remains the source of truth, ABG §12). This ambient
 * declaration gives the `SqlitePersistentStore` adapter a typecheck-resolvable surface for
 * the methods it uses (exec / prepare / run / get / all / close) WITHOUT installing the
 * package. At runtime, `SqlitePersistentStore.open` dynamically imports the real module from
 * the operator's deployment; if it is absent, `isSqliteAvailable()` reports false and
 * consumers use `InMemoryPersistentStore`.
 *
 * The shapes here match the real `better-sqlite3` v12 API for the subset this adapter uses.
 */
declare module 'better-sqlite3' {
    export interface Statement {
        run(...params: readonly unknown[]): unknown;
        get(...params: readonly unknown[]): unknown;
        all(...params: readonly unknown[]): readonly unknown[];
    }
    export interface Database {
        exec(sql: string): void;
        prepare(sql: string): Statement;
        close(): void;
    }
    export interface DatabaseConstructor {
        new (path: string): Database;
    }
    const Database: DatabaseConstructor;
    export default Database;
}
