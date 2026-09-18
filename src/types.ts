export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  owner: string;
  title: string;
  bounds: WindowBounds;
}

/** How confident the template matcher is about a recognized card slot. */
export interface Recognition {
  score: number;
  margin: number;
  /** True when the match is strong enough to act on. */
  confident: boolean;
}

export type CardType = 'Troop' | 'Spell' | 'Building' | 'unknown';

export interface CardInHand {
  slot: 1 | 2 | 3 | 4;
  /** RoyaleAPI slug, e.g. "mini-pekka". Empty when unrecognized. */
  key: string;
  name: string;
  elixirCost: number;
  type: CardType;
  isPlayable: boolean;
  recognition: Recognition;
}

/**
 * Something moving in the arena. We can locate units and tell who owns them
 * (Clash Royale colors enemy health bars red and friendly ones blue), but we
 * deliberately do not claim to know *which* card a unit is — nothing on screen
 * tells us that, and a fabricated unit name is worse than an honest position.
 */
export interface ArenaUnit {
  owner: 'own' | 'opponent';
  /** Position as a fraction of the mirroring window. */
  x: number;
  y: number;
  source: 'healthbar' | 'motion';
  /** Motion energy, when this came from frame differencing. */
  intensity?: number;
  /** True when this unit is on our side of the river and must be answered. */
  onOurSide: boolean;
  /**
   * Velocity in window fractions per second, measured by tracking this unit
   * across frames. Spells need this: they take about a second to land, so
   * aiming where a unit currently stands misses anything that is moving.
   */
  velocity?: { x: number; y: number };
}

export interface TowerState {
  side: 'own' | 'opponent';
  position: 'left' | 'right' | 'king';
  /** Last read hit points, when OCR has seen them. */
  hp?: number;
  standing: boolean;
}

export type MatchPhase = 'pre-game' | 'in-progress' | 'overtime' | 'post-game' | 'menu';

export interface GameState {
  matchPhase: MatchPhase;
  /** Fractional elixir read off the bar, e.g. 7.15. */
  elixir: number;
  doubleElixir: boolean;
  cardsInHand: CardInHand[];
  nextCard?: string;
  /** Opponent units, nearest-threat first. */
  threats: ArenaUnit[];
  ownUnits: ArenaUnit[];
  towers: TowerState[];
  timeRemainingSeconds?: number;
  rawSummary?: string;
  /** Our elixir advantage estimate: positive means we are ahead. */
  elixirAdvantage?: number;
}

/**
 * A concrete, playable action: a specific card at a specific point. Placements
 * are real coordinates rather than one of a handful of fixed lanes, because in
 * Clash Royale where you put a card is most of the decision.
 */
export interface Placement {
  label: string;
  x: number;
  y: number;
}

export interface CandidateAction {
  /** Stable key used when asking the model to choose between candidates. */
  id: string;
  card: CardInHand;
  placement: Placement;
  /** Local tactical score; higher is better. */
  score: number;
  /** Human-readable justification, also handed to the model as context. */
  rationale: string;
  kind: 'defend' | 'push' | 'cycle' | 'spell' | 'hold';
}

export interface JevDecision {
  shouldPlayNow: boolean;
  shouldPlayProbability: number;
  /** Chosen candidate, or null when holding elixir. */
  action: CandidateAction | null;
  confidence: number;
  explanation: string;
  /** Where the decision came from, for logging and debugging. */
  source: 'tactics-urgent' | 'jev' | 'tactics-fallback' | 'hold';
  /** Every option that was considered, best first, for inspection. */
  candidates: CandidateAction[];
}

export interface ActionCoordinates {
  cardScreenX: number;
  cardScreenY: number;
  targetScreenX: number;
  targetScreenY: number;
}

export interface TickResult {
  tickNumber: number;
  timestamp: number;
  screenshotPath: string;
  gameState: GameState;
  decision?: JevDecision;
  actionTaken?: {
    cardSlot: number;
    cardName: string;
    placement: Placement;
    screenCoords: ActionCoordinates;
  };
  skippedReason?: string;
  error?: string;
  /** Wall-clock cost of each stage, surfaced on the dashboard. */
  timings?: { captureMs: number; perceiveMs: number; decideMs: number; totalMs: number };
}
