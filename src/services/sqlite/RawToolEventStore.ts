import { Database } from './sqlite-compat.js';
import { logger } from '../../utils/logger.js';

/**
 * Raw tool event record from database
 */
export interface RawToolEvent {
  id: number;
  session_db_id: number;
  content_session_id: string;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  prompt_number: number | null;
  project: string | null;
  status: 'pending' | 'summarizing' | 'completed' | 'failed';
  retry_count: number;
  created_at_epoch: number;
  summarized_at_epoch: number | null;
  observation_id: number | null;
  error_message: string | null;
}

/**
 * Input for inserting raw tool events
 */
export interface RawToolEventInput {
  tool_name: string;
  tool_input?: any;
  tool_response?: any;
  cwd?: string;
  prompt_number?: number;
  project?: string;
}

/**
 * RawToolEventStore - Persistent storage for raw tool events
 *
 * Part of Pending Message Fix: Raw First, Summarize Later
 *
 * This store captures tool data immediately without LLM dependency.
 * Background worker summarizes events later with retry logic.
 *
 * Benefits:
 * - No data loss when LLM fails
 * - Hook execution is instant (<5ms)
 * - Background summarization with retry
 * - Clear status tracking
 *
 * Lifecycle:
 * 1. insertRaw() - Tool data persisted immediately (status: 'pending')
 * 2. claimBatchForSummarization() - Worker claims batch (status: 'summarizing')
 * 3. markCompleted() - After successful summarization (status: 'completed')
 * 4. markFailed() - On failure, retry or mark failed permanently
 * 5. deleteCompleted() - Cleanup old completed events
 */
export class RawToolEventStore {
  private db: Database;
  private maxRetries: number;
  private maxResponseLength: number;

  constructor(db: Database, maxRetries: number = 3, maxResponseLength: number = 50000) {
    this.db = db;
    this.maxRetries = maxRetries;
    this.maxResponseLength = maxResponseLength;
  }

