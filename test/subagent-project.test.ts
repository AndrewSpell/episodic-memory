import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

// Mock the embedding backend so sync can index without loading a model
// (same pattern as test/sync-incremental-and-marker.test.ts).
vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => new Array(384).fill(0)),
  generateQueryEmbedding: vi.fn(),
  generateEmbedding: vi.fn(),
  initEmbeddingsFailed: false,
}));

import { syncConversations } from '../src/sync.js';
import { parseConversationFile } from '../src/parser.js';
import { projectFromTranscriptPath } from '../src/paths.js';
import { initDatabase, migrateSubagentProjects } from '../src/db.js';
import { suppressConsole } from './test-utils.js';

// Claude Code keeps subagent transcripts at <project>/<session>/subagents/agent-*.jsonl.
// Taking the parent directory as the project name filed all of them under "subagents".

function exchangeLines(sessionId: string): string {
  const ts = new Date(2026, 0, 1).toISOString();
  return JSON.stringify({
    type: 'user', uuid: `u-${sessionId}`, parentUuid: null, sessionId, isSidechain: true, timestamp: ts,
    message: { role: 'user', content: `question in ${sessionId}` },
  }) + '\n' + JSON.stringify({
    type: 'assistant', uuid: `a-${sessionId}`, parentUuid: `u-${sessionId}`, sessionId, isSidechain: true, timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text: `answer in ${sessionId}` }] },
  }) + '\n';
}

describe('projectFromTranscriptPath', () => {
  it('uses the parent directory for a top-level transcript', () => {
    expect(projectFromTranscriptPath(join('archive', 'project-a', 'session.jsonl'))).toBe('project-a');
  });

  it('skips <session>/subagents/ for a subagent transcript', () => {
    expect(projectFromTranscriptPath(join('archive', 'project-a', 'session-1', 'subagents', 'agent-1.jsonl'))).toBe('project-a');
  });

  it('keeps the name of a real project called "subagents"', () => {
    expect(projectFromTranscriptPath(join('archive', 'subagents', 'session.jsonl'))).toBe('subagents');
  });

  it('falls back to "unknown" for a bare filename', () => {
    expect(projectFromTranscriptPath('session.jsonl')).toBe('unknown');
  });
});

describe('subagent transcripts are filed under their project', () => {
  let testDir: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-subagent-project-'));
    process.env.TEST_DB_PATH = join(testDir, 'test.db');
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    delete process.env.TEST_DB_PATH;
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('parseConversationFile names the project, not "subagents"', async () => {
    const dir = join(testDir, 'project-a', 'session-1', 'subagents');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'agent-1.jsonl');
    writeFileSync(file, exchangeLines('agent-1'), 'utf-8');

    const result = await parseConversationFile(file);
    expect(result.project).toBe('project-a');
    expect(result.exchanges.every(e => e.project === 'project-a')).toBe(true);
  });

  it('sync indexes main and subagent transcripts under the same project', async () => {
    const sourceDir = join(testDir, 'source');
    const destDir = join(testDir, 'dest');
    mkdirSync(join(sourceDir, 'project-a', 'session-1', 'subagents'), { recursive: true });
    writeFileSync(join(sourceDir, 'project-a', 'session-1.jsonl'), exchangeLines('main'), 'utf-8');
    writeFileSync(join(sourceDir, 'project-a', 'session-1', 'subagents', 'agent-1.jsonl'), exchangeLines('agent-1'), 'utf-8');
    initDatabase().close();

    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(process.env.TEST_DB_PATH!);
    const projects = db.prepare('SELECT DISTINCT project FROM exchanges').all() as Array<{ project: string }>;
    const count = (db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n;
    db.close();
    expect(count).toBe(2);
    expect(projects.map(p => p.project)).toEqual(['project-a']);
  });

  it('migrateSubagentProjects repairs rows already indexed as "subagents"', () => {
    const db = initDatabase();
    const insert = db.prepare(`
      INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
      VALUES (?, ?, '2026-01-01', 'q', 'a', ?, 1, 2)
    `);
    const subagentPath = join('archive', 'project-a', 'session-1', 'subagents', 'agent-1.jsonl');
    // A real project that happens to be called "subagents" must be left alone.
    const realProjectPath = join('archive', 'subagents', 'session-2.jsonl');
    insert.run('bad', 'subagents', subagentPath);
    insert.run('real', 'subagents', realProjectPath);
    insert.run('main', 'project-a', join('archive', 'project-a', 'session-1.jsonl'));

    migrateSubagentProjects(db);
    migrateSubagentProjects(db); // idempotent

    const rows = db.prepare('SELECT id, project FROM exchanges ORDER BY id').all();
    db.close();
    expect(rows).toEqual([
      { id: 'bad', project: 'project-a' },
      { id: 'main', project: 'project-a' },
      { id: 'real', project: 'subagents' },
    ]);
  });
});
