/**
 * RawEventSummarizer: Background worker for Option C
 *
 * Part of "Raw First, Summarize Later" architecture:
 * - Polls raw_tool_events table on interval
 * - Sends batches to LLM for summarization
 * - Parses XML responses into observations
 * - Stores observations in database
 * - Marks raw events as completed
 *
 * This is decoupled from the streaming agent architecture
 * for simpler, more reliable batch processing.
 */

import { logger } from '../../utils/logger.js';
import { parseObservations } from '../../sdk/parser.js';
import { RawToolEventStore, type RawToolEvent } from '../sqlite/RawToolEventStore.js';
import type { DatabaseManager } from './DatabaseManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ModeManager } from '../domain/ModeManager.js';

// OpenRouter API endpoint
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Google AI endpoint
const GOOGLE_AI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface SummarizerStats {
  processed: number;
  failed: number;
  lastRunAt: number | null;
  lastCleanupAt: number | null;
}

interface LLMResponse {
  content: string;
  totalTokens: number;
}

export class RawEventSummarizer {
  private dbManager: DatabaseManager;
  private rawStore: RawToolEventStore;
  private interval: Timer | null = null;
  private isProcessing = false;
  private stats: SummarizerStats = { processed: 0, failed: 0, lastRunAt: null, lastCleanupAt: null };
  private batchCounter = 0;
  private readonly cleanupEveryNBatches = 100; // Cleanup every ~17 minutes (100 * 10s)
  private readonly completedRetentionMs = 60 * 60 * 1000; // 1 hour retention for completed events

  // Configuration
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(
    dbManager: DatabaseManager,
    rawStore: RawToolEventStore,
    options?: {
      intervalMs?: number;
      batchSize?: number;
      timeoutMs?: number;
    }
  ) {
    this.dbManager = dbManager;
    this.rawStore = rawStore;
    this.intervalMs = options?.intervalMs || 10000;  // 10 seconds
    this.batchSize = options?.batchSize || 10;
    this.timeoutMs = options?.timeoutMs || 60000;    // 60 seconds
  }

  /**
   * Start the background worker
   */
  start(): void {
    if (this.interval) {
      logger.warn('RAW_SUMMARIZER', 'Already running');
      return;
    }

    // Release any stuck events from previous runs
    const released = this.rawStore.releaseStuckEvents();
    if (released > 0) {
      logger.info('RAW_SUMMARIZER', `Released ${released} stuck events from previous run`);
    }

    this.interval = setInterval(() => this.processBatch(), this.intervalMs);
    logger.info('RAW_SUMMARIZER', `Started (interval=${this.intervalMs}ms, batch=${this.batchSize})`);
  }

  /**
   * Stop the background worker
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('RAW_SUMMARIZER', 'Stopped');
    }
  }

  /**
   * Process a batch of pending raw events
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      this.batchCounter++;

      // Periodic cleanup of completed events
      if (this.batchCounter % this.cleanupEveryNBatches === 0) {
        this.cleanupCompletedEvents();
      }

      const batch = this.rawStore.claimBatchForSummarization(this.batchSize);
      if (batch.length === 0) return;

      logger.debug('RAW_SUMMARIZER', `Processing batch of ${batch.length} events`);

      // Group by session for context coherence
      const bySession = this.groupBySession(batch);

      for (const [sessionDbId, events] of Object.entries(bySession)) {
        await this.summarizeSessionEvents(Number(sessionDbId), events);
      }

      this.stats.lastRunAt = Date.now();
    } catch (error) {
      logger.error('RAW_SUMMARIZER', 'Batch processing failed', {}, error as Error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Cleanup completed events older than retention period
   */
  private cleanupCompletedEvents(): void {
    try {
      const threshold = Date.now() - this.completedRetentionMs;
      const deleted = this.rawStore.deleteCompleted(threshold);
      if (deleted > 0) {
        logger.info('RAW_SUMMARIZER', `Cleaned up ${deleted} old completed events`);
      }
      this.stats.lastCleanupAt = Date.now();
    } catch (error) {
      logger.error('RAW_SUMMARIZER', 'Cleanup failed', {}, error as Error);
    }
  }

  /**
   * Summarize events for a single session
   */
  private async summarizeSessionEvents(sessionDbId: number, events: RawToolEvent[]): Promise<void> {
    try {
      // Get session info from database
      const sessionStore = this.dbManager.getSessionStore();
      const sessionRecord = sessionStore.getSessionById(sessionDbId);

      if (!sessionRecord) {
        throw new Error(`Session ${sessionDbId} not found`);
      }

      if (!sessionRecord.memory_session_id) {
        throw new Error(`Session ${sessionDbId} missing memory_session_id`);
      }

      // Build prompt from raw events
      const prompt = this.buildBatchPrompt(events, sessionRecord.project);

      // Call LLM and get token usage
      const { content: response, totalTokens: discoveryTokens } = await this.callLLM(prompt);

      // Parse observations from XML response
      const observations = parseObservations(response, events[0].content_session_id);

      if (observations.length === 0) {
        // LLM returned no observations - mark as completed anyway
        logger.debug('RAW_SUMMARIZER', `No observations parsed for session ${sessionDbId}`);
        for (const event of events) {
          this.rawStore.markCompleted(event.id, 0);
        }
        this.stats.processed += events.length;
        return;
      }

      // Store observations with discovery tokens
      const result = sessionStore.storeObservations(
        sessionRecord.memory_session_id,
        sessionRecord.project,
        observations,
        null, // no summary
        events[0].prompt_number || 1,
        discoveryTokens // Pass LLM token usage
      );

      // Mark events as completed
      for (let i = 0; i < events.length; i++) {
        const obsId = result.observationIds[Math.min(i, result.observationIds.length - 1)] || 0;
        this.rawStore.markCompleted(events[i].id, obsId);
      }

      this.stats.processed += events.length;

      logger.info('RAW_SUMMARIZER', `Summarized ${events.length} events → ${observations.length} observations`, {
        sessionDbId,
        project: sessionRecord.project
      });

    } catch (error) {
      logger.error('RAW_SUMMARIZER', `Failed to summarize session ${sessionDbId}`, {
        eventIds: events.map(e => e.id)
      }, error as Error);

      // Mark all events as failed
      for (const event of events) {
        this.rawStore.markFailed(event.id, (error as Error).message);
      }
      this.stats.failed += events.length;
    }
  }

