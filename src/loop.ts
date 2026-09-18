import { setTimeout as sleep } from 'node:timers/promises';
import { executePlay } from './act.js';
import { captureWindow } from './capture.js';
import { decideMove } from './decide.js';
import { Perceiver } from './perceive.js';
import type { TickResult, WindowInfo } from './types.js';
import { findTargetWindow } from './window.js';

export interface LoopOptions {
  windowQuery?: string;
  tickIntervalMs?: number;
  dryRun?: boolean;
  maxTicks?: number;
  autoStopOnPostGame?: boolean;
  localOnly?: boolean;
  /**
   * Write every frame to this directory instead of the rolling capture buffer,
   * with pruning disabled. Match footage is the scarce input for tuning
   * perception, so a recording session must never be overwritten by a later run.
   */
  recordDir?: string;
  onTick?: (result: TickResult) => void;
}

/**
 * How often the slower OCR pass runs. The things OCR reads (the match clock and
 * tower hit points) change slowly and are tracked between passes, so running it
 * on every frame would roughly double perception latency for no benefit.
 */
const OCR_EVERY_N_TICKS = 6;

export class GameLoop {
  private isRunning = false;
  private tickCount = 0;
  private readonly options: LoopOptions;
  private perceiver = new Perceiver();
  private previousFramePath?: string;

  constructor(options: LoopOptions = {}) {
    this.options = {
      windowQuery: 'iPhone Mirroring',
      // Clash Royale punishes slow reactions, so the loop runs far faster than
      // a "read the board and think" cadence would suggest.
      tickIntervalMs: Number(process.env.TICK_INTERVAL_MS) || 700,
      dryRun: false,
      autoStopOnPostGame: true,
      ...options,
    };
  }

  public stop(): void {
    console.log('\n[loop] stopping...');
    this.isRunning = false;
  }

  public async executeSingleTick(windowInfo: WindowInfo): Promise<TickResult> {
    this.tickCount++;
    const tickNumber = this.tickCount;
    const timestamp = Date.now();

    const captureStart = Date.now();
    const { filePath } = await captureWindow(
      windowInfo.id,
      this.options.recordDir ? { outputDir: this.options.recordDir, maxStoredFrames: 0 } : {}
    );
    const captureMs = Date.now() - captureStart;
    const priorFramePath = this.previousFramePath;
    this.previousFramePath = filePath;

    let gameState;
    const perceiveStart = Date.now();
    try {
      gameState = await this.perceiver.perceive(filePath, {
        previousImagePath: priorFramePath,
        runOcr: tickNumber === 1 || tickNumber % OCR_EVERY_N_TICKS === 0,
      });
    } catch (err) {
      return this.emit({
        tickNumber,
        timestamp,
        screenshotPath: filePath,
        gameState: {
          matchPhase: 'in-progress',
          elixir: 0,
          doubleElixir: false,
          cardsInHand: [],
          threats: [],
          ownUnits: [],
          towers: [],
        },
        error: `perception failed: ${(err as Error).message}`,
        timings: {
          captureMs,
          perceiveMs: Date.now() - perceiveStart,
          decideMs: 0,
          totalMs: Date.now() - timestamp,
        },
      });
    }
    const perceiveMs = Date.now() - perceiveStart;

    const timings = (decideMs: number) => ({
      captureMs,
      perceiveMs,
      decideMs,
      totalMs: Date.now() - timestamp,
    });

    if (gameState.matchPhase === 'post-game') {
      console.log('[loop] match over');
      return this.emit({
        tickNumber,
        timestamp,
        screenshotPath: filePath,
        gameState,
        skippedReason: 'post-game',
        timings: timings(0),
      });
    }

    if (gameState.matchPhase === 'menu' || gameState.matchPhase === 'pre-game') {
      // Quiet in the log, but still published: the dashboard needs to show that
      // we are alive and waiting rather than appearing frozen between matches.
      return this.emit({
        tickNumber,
        timestamp,
        screenshotPath: filePath,
        gameState,
        skippedReason: `waiting in ${gameState.matchPhase}`,
        timings: timings(0),
      });
    }

    console.log(`[tick ${tickNumber}] ${gameState.rawSummary}`);

    const decideStart = Date.now();
    const decision = await decideMove(gameState, { localOnly: this.options.localOnly });
    const decideMs = Date.now() - decideStart;

    let actionTaken: TickResult['actionTaken'];
    if (decision.shouldPlayNow && decision.action) {
      const coords = await executePlay(windowInfo.bounds, decision, { dryRun: this.options.dryRun });
      if (coords) {
        actionTaken = {
          cardSlot: decision.action.card.slot,
          cardName: decision.action.card.name,
          placement: decision.action.placement,
          screenCoords: coords,
        };
      }
      console.log(`[decide:${decision.source}] ${decision.explanation}`);
    } else {
      console.log(`[decide:${decision.source}] holding - ${decision.explanation}`);
    }

    return this.emit({
      tickNumber,
      timestamp,
      screenshotPath: filePath,
      gameState,
      decision,
      actionTaken,
      timings: timings(decideMs),
    });
  }

