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

export interface CardInHand {
  slot: 1 | 2 | 3 | 4;
  name: string;
  elixirCost?: number;
  isPlayable?: boolean;
  coords?: { xPercent: number; yPercent: number };
}

export interface TroopUnit {
  type: string;
  owner: 'own' | 'opponent';
  lane: 'left' | 'right' | 'center';
  approxHpPercent?: number;
  position?: { xPercent: number; yPercent: number };
}

export interface TowerStatus {
  leftPrincessHpPercent?: number;
  rightPrincessHpPercent?: number;
  kingHpPercent?: number;
  leftPrincessStanding?: boolean;
  rightPrincessStanding?: boolean;
  kingStanding?: boolean;
  /** Raw HP number read off the tower's health bar, when visible (no max-HP baseline, so not a percent). */
  leftPrincessHpRaw?: number;
  rightPrincessHpRaw?: number;
  kingHpRaw?: number;
}

export type MatchPhase = 'pre-game' | 'in-progress' | 'overtime' | 'post-game' | 'menu';

export interface GameState {
  matchPhase: MatchPhase;
  elixir: number;
  cardsInHand: CardInHand[];
  nextCard?: string;
  opponentTroops: TroopUnit[];
  ownTroops: TroopUnit[];
  ownTowers: TowerStatus;
  opponentTowers: TowerStatus;
  timeRemainingSeconds?: number;
  rawSummary?: string;
  /** Whether cardsInHand can be trusted this tick (see DeckTracker desync check). */
  handTrackingConfidence?: 'high' | 'low';
}

export type PlacementLane =
  | 'left_bridge'
  | 'right_bridge'
  | 'defensive_left'
  | 'defensive_right'
  | 'defensive_center'
  | 'back_cycle_left'
  | 'back_cycle_right';

export interface JevDecision {
  shouldPlayNow: boolean;
  shouldPlayProbability: number;
  whichCard: 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'none';
  cardConfidence: number;
  whichLane: PlacementLane;
  laneConfidence: number;
  explanation?: string;
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
    placement: PlacementLane;
    screenCoords: ActionCoordinates;
  };
  skippedReason?: string;
  error?: string;
}
