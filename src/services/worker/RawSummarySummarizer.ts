/**
 * RawSummarySummarizer: Background worker for Option C Session Summaries
 *
 * Part of "Raw First, Summarize Later" architecture for session summaries:
 * - Polls raw_summary_requests table on interval
 * - Calls LLM to generate session summary
 * - Parses XML response into session summary fields
 * - Stores summary in session_summaries table
 * - Marks raw request as completed
 *
 * Key benefit: No SDK process spawn = No orphan process risk
 */

import { logger } from '../../utils/logger.js';
import { parseSummary } from '../../sdk/parser.js';
import { RawSummaryRequestStore, type RawSummaryRequest } from '../sqlite/RawSummaryRequestStore.js';
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
}

interface LLMResponse {
  content: string;
  totalTokens: number;
}

export class RawSummarySummarizer {
  private dbManager: DatabaseManager;
  private rawStore: RawSummaryRequestStore;
  private interval: Timer | null = null;
  private isProcessing = false;
  private stats: SummarizerStats = { processed: 0, failed: 0, lastRunAt: null };
  private batchCounter = 0;
  private readonly staleCheckEveryNBatches = 30; // Check stuck requests every ~5 minutes

  // Configuration
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(
    dbManager: DatabaseManager,
    rawStore: RawSummaryRequestStore,
    options?: {
      intervalMs?: number;
      batchSize?: number;
      timeoutMs?: number;
    }
  ) {
    this.dbManager = dbManager;
    this.rawStore = rawStore;
    this.intervalMs = options?.intervalMs || 10000;  // 10 seconds
    this.batchSize = options?.batchSize || 5;        // Smaller batch for summaries
    this.timeoutMs = options?.timeoutMs || 60000;    // 60 seconds
  }

  /**
   * Start the background worker
   */
  start(): void {
    if (this.interval) {
      logger.warn('RAW_SUMMARY_SUMMARIZER', 'Already running');
      return;
    }

    // Release any stuck requests from previous runs
    const released = this.rawStore.releaseStuckRequests();
    if (released > 0) {
      logger.info('RAW_SUMMARY_SUMMARIZER', `Released ${released} stuck requests from previous run`);
    }

    this.interval = setInterval(() => this.processBatch(), this.intervalMs);
    logger.info('RAW_SUMMARY_SUMMARIZER', `Started (interval=${this.intervalMs}ms, batch=${this.batchSize})`);
  }

  /**
   * Stop the background worker
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('RAW_SUMMARY_SUMMARIZER', 'Stopped');
    }
  }

  /**
   * Process a batch of pending summary requests
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      this.batchCounter++;

      // Periodic release of stuck requests
      if (this.batchCounter % this.staleCheckEveryNBatches === 0) {
        this.rawStore.releaseStuckRequests();
      }

      const batch = this.rawStore.claimBatchForSummarization(this.batchSize);
      if (batch.length === 0) return;

      logger.debug('RAW_SUMMARY_SUMMARIZER', `Processing batch of ${batch.length} requests`);

      // Process each request individually (summaries are session-specific)
      for (const request of batch) {
        await this.summarizeRequest(request);
      }

      this.stats.lastRunAt = Date.now();
    } catch (error) {
      logger.error('RAW_SUMMARY_SUMMARIZER', 'Batch processing failed', {}, error as Error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Summarize a single request
   */
  private async summarizeRequest(request: RawSummaryRequest): Promise<void> {
    try {
      // Build prompt
      const prompt = this.buildSummaryPrompt(request);

      // Call LLM
      const { content: response, totalTokens: discoveryTokens } = await this.callLLM(prompt);

      // Parse summary from XML response
      const summary = parseSummary(response, request.session_db_id);

      if (!summary) {
        throw new Error('Failed to parse summary from LLM response');
      }

      // Store summary in database
      const sessionStore = this.dbManager.getSessionStore();

      // ALWAYS fetch memory_session_id from database (request value may be stale pre-generated UUID)
      const sessionRecord = sessionStore.getSessionById(request.session_db_id);
      const memorySessionId = sessionRecord?.memory_session_id;

      if (!memorySessionId) {
        throw new Error(`No memory_session_id for session ${request.session_db_id}`);
      }

      // Store using storeObservations with summary only
      const result = sessionStore.storeObservations(
        memorySessionId,
        request.project,
        [], // no observations
        summary,
        1, // prompt_number
        discoveryTokens
      );

      const summaryId = result.summaryId || 0;

      // Mark request as completed
      this.rawStore.markCompleted(request.id, summaryId);
      this.stats.processed++;

      logger.info('RAW_SUMMARY_SUMMARIZER', `Created session summary`, {
        sessionDbId: request.session_db_id,
        summaryId,
        project: request.project
      });

    } catch (error) {
      logger.error('RAW_SUMMARY_SUMMARIZER', `Failed to summarize request ${request.id}`, {
        sessionDbId: request.session_db_id
      }, error as Error);

      this.rawStore.markFailed(request.id, (error as Error).message);
      this.stats.failed++;
    }
  }