  /** Publishes a tick to any observer (the dashboard) and returns it. */
  private emit(result: TickResult): TickResult {
    this.options.onTick?.(result);
    return result;
  }

  public async run(): Promise<void> {
    this.isRunning = true;
    console.log('=====================================================');
    console.log('Jev Clash Royale agent');
    console.log(`  tick interval : ${this.options.tickIntervalMs}ms`);
    console.log(`  dry run       : ${this.options.dryRun ? 'yes' : 'no'}`);
    console.log(`  decisions     : ${this.options.localOnly ? 'local tactics only' : 'local tactics + Jev'}`);
    console.log('=====================================================');

    const sigHandler = () => this.stop();
    process.on('SIGINT', sigHandler);
    process.on('SIGTERM', sigHandler);

    while (this.isRunning) {
      if (this.options.maxTicks && this.tickCount >= this.options.maxTicks) {
        console.log(`[loop] reached ${this.options.maxTicks} ticks, exiting`);
        break;
      }

      const windowInfo = await findTargetWindow(this.options.windowQuery);
      if (!windowInfo) {
        console.warn(`[loop] "${this.options.windowQuery}" not found; is iPhone Mirroring open? retrying in 3s`);
        // Report this rather than going silent, so an observer shows "waiting
        // for the window" instead of looking like the agent has hung.
        this.emit({
          tickNumber: this.tickCount,
          timestamp: Date.now(),
          screenshotPath: '',
          gameState: {
            matchPhase: 'menu',
            elixir: 0,
            doubleElixir: false,
            cardsInHand: [],
            threats: [],
            ownUnits: [],
            towers: [],
          },
          skippedReason: `waiting for "${this.options.windowQuery}"`,
        });
        await sleep(3000);
        continue;
      }

      const startedAt = Date.now();
      try {
        const tickResult = await this.executeSingleTick(windowInfo);
        if (this.options.autoStopOnPostGame && tickResult.gameState.matchPhase === 'post-game') {
          break;
        }
      } catch (err) {
        console.error(`[loop] tick ${this.tickCount} failed: ${(err as Error).message}`);
        await sleep(1000);
        continue;
      }

      if (this.isRunning) {
        // Pace against how long the tick actually took, so a slow perception
        // pass does not stack on top of the interval and halve our reaction rate.
        const elapsed = Date.now() - startedAt;
        const remaining = (this.options.tickIntervalMs ?? 700) - elapsed;
        if (remaining > 0) await sleep(remaining);
      }
    }

    process.off('SIGINT', sigHandler);
    process.off('SIGTERM', sigHandler);
    console.log(`[loop] finished after ${this.tickCount} ticks`);
  }
}
