/**
 * OrphanProcessScanner: Periodic cleanup of orphaned Claude CLI processes
 *
 * Scans for Claude CLI processes that:
 * - Match the SDK agent pattern (claude.*disallowedTools)
 * - Are not tracked by ProcessTracker
 * - Have been running longer than a threshold
 *
 * This is a safety net for processes that escape normal cleanup,
 * such as when the worker crashes or restarts unexpectedly.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { ProcessTracker } from './ProcessTracker.js';

const execAsync = promisify(exec);

export interface OrphanScanResult {
  foundCount: number;
  killedCount: number;
  failedCount: number;
  pids: number[];
}

export interface OrphanProcessInfo {
  pid: number;
  ageSeconds: number;
  command: string;
}

export class OrphanProcessScanner {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly maxAgeMs: number;
  private scanCount: number = 0;
  private totalKilled: number = 0;

  constructor(options: {
    maxAgeMs?: number;
  } = {}) {
    // Default: 30 minutes - processes older than this are considered orphans
    this.maxAgeMs = options.maxAgeMs || 30 * 60 * 1000;
  }

  /**
   * Start periodic scanning
   * @param intervalMs - How often to scan (default: 5 minutes)
   */
  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.intervalId) {
      logger.warn('ORPHAN_SCANNER', 'Already running');
      return;
    }

    logger.info('ORPHAN_SCANNER', `Started`, {
      intervalMs,
      maxAgeMs: this.maxAgeMs,
      maxAgeMinutes: Math.round(this.maxAgeMs / 60000)
    });

    // Run immediately, then periodically
    this.scan().catch(err =>
      logger.error('ORPHAN_SCANNER', 'Initial scan failed', {}, err as Error)
    );

    this.intervalId = setInterval(async () => {
      try {
        await this.scan();
      } catch (err) {
        logger.error('ORPHAN_SCANNER', 'Periodic scan failed', {}, err as Error);
      }
    }, intervalMs);
  }

  /**
   * Stop periodic scanning
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('ORPHAN_SCANNER', 'Stopped', {
        totalScans: this.scanCount,
        totalKilled: this.totalKilled
      });
    }
  }

  /**
   * Scan for and kill orphaned processes
   */
  async scan(): Promise<OrphanScanResult> {
    this.scanCount++;
    const result: OrphanScanResult = {
      foundCount: 0,
      killedCount: 0,
      failedCount: 0,
      pids: []
    };

    try {
      const orphans = await this.findOrphanedClaudeProcesses();
      result.foundCount = orphans.length;
      result.pids = orphans.map(o => o.pid);

      if (orphans.length === 0) {
        logger.info('ORPHAN_SCANNER', 'Scan complete - no orphans found', { scanNumber: this.scanCount });
        return result;
      }

      logger.warn('ORPHAN_SCANNER', `Found orphaned processes`, {
        count: orphans.length,
        pids: result.pids,
        ages: orphans.map(o => `${o.pid}:${Math.round(o.ageSeconds / 60)}m`)
      });

      // Kill each orphan
      for (const orphan of orphans) {
        const killed = await this.killOrphan(orphan.pid);
        if (killed) {
          result.killedCount++;
          this.totalKilled++;
        } else {
          result.failedCount++;
        }
      }

      logger.info('ORPHAN_SCANNER', `Cleanup complete`, {
        found: result.foundCount,
        killed: result.killedCount,
        failed: result.failedCount,
        scanNumber: this.scanCount
      });

    } catch (err) {
      logger.error('ORPHAN_SCANNER', 'Scan failed', {}, err as Error);
    }

    return result;
  }

  /**
   * Find Claude CLI processes that are orphaned (SDK agent processes)
   * Pattern: claude.*disallowedTools (SDK agent signature)
   */
  private async findOrphanedClaudeProcesses(): Promise<OrphanProcessInfo[]> {
    const orphans: OrphanProcessInfo[] = [];
    const trackedPids = new Set(
      ProcessTracker.getInstance().getAllTracked().map(t => t.pid)
    );

    try {
      if (process.platform === 'win32') {
        return await this.findOrphansWindows(trackedPids);
      } else {
        return await this.findOrphansUnix(trackedPids);
      }
    } catch (err) {
      logger.error('ORPHAN_SCANNER', 'Failed to enumerate processes', {}, err as Error);
    }

    return orphans;
  }

  /**
   * Find orphans on Unix/macOS
   */
  private async findOrphansUnix(trackedPids: Set<number>): Promise<OrphanProcessInfo[]> {
    const orphans: OrphanProcessInfo[] = [];

    try {
      // Find Claude CLI processes with SDK agent signature
      // Pattern: claude.*disallowedTools (this is unique to SDK-spawned agents)
      const { stdout } = await execAsync(
        'ps -eo pid,etime,command | grep -E "[c]laude.*disallowedTools" || true',
        { timeout: 30000 }
      );

      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;

        const pid = parseInt(parts[0], 10);
        const etime = parts[1];
        const command = parts.slice(2).join(' ');

        if (isNaN(pid) || pid <= 0) continue;

        // Skip if tracked by ProcessTracker
        if (trackedPids.has(pid)) {
          logger.debug('ORPHAN_SCANNER', `Skipping tracked process`, { pid });
          continue;
        }

        // Parse elapsed time
        const ageSeconds = this.parseElapsedTime(etime);
        const ageMs = ageSeconds * 1000;

        // Skip if too young
        if (ageMs < this.maxAgeMs) {
          logger.debug('ORPHAN_SCANNER', `Skipping young process`, {
            pid,
            ageMinutes: Math.round(ageSeconds / 60)
          });
          continue;
        }

        orphans.push({ pid, ageSeconds, command });
      }
    } catch (err) {
      // grep returns exit code 1 if no matches, which is fine
      if ((err as any).code !== 1) {
        throw err;
      }
    }

    return orphans;
  }

  /**
   * Find orphans on Windows
   */
  private async findOrphansWindows(trackedPids: Set<number>): Promise<OrphanProcessInfo[]> {
    const orphans: OrphanProcessInfo[] = [];

    try {
      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*claude*disallowedTools*' } | Select-Object ProcessId, CreationDate, CommandLine | ConvertTo-Json"`;
      const { stdout } = await execAsync(cmd, { timeout: 30000 });

      if (!stdout.trim()) return orphans;

      const processes = JSON.parse(stdout);
      const processList = Array.isArray(processes) ? processes : [processes];

      for (const proc of processList) {
        const pid = proc.ProcessId;
        if (trackedPids.has(pid)) continue;

        const creationDate = new Date(proc.CreationDate);
        const ageMs = Date.now() - creationDate.getTime();
        const ageSeconds = Math.round(ageMs / 1000);

        if (ageMs < this.maxAgeMs) continue;

        orphans.push({
          pid,
          ageSeconds,
          command: proc.CommandLine || ''
        });
      }
    } catch (err) {
      throw err;
    }

    return orphans;
  }

  /**
   * Kill an orphaned process
   */
  private async killOrphan(pid: number): Promise<boolean> {
    try {
      logger.info('ORPHAN_SCANNER', `Killing orphan`, { pid });

      if (process.platform === 'win32') {
        await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: 10000 });
      } else {
        // Try SIGTERM first
        try {
          process.kill(pid, 'SIGTERM');
          await this.sleep(2000);

          // Check if still alive
          try {
            process.kill(pid, 0);
            // Still alive, use SIGKILL
            process.kill(pid, 'SIGKILL');
            await this.sleep(1000);
          } catch {
            // Process dead after SIGTERM
            return true;
          }
        } catch {
          // SIGTERM failed, process may already be dead
        }
      }

      // Verify death
      await this.sleep(500);
      try {
        process.kill(pid, 0);
        logger.warn('ORPHAN_SCANNER', `Failed to kill orphan`, { pid });
        return false; // Still alive
      } catch {
        logger.info('ORPHAN_SCANNER', `Orphan killed`, { pid });
        return true; // Dead
      }
    } catch (err) {
      // Process might already be dead
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }
  }

  /**
   * Parse ps elapsed time format to seconds
   * Format: [[DD-]hh:]mm:ss
   */
  private parseElapsedTime(etime: string): number {
    let totalSeconds = 0;

    // Check for days (format: DD-hh:mm:ss)
    if (etime.includes('-')) {
      const [days, rest] = etime.split('-');
      totalSeconds += parseInt(days, 10) * 86400;
      etime = rest;
    }

    const parts = etime.split(':').reverse();
    if (parts.length >= 1) totalSeconds += parseInt(parts[0], 10) || 0;
    if (parts.length >= 2) totalSeconds += (parseInt(parts[1], 10) || 0) * 60;
    if (parts.length >= 3) totalSeconds += (parseInt(parts[2], 10) || 0) * 3600;

    return totalSeconds;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get scanner statistics
   */
  getStats(): { scanCount: number; totalKilled: number; isRunning: boolean } {
    return {
      scanCount: this.scanCount,
      totalKilled: this.totalKilled,
      isRunning: this.intervalId !== null
    };
  }

  /**
   * Force immediate scan (for testing/debugging)
   */
  async forceScan(): Promise<OrphanScanResult> {
    return this.scan();
  }
}
