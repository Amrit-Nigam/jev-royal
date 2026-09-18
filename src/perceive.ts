import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ARENA, isOnOurSide } from './arena.js';
import { getCardKnowledge } from './cards.js';
import type { ArenaUnit, CardInHand, CardType, GameState, MatchPhase, TowerState } from './types.js';

const execFileAsync = promisify(execFile);
const HELPER_PATH = resolve(process.cwd(), 'bin/helper');

/**
 * A card match is only trusted when it both scores well and clearly beats the
 * runner-up. These thresholds come from measuring the matcher against real
 * capture frames: genuine in-battle matches land around 0.5-0.7 with a margin
 * well above 0.05, while non-battle frames top out near 0.5 with margins under
 * 0.05. Requiring both keeps menu screens from being read as a hand.
 */
const CARD_MIN_SCORE = 0.42;
const CARD_MIN_MARGIN = 0.05;

interface HelperCardCandidate {
  key: string;
  name: string;
  elixir: number;
  type: string;
  score: number;
}

interface HelperCardMatch {
  slot: number;
  key: string;
  name: string;
  elixir: number;
  type: string;
  score: number;
  margin: number;
  alternatives: HelperCardCandidate[];
}

interface HelperHealthBar {
  owner: 'own' | 'opponent';
  x: number;
  y: number;
  width: number;
}

interface HelperMotionCell {
  x: number;
  y: number;
  intensity: number;
}

interface HelperTowerNumber {
  value: number;
  x: number;
  y: number;
}

interface HelperState {
  inBattle: boolean;
  elixir?: number;
  doubleElixir: boolean;
  cards: HelperCardMatch[];
  nextCard?: HelperCardMatch;
  healthBars: HelperHealthBar[];
  motion: HelperMotionCell[];
  towerNumbers: HelperTowerNumber[];
  detectedPhase?: string;
  timeRemainingSeconds?: number;
}

/** The six tower positions, used to ignore tower health bars when finding units. */
const TOWER_ANCHORS: Array<{ side: 'own' | 'opponent'; position: 'left' | 'right' | 'king'; x: number; y: number }> = [
  { side: 'opponent', position: 'left', x: ARENA.leftLaneX, y: ARENA.opponentPrincessY },
  { side: 'opponent', position: 'right', x: ARENA.rightLaneX, y: ARENA.opponentPrincessY },
  { side: 'opponent', position: 'king', x: ARENA.centerX, y: ARENA.opponentKingY },
  { side: 'own', position: 'left', x: ARENA.leftLaneX, y: ARENA.ownPrincessY },
  { side: 'own', position: 'right', x: ARENA.rightLaneX, y: ARENA.ownPrincessY },
  { side: 'own', position: 'king', x: ARENA.centerX, y: ARENA.ownKingY },
];

export interface PerceiveOptions {
  /** Previous frame, enabling motion detection. */
  previousImagePath?: string;
  /** Run the (slower) OCR pass on this frame. */
  runOcr?: boolean;
}

/**
 * Perceives game state from captured frames.
 *
 * Holds state across ticks because several signals are only meaningful over
 * time: which health bars are scenery rather than units, what the clock read at
 * the last OCR pass, and each tower's last known hit points.
 */
export class Perceiver {
  /** How often a health bar has appeared at each quantized position. */
  private barSightings = new Map<string, number>();
  private framesSeen = 0;

  private lastClockSeconds?: number;
  private lastClockAt?: number;
  private towerHp = new Map<string, number>();
  private towerSeen = new Map<string, number>();
  private ocrPasses = 0;

  /** Cards latched per slot, so a card we cannot afford stays identified.
   *
   * Clash Royale renders unaffordable cards desaturated, which measurably
   * degrades template matching. A card in a slot cannot change until it is
   * played, so a confident reading is kept until the art actually changes.
   */
  private slotLatch = new Map<number, { key: string; name: string; elixir: number; type: CardType }>();

  /** Cards confidently recognized so far, which converges on the deck in play. */
  private deckSeen = new Map<string, number>();

