import 'dotenv/config';
import { decideMove } from '../src/decide.js';
import type { GameState } from '../src/types.js';

const mockState: GameState = {
  matchPhase: 'in-progress',
  elixir: 8.5,
  cardsInHand: [
    { slot: 1, name: 'Hog Rider', elixirCost: 4, isPlayable: true },
    { slot: 2, name: 'Musketeer', elixirCost: 4, isPlayable: true },
    { slot: 3, name: 'Fireball', elixirCost: 4, isPlayable: true },
    { slot: 4, name: 'Skeletons', elixirCost: 1, isPlayable: true },
  ],
  nextCard: 'Cannon',
  opponentTroops: [
    { type: 'Giant', lane: 'left', approxHpPercent: 90 },
  ],
  ownTroops: [],
  ownTowers: {
    leftPrincessHpPercent: 100,
    rightPrincessHpPercent: 100,
    kingHpPercent: 100,
    leftPrincessStanding: true,
    rightPrincessStanding: true,
    kingStanding: true,
  },
  opponentTowers: {
    leftPrincessHpPercent: 95,
    rightPrincessHpPercent: 100,
    kingHpPercent: 100,
    leftPrincessStanding: true,
    rightPrincessStanding: true,
    kingStanding: true,
  },
  timeRemainingSeconds: 120,
  rawSummary: 'Opponent placed a Giant in the left lane. We have 8.5 elixir and defensive troops available.',
};

async function test() {
  console.log('Testing decideMove with mock state...');
  const decision = await decideMove(mockState);
  console.log('Decision result:');
  console.log(JSON.stringify(decision, null, 2));
}

test().catch(console.error);