  /**
   * Build a batch prompt from multiple raw events
   */
  private buildBatchPrompt(events: RawToolEvent[], project: string): string {
    const mode = ModeManager.getInstance().getActiveMode();

    // Build observation XML for each event
    const observationXml = events.map(event => {
      let toolInput: any = event.tool_input;
      let toolOutput: any = event.tool_response;

      try {
        if (event.tool_input) toolInput = JSON.parse(event.tool_input);
      } catch { /* use as-is */ }

      try {
        if (event.tool_response) toolOutput = JSON.parse(event.tool_response);
      } catch { /* use as-is */ }

      return `<observed_from_primary_session>
  <what_happened>${event.tool_name}</what_happened>
  <occurred_at>${new Date(event.created_at_epoch).toISOString()}</occurred_at>${event.cwd ? `\n  <working_directory>${event.cwd}</working_directory>` : ''}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>
</observed_from_primary_session>`;
    }).join('\n\n');

    // Build system prompt with mode config
    const systemPrompt = `${mode.prompts.system_identity}

${mode.prompts.observer_role}

${mode.prompts.recording_focus}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <title>Brief descriptive title</title>
  <subtitle>Additional context</subtitle>
  <facts>
    <fact>Specific fact 1</fact>
    <fact>Specific fact 2</fact>
  </facts>
  <narrative>Detailed explanation</narrative>
  <concepts>
    <concept>Technical concept</concept>
  </concepts>
  <files_read>
    <file>path/to/file</file>
  </files_read>
  <files_modified>
    <file>path/to/file</file>
  </files_modified>
</observation>
\`\`\`

Important: Output one or more <observation> blocks based on the tool activity below.
If multiple related tool uses can be combined into one observation, do so.
If they are distinct actions, create separate observations.

Project: ${project}

Tool Activity to Summarize:
${observationXml}`;

    return systemPrompt;
  }

  /**
   * Call LLM (OpenRouter or Gemini based on settings)
   * Returns content and total token usage for discovery_tokens tracking
   */
  private async callLLM(prompt: string): Promise<LLMResponse> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const provider = settings.CLAUDE_MEM_PROVIDER || 'openrouter';

    if (provider === 'openrouter') {
      return this.callOpenRouter(prompt, settings);
    } else if (provider === 'gemini') {
      return this.callGemini(prompt, settings);
    } else {
      // Default to OpenRouter for other providers
      return this.callOpenRouter(prompt, settings);
    }
  }

  /**
   * Call OpenRouter API
   * Returns content and token usage from response
   */
  private async callOpenRouter(prompt: string, settings: any): Promise<LLMResponse> {
    const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('CLAUDE_MEM_OPENROUTER_API_KEY not configured');
    }

    const model = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'openai/gpt-4o-mini';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/claude-mem',
          'X-Title': 'claude-mem-raw-summarizer'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4096
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';
      // OpenRouter returns usage.total_tokens (prompt + completion)
      const totalTokens = data.usage?.total_tokens || 0;

      return { content, totalTokens };

    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call Google AI (Gemini) API
   * Returns content and token usage from response
   */
  private async callGemini(prompt: string, settings: any): Promise<LLMResponse> {
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('CLAUDE_MEM_GEMINI_API_KEY not configured');
    }

    const model = settings.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.0-flash';
    const url = `${GOOGLE_AI_URL}/${model}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      // Gemini returns usageMetadata with promptTokenCount + candidatesTokenCount
      const usageMetadata = data.usageMetadata || {};
      const totalTokens = (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0);

      return { content, totalTokens };

    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Group events by session ID
   */
  private groupBySession(events: RawToolEvent[]): Record<string, RawToolEvent[]> {
    return events.reduce((acc, event) => {
      const key = String(event.session_db_id);
      (acc[key] = acc[key] || []).push(event);
      return acc;
    }, {} as Record<string, RawToolEvent[]>);
  }

  /**
   * Get statistics
   */
  getStats(): SummarizerStats & { pending: number; failed: number } {
    return {
      ...this.stats,
      pending: this.rawStore.getPendingCount(),
      failed: this.rawStore.getFailedCount()
    };
  }

  /**
   * Force process immediately (for testing)
   */
  async forceProcess(): Promise<void> {
    await this.processBatch();
  }
}