  /** Previous frame's units, for measuring velocity. */
  private lastUnits?: ArenaUnit[];
  private lastUnitsAt?: number;

  public async perceive(imagePath: string, options: PerceiveOptions = {}): Promise<GameState> {
    const args = ['state', imagePath];
    if (options.previousImagePath) args.push(options.previousImagePath);
    if (options.runOcr) args.push('--ocr');

    const { stdout } = await execFileAsync(HELPER_PATH, args, { maxBuffer: 16 * 1024 * 1024 });
    const raw = JSON.parse(stdout.trim()) as HelperState;

    this.framesSeen++;
    if (options.runOcr) this.ocrPasses++;

    const elixir = raw.elixir ?? 0;
    const phase = this.resolvePhase(raw);

    if (!raw.inBattle) {
      return {
        matchPhase: phase,
        elixir: 0,
        doubleElixir: false,
        cardsInHand: [],
        threats: [],
        ownUnits: [],
        towers: this.towerStates(raw, false),
        rawSummary: `Not in a battle (phase=${phase})`,
      };
    }

    const cardsInHand = this.resolveHand(raw, elixir);
    const { threats, ownUnits } = this.resolveUnits(raw);
    const timeRemaining = this.resolveClock(raw);
    const doubleElixir = raw.doubleElixir || (timeRemaining !== undefined && timeRemaining <= 60);

    const nextCard =
      raw.nextCard && raw.nextCard.score >= CARD_MIN_SCORE && raw.nextCard.margin >= CARD_MIN_MARGIN
        ? raw.nextCard.name
        : undefined;

    return {
      matchPhase: phase,
      elixir,
      doubleElixir,
      cardsInHand,
      nextCard,
      threats,
      ownUnits,
      towers: this.towerStates(raw, true),
      timeRemainingSeconds: timeRemaining,
      rawSummary:
        `elixir=${elixir.toFixed(1)}${doubleElixir ? ' (2x)' : ''}, ` +
        `hand=[${cardsInHand.map((c) => c.name).join(', ')}], ` +
        `threats=${threats.length} (${threats.filter((t) => t.onOurSide).length} on our side)` +
        (timeRemaining !== undefined ? `, clock=${timeRemaining}s` : ''),
    };
  }

  private resolvePhase(raw: HelperState): MatchPhase {
    const detected = raw.detectedPhase;
    if (detected === 'post-game' || detected === 'overtime') return detected;
    if (raw.inBattle) return 'in-progress';
    return detected === 'menu' ? 'menu' : 'pre-game';
  }

  /**
   * Resolves the hand from template matches.
   *
   * A raw top-1 match is not trusted on its own. Clash Royale renders cards you
   * cannot afford desaturated, which measurably degrades matching and pulls the
   * result toward a visually similar card. Two pieces of knowledge the matcher
   * does not have are applied here to recover the right answer:
   *
   *  1. A deck only has eight cards. Once a card has been recognized
   *     confidently, it is a far more likely explanation for a weak match than
   *     some card that has never appeared.
   *  2. A card in a slot cannot change until that slot is played, so the last
   *     confident reading stands until the art actually changes.
   */
  private resolveHand(raw: HelperState, elixir: number): CardInHand[] {
    const hand: CardInHand[] = [];

    for (const match of raw.cards) {
      const slot = match.slot as 1 | 2 | 3 | 4;
      const confident = match.score >= CARD_MIN_SCORE && match.margin >= CARD_MIN_MARGIN;

      let key = match.key;
      let name = match.name;
      let cost = match.elixir;
      let type = (match.type as CardType) ?? 'unknown';
      let resolvedConfident = confident;

      if (confident) {
        this.deckSeen.set(key, (this.deckSeen.get(key) ?? 0) + 1);
      } else {
        // Prefer the best-scoring candidate already known to be in this deck.
        const inDeck = (match.alternatives ?? []).find((alt) => this.deckSeen.has(alt.key));
        const latched = this.slotLatch.get(slot);

        if (latched && (!inDeck || inDeck.key === latched.key)) {
          // The slot has not been played, so its previous identity still holds.
          key = latched.key;
          name = latched.name;
          cost = latched.elixir;
          type = latched.type;
          resolvedConfident = true;
        } else if (inDeck) {
          key = inDeck.key;
          name = inDeck.name;
          cost = inDeck.elixir;
          type = (inDeck.type as CardType) ?? 'unknown';
          resolvedConfident = true;
        }
      }

      this.slotLatch.set(slot, { key, name, elixir: cost, type });

      hand.push({
        slot,
        key,
        name,
        elixirCost: cost,
        type,
        isPlayable: elixir >= cost,
        recognition: { score: match.score, margin: match.margin, confident: resolvedConfident },
      });
    }

    return hand;
  }

