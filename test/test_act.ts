import { executePlay } from '../src/act.js';
import type { JevDecision, WindowBounds } from '../src/types.js';

const mockBounds: WindowBounds = {
  x: 100,
  y: 100,
  width: 450,
  height: 900,
};

const mockDecision: JevDecision = {
  shouldPlayNow: true,
  shouldPlayProbability: 0.92,
  whichCard: 'slot1',
  cardConfidence: 0.68,
  whichLane: 'left_bridge',
  laneConfidence: 0.42,
};

async function test() {
  console.log('Testing executePlay with dryRun=true...');
  const coords = await executePlay(mockBounds, mockDecision, { dryRun: true });
  console.log('Mapped screen coordinates:', coords);
}

test().catch(console.error);
