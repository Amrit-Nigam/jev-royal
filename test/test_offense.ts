import 'dotenv/config';
import { decideMove } from '../src/decide.js';
import type { GameState } from '../src/types.js';

const mockOffenseState: GameState = {
  matchPhase: 'in-progress',
  elixir: 10.0,
  cardsInHand: [
    { slot: 1, name: 'Hog Rider', elixirCost: 4, isPlayable: true },
    { slot: 2, name: 'Musketeer', elixirCost: 4, isPlayable: true },
    { slot: 3, name: 'Fireball', elixirCost: 4, isPlayable: true },
    { slot: 4, name: 'Skeletons', elixirCost: 1, isPlayable: true },
  ],
  nextCard: 'Cannon',
  opponentTroops: [],
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
    leftPrincessHpPercent: 60,
    rightPrincessHpPercent: 100,
    kingHpPercent: 100,
    leftPrincessStanding: true,
    rightPrincessStanding: true,
    kingStanding: true,
  },
  timeRemainingSeconds: 90,
  rawSummary: 'Elixir is at 10 (leaking). Opponent left tower is weak at 60%. No enemy troops on board.',
};

async function test() {
  console.log('Testing offensive / push scenario with Jev...');
  const decision = await decideMove(mockOffenseState);
  console.log('Offensive decision result:');
  console.log(JSON.stringify(decision, null, 2));
}

test().catch(console.error);