  /** The eight cards we have confidently seen, i.e. the deck being played. */
  public knownDeck(): string[] {
    return [...this.deckSeen.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }

  /**
   * Turns health bars and motion cells into located units.
   *
   * Tower health bars sit at fixed positions and would otherwise look like six
   * permanent enemies. They are removed two ways: geometrically, using the known
   * tower anchors, and statistically, by dropping any bar position that shows up
   * in most frames (scenery and HUD elements the anchors do not cover).
   */
  private resolveUnits(raw: HelperState): { threats: ArenaUnit[]; ownUnits: ArenaUnit[] } {
    const threats: ArenaUnit[] = [];
    const ownUnits: ArenaUnit[] = [];

    for (const bar of raw.healthBars) {
      const cellKey = `${bar.owner}:${Math.round(bar.x * 40)}:${Math.round(bar.y * 40)}`;
      this.barSightings.set(cellKey, (this.barSightings.get(cellKey) ?? 0) + 1);

      if (this.isTowerBar(bar.x, bar.y)) continue;
      if (this.isStaticBar(cellKey)) continue;

      const unit: ArenaUnit = {
        owner: bar.owner,
        x: bar.x,
        y: bar.y,
        source: 'healthbar',
        onOurSide: isOnOurSide(bar.y),
      };
      (bar.owner === 'opponent' ? threats : ownUnits).push(unit);
    }

    this.trackVelocities([...threats, ...ownUnits]);

    // Motion deliberately does not create units of its own. Frame differencing
    // says that something moved, never who owns it, and our own troops walking
    // up our half move just as much as an attacker does - treating that as an
    // incoming push makes the agent defend against itself. Motion is instead
    // used to corroborate a health bar we already found, marking which detected
    // units are actually advancing rather than standing still.
    for (const unit of [...threats, ...ownUnits]) {
      const nearby = raw.motion.filter(
        (cell) => Math.hypot(unit.x - cell.x, unit.y - cell.y) < 0.09
      );
      if (nearby.length > 0) {
        unit.intensity = Math.max(...nearby.map((cell) => cell.intensity));
      }
    }

    // Most urgent first: deepest into our half.
    threats.sort((a, b) => b.y - a.y);
    return { threats, ownUnits };
  }

  /**
   * Measures how fast each unit is moving by matching it to the nearest unit of
   * the same owner in the previous frame.
   *
   * Nearest-neighbour matching is crude and will occasionally swap two units
   * that pass close to each other, so the result is capped at a plausible troop
   * speed rather than trusted blindly. It only needs to be good enough to lead a
   * spell by about a second.
   */
  private trackVelocities(units: ArenaUnit[]): void {
    const now = Date.now();
    const elapsed = this.lastUnitsAt ? (now - this.lastUnitsAt) / 1000 : 0;

    if (this.lastUnits && elapsed > 0.05 && elapsed < 2.0) {
      for (const unit of units) {
        let nearest: ArenaUnit | undefined;
        let nearestDistance = Infinity;
        for (const previous of this.lastUnits) {
          if (previous.owner !== unit.owner) continue;
          const distance = Math.hypot(previous.x - unit.x, previous.y - unit.y);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = previous;
          }
        }
        // Too far to plausibly be the same unit one frame later.
        if (!nearest || nearestDistance > 0.12) continue;

        const vx = (unit.x - nearest.x) / elapsed;
        const vy = (unit.y - nearest.y) / elapsed;
        const speed = Math.hypot(vx, vy);
        // The fastest troops cross the arena in roughly ten seconds, so
        // anything above this is a tracking error, not a unit.
        if (speed > 0.35) continue;
        unit.velocity = { x: vx, y: vy };
      }
    }

    this.lastUnits = units.map((u) => ({ ...u }));
    this.lastUnitsAt = now;
  }

