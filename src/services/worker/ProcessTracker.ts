/**
 * ProcessTracker: Track and manage spawned Claude CLI processes
 *
 * Provides:
 * - Custom spawnClaudeCodeProcess wrapper to capture SpawnedProcess
 * - Graceful shutdown with timeout (SIGTERM)
 * - Force kill fallback (SIGKILL)
 * - Process verification
 *
 * This solves the orphan process problem where Claude CLI subprocesses
 * spawned by the SDK are not properly terminated when sessions end.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../utils/logger.js';

// SDK types - we define them here to avoid import issues
export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface SpawnedProcess {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  exitCode: number | null;
  killed: boolean;
  pid?: number;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
}

export interface TrackedProcess {
  process: SpawnedProcess;
  pid: number;
  sessionDbId: number;
  spawnedAt: number;
  command: string;
}

export class ProcessTracker {
  private static instance: ProcessTracker;
  private trackedProcesses: Map<number, TrackedProcess> = new Map();

  private constructor() {
    // Singleton
  }

  static getInstance(): ProcessTracker {
    if (!ProcessTracker.instance) {
      ProcessTracker.instance = new ProcessTracker();
    }
    return ProcessTracker.instance;
  }

  /**
   * Create spawn function that tracks the process
   * This is passed to SDK's spawnClaudeCodeProcess option
   */
  createTrackedSpawnFunction(sessionDbId: number): (options: SpawnOptions) => SpawnedProcess {
    return (options: SpawnOptions): SpawnedProcess => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true
      }) as ChildProcess;

      const pid = child.pid;
      if (pid) {
        const tracked: TrackedProcess = {
          process: child as unknown as SpawnedProcess,
          pid,
          sessionDbId,
          spawnedAt: Date.now(),
          command: options.command
        };
        this.trackedProcesses.set(sessionDbId, tracked);

        logger.info('PROCESS', `Spawned Claude CLI`, {
          sessionId: sessionDbId,
          pid,
          command: options.command
        });

        // Auto-cleanup on exit
        child.on('exit', (code, signal) => {
          this.trackedProcesses.delete(sessionDbId);
          logger.info('PROCESS', `Claude CLI exited`, {
            sessionId: sessionDbId,
            pid,
            code,
            signal
          });
        });

        // Log errors
        child.on('error', (err) => {
          logger.error('PROCESS', `Claude CLI error`, {
            sessionId: sessionDbId,
            pid
          }, err);
        });
      } else {
        logger.warn('PROCESS', `Failed to get PID for spawned process`, {
          sessionId: sessionDbId
        });
      }

      return child as unknown as SpawnedProcess;
    };
  }

  /**
   * Get tracked process for a session
   */
  getProcess(sessionDbId: number): TrackedProcess | undefined {
    return this.trackedProcesses.get(sessionDbId);
  }

  /**
   * Check if a session has a tracked process
   */
  hasProcess(sessionDbId: number): boolean {
    return this.trackedProcesses.has(sessionDbId);
  }

  /**
   * Graceful shutdown with timeout, then force kill
   * @param sessionDbId - Session ID to terminate
   * @param gracefulTimeoutMs - Time to wait for graceful exit (default 5000ms)
   * @returns true if process was terminated or already dead
   */
  async terminateProcess(sessionDbId: number, gracefulTimeoutMs: number = 5000): Promise<boolean> {
    const tracked = this.trackedProcesses.get(sessionDbId);
    if (!tracked) {
      logger.debug('PROCESS', `No tracked process for session`, { sessionId: sessionDbId });
      return true;
    }

    const { process: proc, pid } = tracked;

    // Check if already exited
    if (proc.killed || proc.exitCode !== null) {
      this.trackedProcesses.delete(sessionDbId);
      logger.debug('PROCESS', `Process already exited`, { sessionId: sessionDbId, pid });
      return true;
    }

    logger.info('PROCESS', `Terminating process`, { sessionId: sessionDbId, pid });

    // Try graceful shutdown first (SIGTERM)
    try {
      proc.kill('SIGTERM');

      // Wait for graceful exit
      const exited = await this.waitForExit(proc, gracefulTimeoutMs);
      if (exited) {
        this.trackedProcesses.delete(sessionDbId);
        logger.info('PROCESS', `Process terminated gracefully`, { sessionId: sessionDbId, pid });
        return true;
      }
    } catch (error) {
      logger.debug('PROCESS', `SIGTERM failed`, { sessionId: sessionDbId, pid }, error as Error);
    }

    // Force kill (SIGKILL)
    logger.warn('PROCESS', `Force killing process after timeout`, { sessionId: sessionDbId, pid });
    try {
      proc.kill('SIGKILL');
      await this.waitForExit(proc, 2000);
    } catch (error) {
      // Process might already be dead
      logger.debug('PROCESS', `SIGKILL failed, process may already be dead`, { pid }, error as Error);
    }

    this.trackedProcesses.delete(sessionDbId);

    // Verify process is actually dead
    const isDead = this.verifyProcessDead(pid);
    if (!isDead) {
      logger.error('PROCESS', `Failed to kill process`, { sessionId: sessionDbId, pid });
    }
    return isDead;
  }

  /**
   * Wait for process to exit
   */
  private waitForExit(proc: SpawnedProcess, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);

      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });

      // Also check if already exited
      if (proc.exitCode !== null || proc.killed) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  }

  /**
   * Verify process is dead using OS-level check
   */
  private verifyProcessDead(pid: number): boolean {
    try {
      process.kill(pid, 0); // Signal 0 = check if process exists
      return false; // Process still alive
    } catch {
      return true; // Process dead (ESRCH)
    }
  }

  /**
   * Get all tracked processes (for monitoring/cleanup)
   */
  getAllTracked(): TrackedProcess[] {
    return Array.from(this.trackedProcesses.values());
  }

  /**
   * Get count of tracked processes
   */
  getTrackedCount(): number {
    return this.trackedProcesses.size;
  }

  /**
   * Force kill all tracked processes (for shutdown)
   */
  async terminateAll(): Promise<{ terminated: number; failed: number }> {
    const sessionIds = Array.from(this.trackedProcesses.keys());
    let terminated = 0;
    let failed = 0;

    logger.info('PROCESS', `Terminating all tracked processes`, { count: sessionIds.length });

    for (const sessionId of sessionIds) {
      const success = await this.terminateProcess(sessionId, 2000);
      if (success) {
        terminated++;
      } else {
        failed++;
      }
    }

    logger.info('PROCESS', `Terminated all processes`, { terminated, failed });
    return { terminated, failed };
  }

  /**
   * Get process info for monitoring endpoint
   */
  getProcessInfo(): Array<{
    sessionDbId: number;
    pid: number;
    spawnedAt: number;
    ageMs: number;
    command: string;
  }> {
    const now = Date.now();
    return this.getAllTracked().map(t => ({
      sessionDbId: t.sessionDbId,
      pid: t.pid,
      spawnedAt: t.spawnedAt,
      ageMs: now - t.spawnedAt,
      command: t.command
    }));
  }
}
