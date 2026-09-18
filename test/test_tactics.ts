/**
 * Scenario tests for the local tactical layer.
 *
 * These run without any network call, and cover the situations that were
 * previously handled badly: an unanswered push, wasting elixir at the cap,
 * spending a spell on a single unit, and pushing while under attack.
 */
import { ARENA } from '../src/arena.js';
import { assess } from '../src/tactics.js';
import type { ArenaUnit, CardInHand, GameState, TowerState } from '../src/types.js';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    failures++;
  }
}

function card(slot: 1 | 2 | 3 | 4, key: string, name: string, elixir: number, type: CardInHand['type']): CardInHand {
  return {
    slot,
    key,
    name,
    elixirCost: elixir,
    type,
    isPlayable: true,
    recognition: { score: 0.7, margin: 0.2, confident: true },
  };
}

function towers(): TowerState[] {
  return [
    { side: 'opponent', position: 'left', hp: 2500, standing: true },
    { side: 'opponent', position: 'right', hp: 1200, standing: true },
    { side: 'opponent', position: 'king', hp: 4000, standing: true },
    { side: 'own', position: 'left', hp: 2600, standing: true },
    { side: 'own', position: 'right', hp: 2600, standing: true },
    { side: 'own', position: 'king', hp: 4000, standing: true },
  ];
}

function threat(x: number, y: number): ArenaUnit {
  return { owner: 'opponent', x, y, source: 'healthbar', onOurSide: y > ARENA.riverY };
}

function baseState(overrides: Partial<GameState> = {}): GameState {
  return {
    matchPhase: 'in-progress',
    elixir: 6,
    doubleElixir: false,
    cardsInHand: [
      card(1, 'mini-pekka', 'Mini P.E.K.K.A', 4, 'Troop'),
      card(2, 'baby-dragon', 'Baby Dragon', 4, 'Troop'),
      card(3, 'knight', 'Knight', 3, 'Troop'),
      card(4, 'goblin-barrel', 'Goblin Barrel', 3, 'Spell'),
    ],
    threats: [],
    ownUnits: [],
    towers: towers(),
    ...overrides,
  };
}

console.log('defends a push in our half instead of ignoring it');
{
  const state = baseState({ elixir: 7, threats: [threat(0.23, 0.62)] });
  const a = assess(state);
  check('produces a defensive candidate', a.candidates.some((c) => c.kind === 'defend'));
  check('top candidate defends', a.candidates[0]?.kind === 'defend', a.candidates[0]?.kind);
  check('acts urgently without a model call', a.urgent !== null);
  check(
    'places the defender on our side of the river',
    a.candidates[0].placement.y > ARENA.riverY,
    String(a.candidates[0]?.placement.y)
  );
  check('does not offer a push while under attack', !a.candidates.some((c) => c.kind === 'push'));
}

console.log('prefers a defender that also hits air, since we cannot tell air from ground');
{
  const state = baseState({ elixir: 8, threats: [threat(0.77, 0.60)] });
  const a = assess(state);
  const top = a.candidates[0];
  check('chooses Baby Dragon over ground-only Mini P.E.K.K.A', top.card.key === 'baby-dragon', top.card.name);
}

console.log('does not spend a spell on a single unit');
{
  const state = baseState({
    elixir: 9,
    threats: [threat(0.5, 0.60)],
    cardsInHand: [
      card(1, 'fireball', 'Fireball', 4, 'Spell'),
      card(2, 'knight', 'Knight', 3, 'Troop'),
      card(3, 'arrows', 'Arrows', 3, 'Spell'),
      card(4, 'skeletons', 'Skeletons', 1, 'Troop'),
    ],
  });
  const a = assess(state);
  check('no spell candidate against one unit', !a.candidates.some((c) => c.kind === 'spell'));
}

console.log('uses a spell when several units are clustered');
{
  const state = baseState({
    elixir: 9,
    threats: [threat(0.5, 0.60), threat(0.52, 0.61), threat(0.49, 0.62)],
    cardsInHand: [
      card(1, 'fireball', 'Fireball', 4, 'Spell'),
      card(2, 'knight', 'Knight', 3, 'Troop'),
      card(3, 'arrows', 'Arrows', 3, 'Spell'),
      card(4, 'skeletons', 'Skeletons', 1, 'Troop'),
    ],
  });
  const a = assess(state);
  check('offers a spell on the cluster', a.candidates.some((c) => c.kind === 'spell'));
}

console.log('never leaks elixir at the cap');
{
  const state = baseState({ elixir: 9.8 });
  const a = assess(state);
  check('has something to play', a.candidates.length > 0);
  check('treats it as urgent', a.urgent !== null);
  check('does not report a hold reason', a.holdReason === null, a.holdReason ?? '');
}

console.log('holds elixir when nothing is happening');
{
  const state = baseState({ elixir: 4 });
  const a = assess(state);
  check('no urgent action', a.urgent === null);
  check('explains the hold', a.holdReason !== null);
}

