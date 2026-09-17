import 'dotenv/config';
import { decideMove } from '../src/decide.js';
import { DeckTracker } from '../src/deck.js';
import { perceiveGameStateLocally } from '../src/perceive.js';
import { captureWindow } from '../src/capture.js';
import { findTargetWindow } from '../src/window.js';

async function testLocalPipeline() {
  console.log('Testing Zero-Key Local Perception + TypeSafe Jev Decision Pipeline...');

  // 1. Initialize deck tracker
  const tracker = new DeckTracker([
    'Hog Rider',
    'Musketeer',
    'Fireball',
    'Skeletons',
    'Cannon',
    'Ice Golem',
    'The Log',
    'Ice Spirit',
  ]);

  console.log('Initial hand:', tracker.getHand().map((c) => `${c.name} (${c.elixirCost} elixir)`));
  console.log('Next card in queue:', tracker.getNextCard().name);

  // 2. Find any open window to test capture and OCR (e.g. Cursor or Arc)
  const win = await findTargetWindow('Cursor');
  if (!win) {
    console.log('Cursor window not found, testing with synthetic mock state...');
    return;
  }

  console.log(`Using test window: [${win.id}] "${win.owner}" - "${win.title}"`);
  const { filePath } = await captureWindow(win.id);
  console.log(`Captured test frame: ${filePath}`);

  // 3. Local perception using Apple Vision OCR (NO external API key!)
  console.log('Running local Apple Vision OCR...');
  const perceivedState = await perceiveGameStateLocally(filePath, tracker);
  console.log('Perceived state:');
  console.log(JSON.stringify(perceivedState, null, 2));

  // 4. Send to TypeSafe Jev
  console.log('Sending perceived state to TypeSafe Jev model...');
  const decision = await decideMove(perceivedState);
  console.log('Jev decision:');
  console.log(JSON.stringify(decision, null, 2));

  // 5. Test deck rotation
  const slotToPlay = decision.whichCard !== 'none' ? parseInt(decision.whichCard.replace('slot', ''), 10) : 1;
  const played = tracker.playSlot(slotToPlay);
  console.log(`Played ${played?.name} (Slot ${slotToPlay}). New hand:`, tracker.getHand().map((c) => c.name));
  console.log('New next card:', tracker.getNextCard().name);
}

testLocalPipeline().catch(console.error);
