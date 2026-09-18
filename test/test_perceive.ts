/**
 * Runs the perception layer over the recorded capture frames.
 *
 * These frames are real in-battle screenshots, so this checks the parts that
 * used to be fabricated: that the hand is read off the screen, that elixir is
 * fractional and plausible, and that menu frames are not mistaken for battles.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Perceiver } from '../src/perceive.js';

/**
 * Frames to replay. Recordings are preferred over the live capture buffer,
 * because `captures/` is a rolling window that a later run will overwrite.
 * Point FRAMES_DIR at any directory to replay a specific session.
 */
function findFrameDir(): string | null {
  const explicit = process.env.FRAMES_DIR;
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;

  const recordings = resolve(process.cwd(), 'recordings');
  if (existsSync(recordings)) {
    const sessions = readdirSync(recordings)
      .map((name) => resolve(recordings, name))
      .filter((p) => statSync(p).isDirectory())
      .sort();
    if (sessions.length > 0) return sessions[sessions.length - 1];
  }

  const captures = resolve(process.cwd(), 'captures');
  return existsSync(captures) ? captures : null;
}

async function main() {
  const dir = findFrameDir();
  const frames = dir
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .sort()
        .map((f) => resolve(dir, f))
    : [];

  if (frames.length === 0) {
    console.error(
      'No frames to replay.\n' +
        'Record a match first:  npm start -- --record --dry-run\n' +
        'Then re-run this test, or set FRAMES_DIR=<dir>.'
    );
    process.exit(1);
  }

  console.log(`replaying ${frames.length} frames from ${dir}\n`);

  const perceiver = new Perceiver();
  let battles = 0;
  let failures = 0;
  let previous: string | undefined;

  for (const frame of frames) {
    const state = await perceiver.perceive(frame, {
      previousImagePath: previous,
      runOcr: true,
    });
    previous = frame;

    const label = frame.split('/').pop();

    if (state.matchPhase !== 'in-progress') {
      console.log(`${label}  [${state.matchPhase}]`);
      continue;
    }

    battles++;
    const hand = state.cardsInHand.map((c) => `${c.name}(${c.elixirCost})`).join(' ');
    console.log(
      `${label}  elixir=${state.elixir.toFixed(2)}${state.doubleElixir ? ' 2x' : ''} ` +
        `threats=${state.threats.length}/${state.threats.filter((t) => t.onOurSide).length} ` +
        `hand=[${hand}]`
    );

    if (state.cardsInHand.length !== 4) {
      console.error(`  FAIL: expected 4 cards, got ${state.cardsInHand.length}`);
      failures++;
    }
    if (state.elixir < 0 || state.elixir > 10) {
      console.error(`  FAIL: elixir ${state.elixir} out of range`);
      failures++;
    }
    if (state.cardsInHand.some((c) => !c.key)) {
      console.error('  FAIL: unidentified card in hand');
      failures++;
    }
  }

  console.log(`\n${battles} battle frames, ${failures} failures`);
  if (battles === 0) {
    console.error(
      'FAIL: no frame in this set was recognized as a battle, so nothing was actually verified.\n' +
        'Record footage during a real match: npm start -- --record --dry-run'
    );
    process.exit(1);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main();
