import { Database } from './sqlite-compat.js';
import { logger } from '../../utils/logger.js';

/**
 * Raw summary request record from database
 */
export interface RawSummaryRequest {
  id: number;
  session_db_id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string;
  last_assistant_message: string | null;
  status: 'pending' | 'summarizing' | 'completed' | 'failed';
  retry_count: number;
  created_at_epoch: number;
  summarized_at_epoch: number | null;
  summary_id: number | null;
  error_message: string | null;
}

/**
 * Input for inserting raw summary request
 */
export interface RawSummaryRequestInput {
  memory_session_id?: string | null;
  project: string;
  user_prompt: string;
  last_assistant_message?: string;
}

/**
 * RawSummaryRequestStore - Persistent storage for session summary requests
 *
 * Part of Option C: Raw First, Summarize Later (for Session Summaries)
 *
 * This store captures summary requests immediately without spawning SDK process.
 * Background worker summarizes using direct LLM call with retry logic.
 *
 * Benefits:
 * - No process spawn = No orphan process risk
 * - Hook execution is instant (<5ms)
 * - Background summarization with retry
 * - Clear status tracking
 *
 * Lifecycle:
 * 1. insertRaw() - Summary request persisted immediately (status: 'pending')
 * 2. claimBatchForSummarization() - Worker claims batch (status: 'summarizing')
 * 3. markCompleted() - After successful summarization (status: 'completed')
 * 4. markFailed() - On failure, retry or mark failed permanently
 */
export class RawSummaryRequestStore {
  private db: Database;
  private maxRetries: number;

  constructor(db: Database, maxRetries: number = 3) {
    this.db = db;
    this.maxRetries = maxRetries;
    this.ensureTable();
  }

  /**
   * Ensure the raw_summary_requests table exists
   */
  private ensureTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS raw_summary_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT,
        project TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        last_assistant_message TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'summarizing', 'completed', 'failed')),
        retry_count INTEGER DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        summarized_at_epoch INTEGER,
        summary_id INTEGER,
        error_message TEXT,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for efficient querying
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_raw_summary_requests_status
      ON raw_summary_requests(status, created_at_epoch)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_raw_summary_requests_session
      ON raw_summary_requests(session_db_id)
    `);
  }

  /**
   * Insert raw summary request immediately (called by Stop hook)
   * MUST be fast (<5ms) - no LLM calls, no process spawn
   *
   * @returns The database ID of the persisted request
   */
  insertRaw(sessionDbId: number, contentSessionId: string, data: RawSummaryRequestInput): number {
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO raw_summary_requests (
        session_db_id, content_session_id, memory_session_id, project,
        user_prompt, last_assistant_message, status, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `);

    const result = stmt.run(
      sessionDbId,
      contentSessionId,
      data.memory_session_id || null,
      data.project,
      data.user_prompt,
      data.last_assistant_message || null,
      now
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Claim a batch of pending requests for summarization
   * Uses atomic transaction to prevent race conditions
   *
   * @returns Array of claimed requests (status changed to 'summarizing')
   */
  claimBatchForSummarization(limit: number): RawSummaryRequest[] {
    const claimTx = this.db.transaction((lim: number) => {
      // Get oldest pending requests
      const batch = this.db.prepare(`
        SELECT * FROM raw_summary_requests
        WHERE status = 'pending'
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `).all(lim) as RawSummaryRequest[];

      if (batch.length > 0) {
        const ids = batch.map(e => e.id).join(',');
        this.db.run(`UPDATE raw_summary_requests SET status = 'summarizing' WHERE id IN (${ids})`);
        logger.debug('RAW_SUMMARY', `Claimed ${batch.length} requests for summarization`);
      }

      return batch;
    });

    return claimTx(limit) as RawSummaryRequest[];
  }

  /**
   * Mark request as successfully summarized
   * Links to the created session summary for reference
   */
  markCompleted(id: number, summaryId: number): void {
    this.db.run(`
      UPDATE raw_summary_requests
      SET status = 'completed', summary_id = ?, summarized_at_epoch = ?
      WHERE id = ?
    `, [summaryId, Date.now(), id]);
  }

  /**
   * Mark request as failed with retry logic
   * If retry_count >= maxRetries, stays as 'failed'
   * Otherwise, returns to 'pending' for retry
   */
  markFailed(id: number, errorMessage: string): void {
    const request = this.db.prepare('SELECT retry_count FROM raw_summary_requests WHERE id = ?').get(id) as { retry_count: number } | undefined;
    const currentRetries = request?.retry_count || 0;
    const newRetryCount = currentRetries + 1;

    if (newRetryCount >= this.maxRetries) {
      // Permanently failed
      this.db.run(`
        UPDATE raw_summary_requests
        SET status = 'failed', retry_count = ?, error_message = ?
        WHERE id = ?
      `, [newRetryCount, errorMessage, id]);
      logger.warn('RAW_SUMMARY', `Request ${id} permanently failed after ${newRetryCount} retries: ${errorMessage}`);
    } else {
      // Back to pending for retry
      this.db.run(`
        UPDATE raw_summary_requests
        SET status = 'pending', retry_count = ?, error_message = ?
        WHERE id = ?
      `, [newRetryCount, errorMessage, id]);
      logger.debug('RAW_SUMMARY', `Request ${id} marked for retry (attempt ${newRetryCount}/${this.maxRetries})`);
    }
  }

  /**
   * Get count of pending requests (for status display)
   */
  getPendingCount(): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM raw_summary_requests
      WHERE status IN ('pending', 'summarizing')
    `).get() as { count: number };
    return result.count;
  }

  /**
   * Check if there's any pending work
   */
  hasAnyPendingWork(): boolean {
    return this.getPendingCount() > 0;
  }

  /**
   * Get status counts for monitoring
   */
  getStatusCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM raw_summary_requests GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    return rows.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {} as Record<string, number>);
  }

  /**
   * Release stuck summarizing requests (for recovery after crash)
   */
  releaseStuckRequests(): number {
    const result = this.db.run(`
      UPDATE raw_summary_requests
      SET status = 'pending'
      WHERE status = 'summarizing'
    `);

    if (result.changes > 0) {
      logger.info('RAW_SUMMARY', `Released ${result.changes} stuck summarizing requests`);
    }

    return result.changes;
  }

  /**
   * Get request by ID
   */
  getById(id: number): RawSummaryRequest | undefined {
    return this.db.prepare('SELECT * FROM raw_summary_requests WHERE id = ?').get(id) as RawSummaryRequest | undefined;
  }

  /**
   * Check if a session already has a pending/processing summary request
   * Prevents duplicate summary requests for the same session
   */
  hasPendingForSession(sessionDbId: number): boolean {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM raw_summary_requests
      WHERE session_db_id = ? AND status IN ('pending', 'summarizing')
    `).get(sessionDbId) as { count: number };
    return result.count > 0;
  }
}