console.log('pushes the weaker enemy tower when the board is clear');
{
  const state = baseState({
    elixir: 9,
    cardsInHand: [
      card(1, 'hog-rider', 'Hog Rider', 4, 'Troop'),
      card(2, 'knight', 'Knight', 3, 'Troop'),
      card(3, 'musketeer', 'Musketeer', 4, 'Troop'),
      card(4, 'skeletons', 'Skeletons', 1, 'Troop'),
    ],
  });
  const a = assess(state);
  const push = a.candidates.find((c) => c.kind === 'push');
  check('offers a push', push !== undefined);
  // The right tower is set to 1200 hp against the left's 2500.
  check('attacks the damaged right lane', push?.placement.x === ARENA.rightLaneX, String(push?.placement.x));
  check('pushes from our side of the river', (push?.placement.y ?? 0) > ARENA.riverY);
}

console.log('offers genuinely different placements, not one fixed point per card');
{
  const state = baseState({ elixir: 9, threats: [threat(0.23, 0.60)] });
  const a = assess(state);
  const points = a.candidates.map((c) => `${c.placement.x.toFixed(3)},${c.placement.y.toFixed(3)}`);
  check('more than one distinct placement', new Set(points).size > 1, points.join(' '));
  check(
    'placements track the threat rather than a lane constant',
    a.candidates.some((c) => Math.abs(c.placement.x - ARENA.leftLaneX) > 0.01)
  );
}

console.log('leads a spell ahead of a moving target instead of aiming where it is');
{
  const moving: ArenaUnit = {
    owner: 'opponent',
    x: 0.50,
    y: 0.52,
    source: 'healthbar',
    onOurSide: true,
    // Advancing down the board toward our tower.
    velocity: { x: 0, y: 0.06 },
  };
  const stationary = { ...moving, x: 0.53, velocity: undefined };
  const state = baseState({
    elixir: 10,
    threats: [moving, stationary, { ...moving, x: 0.47 }],
    cardsInHand: [
      card(1, 'fireball', 'Fireball', 4, 'Spell'),
      card(2, 'knight', 'Knight', 3, 'Troop'),
      card(3, 'arrows', 'Arrows', 3, 'Spell'),
      card(4, 'skeletons', 'Skeletons', 1, 'Troop'),
    ],
  });
  const a = assess(state);
  const spell = a.candidates.find((c) => c.kind === 'spell');
  check('casts a spell on the group', spell !== undefined);
  // Fireball travels ~0.9s, so the aim point must sit below the current y.
  check(
    'aims ahead of where the units currently are',
    (spell?.placement.y ?? 0) > 0.52,
    `aimed at y=${spell?.placement.y.toFixed(3)} vs current y=0.52`
  );
}

console.log('places a defensive building to pull the push, not in the lane');
{
  const state = baseState({
    elixir: 9,
    threats: [threat(0.23, 0.55)],
    cardsInHand: [
      card(1, 'cannon', 'Cannon', 3, 'Building'),
      card(2, 'baby-dragon', 'Baby Dragon', 4, 'Troop'),
      card(3, 'knight', 'Knight', 3, 'Troop'),
      card(4, 'rage', 'Rage', 2, 'Spell'),
    ],
  });
  const a = assess(state);
  const building = a.candidates.find((c) => c.card.key === 'cannon');
  check('offers the building', building !== undefined);
  check(
    'pulled toward the center, off the lane',
    (building?.placement.x ?? 0) > ARENA.leftLaneX + 0.02,
    `x=${building?.placement.x.toFixed(3)} vs lane ${ARENA.leftLaneX}`
  );
  check(
    'placed in front of our tower, not behind it',
    (building?.placement.y ?? 1) < ARENA.ownPrincessY,
    `y=${building?.placement.y.toFixed(3)}`
  );
}

console.log('starts a push on the side it is actually attacking');
{
  // Right tower is the damaged one, so pressure should build on the right.
  const state = baseState({
    elixir: 9,
    cardsInHand: [
      card(1, 'mini-pekka', 'Mini P.E.K.K.A', 4, 'Troop'),
      card(2, 'baby-dragon', 'Baby Dragon', 4, 'Troop'),
      card(3, 'cannon', 'Cannon', 3, 'Building'),
      card(4, 'fireball', 'Fireball', 4, 'Spell'),
    ],
  });
  const a = assess(state);
  const back = a.candidates.find((c) => c.placement.label.includes('behind the king'));
  check('offers a back placement to build a push', back !== undefined);
  check(
    'builds it on the right, matching the lane it attacks',
    (back?.placement.x ?? 0) > ARENA.centerX,
    `x=${back?.placement.x.toFixed(3)} should be right of center ${ARENA.centerX}`
  );
}

console.log('cycles away from the lane under pressure');
{
  const state = baseState({ elixir: 9.8, threats: [threat(0.23, 0.60)] });
  const a = assess(state);
  const cycle = a.candidates.find((c) => c.kind === 'cycle');
  if (cycle) {
    check('cycles to the right while the left is attacked', cycle.placement.x > ARENA.centerX);
  } else {
    check('a defensive answer outranked cycling', a.candidates[0].kind === 'defend');
  }
}

console.log(`\n${failures === 0 ? 'all tactics scenarios passed' : `${failures} failures`}`);
process.exit(failures > 0 ? 1 : 0);