  /**
   * Build prompt for session summary
   */
  private buildSummaryPrompt(request: RawSummaryRequest): string {
    const mode = ModeManager.getInstance().getActiveMode();
    const lastAssistantMessage = request.last_assistant_message || '';

    // Get recent observations for this project to provide context
    const sessionStore = this.dbManager.getSessionStore();
    let contextInfo = '';

    try {
      const observations = sessionStore.getRecentObservations(request.project, 10);
      if (observations.length > 0) {
        contextInfo = `\n\nRecent activity from this project:\n${observations.map(o =>
          `- [${o.type}] ${o.text?.substring(0, 200) || ''}`
        ).join('\n')}`;
      }
    } catch {
      // Ignore errors fetching observations
    }

    return `${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

User's original request: ${request.user_prompt}

${mode.prompts.summary_context_label}
${lastAssistantMessage}${contextInfo}

${mode.prompts.summary_format_instruction}
<summary>
  <request>${mode.prompts.xml_summary_request_placeholder}</request>
  <investigated>${mode.prompts.xml_summary_investigated_placeholder}</investigated>
  <learned>${mode.prompts.xml_summary_learned_placeholder}</learned>
  <completed>${mode.prompts.xml_summary_completed_placeholder}</completed>
  <next_steps>${mode.prompts.xml_summary_next_steps_placeholder}</next_steps>
  <notes>${mode.prompts.xml_summary_notes_placeholder}</notes>
</summary>

${mode.prompts.summary_footer}`;
  }

  /**
   * Call LLM (OpenRouter or Gemini based on settings)
   */
  private async callLLM(prompt: string): Promise<LLMResponse> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const provider = settings.CLAUDE_MEM_PROVIDER || 'openrouter';

    if (provider === 'openrouter') {
      return this.callOpenRouter(prompt, settings);
    } else if (provider === 'gemini') {
      return this.callGemini(prompt, settings);
    } else {
      return this.callOpenRouter(prompt, settings);
    }
  }

  /**
   * Call OpenRouter API
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
          'X-Title': 'claude-mem-summary-summarizer'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2048
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';
      const totalTokens = data.usage?.total_tokens || 0;

      return { content, totalTokens };

    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call Google AI (Gemini) API
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
            maxOutputTokens: 2048
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
      const usageMetadata = data.usageMetadata || {};
      const totalTokens = (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0);

      return { content, totalTokens };

    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get statistics
   */
  getStats(): SummarizerStats & { pending: number } {
    return {
      ...this.stats,
      pending: this.rawStore.getPendingCount()
    };
  }

  /**
   * Force process immediately (for testing)
   */
  async forceProcess(): Promise<void> {
    await this.processBatch();
  }
}
