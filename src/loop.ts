import { setTimeout as sleep } from 'node:timers/promises';
import { executePlay } from './act.js';
import { captureWindow } from './capture.js';
import { decideMove } from './decide.js';
import { perceiveGameState } from './perceive.js';
import type { GameState, TickResult, WindowInfo } from './types.js';
import { findTargetWindow } from './window.js';

export interface LoopOptions {
  windowQuery?: string;
  tickIntervalMs?: number;
  dryRun?: boolean;
  maxTicks?: number;
  autoStopOnPostGame?: boolean;
  onTick?: (result: TickResult) => void;
}

export class GameLoop {
  private isRunning = false;
  private tickCount = 0;
  private readonly options: LoopOptions;

  constructor(options: LoopOptions = {}) {
    this.options = {
      windowQuery: 'iPhone Mirroring',
      tickIntervalMs: Number(process.env.TICK_INTERVAL_MS) || 2000,
      dryRun: false,
      autoStopOnPostGame: true,
      ...options,
    };
  }

  public stop(): void {
    console.log('\n[loop] Stopping game loop...');
    this.isRunning = false;
  }

  /**
   * Executes a single game tick.
   */
  public async executeSingleTick(windowInfo: WindowInfo): Promise<TickResult> {
    this.tickCount++;
    const tickNumber = this.tickCount;
    const timestamp = Date.now();

    console.log(`\n--- [Tick #${tickNumber}] ---`);

    // 1. Capture window screenshot
    const { filePath, base64 } = await captureWindow(windowInfo.id);
    console.log(`[capture] Captured window frame: ${filePath}`);

    // 2. Perceive board state
    console.log('[perceive] Analyzing frame with vision model...');
    let gameState: GameState;
    try {
      gameState = await perceiveGameState(base64);
      console.log(
        `[perceive] Phase: ${gameState.matchPhase.toUpperCase()} | Elixir: ${gameState.elixir.toFixed(1)} | Hand: [${gameState.cardsInHand.map((c) => c.name).join(', ')}]`
      );
      if (gameState.opponentTroops.length > 0) {
        console.log(
          `[perceive] Opponent threats: ${gameState.opponentTroops.map((t) => `${t.type} (${t.lane})`).join(', ')}`
        );
      }
    } catch (err) {
      console.error(`[perceive] Error perceiving game state: ${(err as Error).message}`);
      return {
        tickNumber,
        timestamp,
        screenshotPath: filePath,
        gameState: {
          matchPhase: 'in-progress',
          elixir: 5,
          cardsInHand: [],
          opponentTroops: [],
          ownTroops: [],
          ownTowers: {},
          opponentTowers: {},
        },
        error: `Perception failed: ${(err as Error).message}`,
      };
    }

    // Check if match is post-game or not in progress
    if (this.options.autoStopOnPostGame && gameState.matchPhase === 'post-game') {
      console.log('[perceive] Match has concluded (post-game detected)!');
      return {
        tickNumber,
        timestamp,
        screenshotPath: filePath,
        gameState,
        skippedReason: 'Match finished (post-game phase)',
      };
    }

    if (gameState.matchPhase === 'menu' || gameState.matchPhase === 'pre-game') {
      console.log(`[loop] Waiting for battle to start (current phase: ${gameState.matchPhase})...`);
      return {
        tickNumber,
        timestamp,
        screenshotPath: filePath,
        gameState,
        skippedReason: `Waiting in ${gameState.matchPhase}`,
      };
    }

    // 3. Decide move with TypeSafe Jev
    console.log('[decide] Consulting TypeSafe Jev model...');
    const decision = await decideMove(gameState);
    console.log(`[decide] ${decision.explanation || 'Decision received.'}`);

    // 4. Act (simulate clicks)
    let actionTaken;
    if (decision.shouldPlayNow && decision.whichCard !== 'none') {
      const coords = await executePlay(windowInfo.bounds, decision, {
        dryRun: this.options.dryRun,
      });

      if (coords) {
        const slotMatch = decision.whichCard.match(/\d+/);
        const slotNum = slotMatch ? parseInt(slotMatch[0], 10) : 1;
        const cardObj = gameState.cardsInHand.find((c) => c.slot === slotNum);

        actionTaken = {
          cardSlot: slotNum,
          cardName: cardObj?.name || decision.whichCard,
          placement: decision.whichLane,
          screenCoords: coords,
        };
      }
    } else {
      console.log('[act] Holding elixir, no card played this tick.');
    }

    const result: TickResult = {
      tickNumber,
      timestamp,
      screenshotPath: filePath,
      gameState,
      decision,
      actionTaken,
    };

    if (this.options.onTick) {
      this.options.onTick(result);
    }

    return result;
  }

  /**
   * Main game loop runner.
   */
  public async run(): Promise<void> {
    this.isRunning = true;
    console.log('=====================================================');
    console.log('🚀 Jev Clash Royale Autonomous Agent Initialized');
    console.log(`   Tick interval: ${this.options.tickIntervalMs}ms`);
    console.log(`   Dry run mode: ${this.options.dryRun ? 'ENABLED' : 'DISABLED'}`);
    console.log('=====================================================');

    // Handle Ctrl+C gracefully
    const sigHandler = () => {
      this.stop();
    };
    process.on('SIGINT', sigHandler);
    process.on('SIGTERM', sigHandler);

    while (this.isRunning) {
      // Check maximum tick bound if provided
      if (this.options.maxTicks && this.tickCount >= this.options.maxTicks) {
        console.log(`[loop] Reached maximum ticks (${this.options.maxTicks}). Exiting.`);
        break;
      }

      // Step 1: Locate the window
      const windowInfo = await findTargetWindow(this.options.windowQuery);
      if (!windowInfo) {
        console.warn(
          `[loop] Target window "${this.options.windowQuery}" not found. Waiting 3s... (Make sure iPhone Mirroring is open)`
        );
        await sleep(3000);
        continue;
      }

      try {
        const tickResult = await this.executeSingleTick(windowInfo);

        // Stop condition on post-game
        if (
          this.options.autoStopOnPostGame &&
          tickResult.gameState.matchPhase === 'post-game'
        ) {
          console.log('[loop] Match ended. Exiting loop.');
          break;
        }
      } catch (err) {
        console.error(`[loop] Error during tick #${this.tickCount}: ${(err as Error).message}`);
        console.log('[loop] Continuing to next tick in 3s...');
        await sleep(3000);
        continue;
      }

      if (this.isRunning) {
        await sleep(this.options.tickIntervalMs ?? 2000);
      }
    }

    process.off('SIGINT', sigHandler);
    process.off('SIGTERM', sigHandler);
    console.log(`[loop] Game loop finished. Total ticks executed: ${this.tickCount}`);
  }
}