  private isTowerBar(x: number, y: number): boolean {
    return TOWER_ANCHORS.some(
      (anchor) => Math.abs(anchor.x - x) < 0.11 && Math.abs(anchor.y - y) < 0.075
    );
  }

  private isStaticBar(cellKey: string): boolean {
    // Needs a warm-up before the ratio means anything.
    if (this.framesSeen < 8) return false;
    const seen = this.barSightings.get(cellKey) ?? 0;
    return seen / this.framesSeen > 0.6;
  }

  /**
   * The clock only updates on OCR passes, so it is extrapolated in between
   * using elapsed wall-clock time. This is what lets OCR run occasionally
   * instead of on every frame without losing track of double elixir.
   */
  private resolveClock(raw: HelperState): number | undefined {
    if (raw.timeRemainingSeconds !== undefined) {
      this.lastClockSeconds = raw.timeRemainingSeconds;
      this.lastClockAt = Date.now();
      return raw.timeRemainingSeconds;
    }
    if (this.lastClockSeconds === undefined || this.lastClockAt === undefined) return undefined;
    const elapsed = (Date.now() - this.lastClockAt) / 1000;
    return Math.max(0, Math.round(this.lastClockSeconds - elapsed));
  }

  /**
   * Maps OCR'd hit-point numbers onto the six towers by position.
   *
   * Hit points only ever decrease, so a reading that jumps upward is an OCR
   * misread (a dropped digit turns 3052 into 305) and is discarded. A tower
   * that stops reporting a number after having reported one has been destroyed.
   */
  private towerStates(raw: HelperState, inBattle: boolean): TowerState[] {
    // Outside a battle the arena is not on screen, so any number OCR finds is
    // menu chrome, not a tower. Ingesting it would invent tower hit points from
    // the home screen. Leaving a battle also clears the table, so the next match
    // does not inherit the previous one's tower state.
    if (!inBattle) {
      if (this.towerHp.size > 0) {
        this.towerHp.clear();
        this.towerSeen.clear();
      }
      return TOWER_ANCHORS.map((anchor) => ({
        side: anchor.side,
        position: anchor.position,
        standing: true,
      }));
    }

    for (const number of raw.towerNumbers) {
      let nearest: (typeof TOWER_ANCHORS)[number] | null = null;
      let nearestDistance = Infinity;
      for (const anchor of TOWER_ANCHORS) {
        // Hit-point labels are drawn just above their tower.
        const distance = Math.hypot(anchor.x - number.x, anchor.y - 0.03 - number.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = anchor;
        }
      }
      if (!nearest || nearestDistance > 0.12) continue;

      const id = `${nearest.side}:${nearest.position}`;
      const previous = this.towerHp.get(id);
      if (previous !== undefined && number.value > previous * 1.02) continue;
      this.towerHp.set(id, number.value);
      this.towerSeen.set(id, this.ocrPasses);
    }

    return TOWER_ANCHORS.map((anchor) => {
      const id = `${anchor.side}:${anchor.position}`;
      const hp = this.towerHp.get(id);
      const lastSeen = this.towerSeen.get(id);
      // Only call a tower destroyed once we had been reading it and then stopped.
      const standing =
        !inBattle || hp === undefined || lastSeen === undefined
          ? true
          : this.ocrPasses - lastSeen < 3;
      return { side: anchor.side, position: anchor.position, hp, standing };
    });
  }
}
