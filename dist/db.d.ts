import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export declare function migrateSchema(db: Database.Database): void;
/**
 * Earlier versions took a transcript's parent directory as its project, so
 * every subagent transcript (<project>/<session>/subagents/agent-*.jsonl) was
 * indexed under the project "subagents". Re-derive the project for those rows.
 * Rows from a real project named "subagents" derive to the same name and are
 * left as they are, so this is safe to run on every startup.
 */
export declare function migrateSubagentProjects(db: Database.Database): void;
/**
 * Earlier versions created `tool_calls` with a plain
 * `FOREIGN KEY (exchange_id) REFERENCES exchanges(id)`.
 * Without ON DELETE CASCADE, deleting an exchange that had tool calls
 * raised SQLITE_CONSTRAINT_FOREIGNKEY (#81), and orphans accumulated.
 *
 * This migration:
 *   1. Detects the legacy schema by inspecting sqlite_master.sql.
 *   2. Drops orphaned tool_calls rows.
 *   3. Recreates the table with ON DELETE CASCADE and copies surviving rows.
 */
export declare function migrateToolCallsCascade(db: Database.Database): void;
export declare function initDatabase(): Database.Database;
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], toolNames?: string[]): void;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
export declare function deleteExchange(db: Database.Database, id: string): void;