  /**
   * Insert raw tool event immediately (called by hooks)
   * MUST be fast (<5ms) - no LLM calls
   *
   * @returns The database ID of the persisted event
   */
  insertRaw(sessionDbId: number, contentSessionId: string, data: RawToolEventInput): number {
    const now = Date.now();

    // Truncate large responses to prevent DB bloat
    let truncatedResponse: string | null = null;
    if (data.tool_response) {
      const responseStr = typeof data.tool_response === 'string'
        ? data.tool_response
        : JSON.stringify(data.tool_response);
      truncatedResponse = responseStr.length > this.maxResponseLength
        ? responseStr.slice(0, this.maxResponseLength) + '... [truncated]'
        : responseStr;
    }

    const stmt = this.db.prepare(`
      INSERT INTO raw_tool_events (
        session_db_id, content_session_id, tool_name, tool_input, tool_response,
        cwd, prompt_number, project, status, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);

    const result = stmt.run(
      sessionDbId,
      contentSessionId,
      data.tool_name,
      data.tool_input ? JSON.stringify(data.tool_input) : null,
      truncatedResponse,
      data.cwd || null,
      data.prompt_number || null,
      data.project || null,
      now
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Claim a batch of pending events for summarization
   * Uses atomic transaction to prevent race conditions
   *
   * @returns Array of claimed events (status changed to 'summarizing')
   */
  claimBatchForSummarization(limit: number): RawToolEvent[] {
    const claimTx = this.db.transaction((lim: number) => {
      // Get oldest pending events
      const batch = this.db.prepare(`
        SELECT * FROM raw_tool_events
        WHERE status = 'pending'
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `).all(lim) as RawToolEvent[];

      if (batch.length > 0) {
        const ids = batch.map(e => e.id).join(',');
        this.db.run(`UPDATE raw_tool_events SET status = 'summarizing' WHERE id IN (${ids})`);
        logger.debug('RAW_EVENTS', `Claimed ${batch.length} events for summarization`);
      }

      return batch;
    });

    return claimTx(limit) as RawToolEvent[];
  }

  /**
   * Mark event as successfully summarized
   * Links to the created observation for reference
   */
  markCompleted(id: number, observationId: number): void {
    this.db.run(`
      UPDATE raw_tool_events
      SET status = 'completed', observation_id = ?, summarized_at_epoch = ?
      WHERE id = ?
    `, [observationId, Date.now(), id]);
  }

  /**
   * Mark event as failed with retry logic
   * If retry_count >= maxRetries, stays as 'failed'
   * Otherwise, returns to 'pending' for retry
   */
  markFailed(id: number, errorMessage: string): void {
    const event = this.db.prepare('SELECT retry_count FROM raw_tool_events WHERE id = ?').get(id) as { retry_count: number } | undefined;
    const currentRetries = event?.retry_count || 0;
    const newRetryCount = currentRetries + 1;

    if (newRetryCount >= this.maxRetries) {
      // Permanently failed
      this.db.run(`
        UPDATE raw_tool_events
        SET status = 'failed', retry_count = ?, error_message = ?
        WHERE id = ?
      `, [newRetryCount, errorMessage, id]);
      logger.warn('RAW_EVENTS', `Event ${id} permanently failed after ${newRetryCount} retries: ${errorMessage}`);
    } else {
      // Back to pending for retry
      this.db.run(`
        UPDATE raw_tool_events
        SET status = 'pending', retry_count = ?, error_message = ?
        WHERE id = ?
      `, [newRetryCount, errorMessage, id]);
      logger.debug('RAW_EVENTS', `Event ${id} marked for retry (attempt ${newRetryCount}/${this.maxRetries})`);
    }
  }

  /**
   * Release claimed events back to pending (e.g., on worker crash recovery)
   */
  releaseStuckEvents(olderThanMs: number = 300000): number {
    const threshold = Date.now() - olderThanMs;
    const result = this.db.run(`
      UPDATE raw_tool_events
      SET status = 'pending'
      WHERE status = 'summarizing' AND created_at_epoch < ?
    `, [threshold]);
    return result.changes;
  }

  /**
   * Get count of pending events
   */
  getPendingCount(): number {
    const result = this.db.prepare(
      'SELECT COUNT(*) as count FROM raw_tool_events WHERE status = ?'
    ).get('pending') as { count: number };
    return result.count;
  }

  /**
   * Get count of failed events
   */
  getFailedCount(): number {
    const result = this.db.prepare(
      'SELECT COUNT(*) as count FROM raw_tool_events WHERE status = ?'
    ).get('failed') as { count: number };
    return result.count;
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): { pending: number; summarizing: number; completed: number; failed: number } {
    const stats = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM raw_tool_events
      GROUP BY status
    `).all() as { status: string; count: number }[];

    const result = { pending: 0, summarizing: 0, completed: 0, failed: 0 };
    for (const row of stats) {
      if (row.status in result) {
        result[row.status as keyof typeof result] = row.count;
      }
    }
    return result;
  }

  /**
   * Delete completed events older than the specified epoch
   * Call periodically to prevent table bloat
   */
  deleteCompleted(olderThanEpoch: number): number {
    const result = this.db.run(`
      DELETE FROM raw_tool_events
      WHERE status = 'completed' AND summarized_at_epoch < ?
    `, [olderThanEpoch]);
    return result.changes;
  }

  /**
   * Get events by session for debugging
   */
  getBySession(sessionDbId: number): RawToolEvent[] {
    return this.db.prepare(`
      SELECT * FROM raw_tool_events
      WHERE session_db_id = ?
      ORDER BY created_at_epoch ASC
    `).all(sessionDbId) as RawToolEvent[];
  }

  /**
   * Get a single event by ID
   */
  getById(id: number): RawToolEvent | null {
    return this.db.prepare('SELECT * FROM raw_tool_events WHERE id = ?').get(id) as RawToolEvent | null;
  }
}
