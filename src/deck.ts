export interface CardDef {
  name: string;
  elixirCost: number;
}

// Database of common Clash Royale card elixir costs
export const KNOWN_CARD_ELIXIR: Record<string, number> = {
  skeletons: 1,
  'ice spirit': 1,
  'fire spirit': 1,
  'electro spirit': 1,
  'the log': 2,
  zap: 2,
  barbarian_barrel: 2,
  'ice golem': 2,
  bats: 2,
  goblins: 2,
  'spear goblins': 2,
  wall_breakers: 2,
  bomber: 2,
  rage: 2,
  knight: 3,
  archers: 3,
  arrows: 3,
  cannon: 3,
  'mega minion': 3,
  minions: 3,
  tombstone: 3,
  skeleton_army: 3,
  miner: 3,
  bandit: 3,
  'royal ghost': 3,
  'fisherman': 3,
  'fireball': 4,
  musketeer: 4,
  'hog rider': 4,
  valkyrie: 4,
  'mini p.e.k.k.a': 4,
  'baby dragon': 4,
  poison: 4,
  tesla: 4,
  'battle ram': 4,
  'dark prince': 4,
  wizard: 5,
  giant: 5,
  balloon: 5,
  witch: 5,
  prince: 5,
  bowler: 5,
  executioner: 5,
  'inferno tower': 5,
  'electro dragon': 5,
  'royal hogs': 5,
  'elite barbarians': 6,
  'royal giant': 6,
  lightning: 6,
  rocket: 6,
  sparky: 6,
  'p.e.k.k.a': 7,
  'mega knight': 7,
  'lava hound': 7,
  golem: 8,
  'three musketeers': 9,
};

export function getElixirForCard(cardName: string): number {
  const normalized = cardName.toLowerCase().trim();
  return KNOWN_CARD_ELIXIR[normalized] ?? 4;
}

export const DEFAULT_DECK_NAMES = [
  'Hog Rider',
  'Musketeer',
  'Fireball',
  'Skeletons',
  'Cannon',
  'Ice Golem',
  'The Log',
  'Ice Spirit',
];

export class DeckTracker {
  private hand: CardDef[] = [];
  private nextCard: CardDef;
  private queue: CardDef[] = [];

  constructor(deckNames?: string[]) {
    const names = deckNames && deckNames.length >= 8 ? deckNames.slice(0, 8) : DEFAULT_DECK_NAMES;
    const cards: CardDef[] = names.map((name) => ({
      name,
      elixirCost: getElixirForCard(name),
    }));

    this.hand = cards.slice(0, 4);
    this.nextCard = cards[4];
    this.queue = cards.slice(5, 8);
  }

  public getHand(): CardDef[] {
    return [...this.hand];
  }

  public getNextCard(): CardDef {
    return { ...this.nextCard };
  }

  /**
   * Called when a card in a slot (1, 2, 3, or 4) is played.
   * Simulates the exact Clash Royale FIFO rotation.
   */
  public playSlot(slotNumber: number): CardDef | null {
    const index = slotNumber - 1;
    if (index < 0 || index >= this.hand.length) return null;

    const playedCard = this.hand[index];
    // Rotate in nextCard
    this.hand[index] = this.nextCard;
    // Push played card to back of queue
    this.queue.push(playedCard);
    // Pop front of queue to become new nextCard
    const newNext = this.queue.shift();
    if (newNext) {
      this.nextCard = newNext;
    }

    return playedCard;
  }
}
