import 'dotenv/config';
import { captureWindow } from './capture.js';
import { GameLoop } from './loop.js';
import { findTargetWindow, listAllWindows } from './window.js';

async function main() {
  const args = process.argv.slice(2);

  // CLI Flag: --list-windows
  if (args.includes('--list-windows')) {
    console.log('Listing all open application windows:');
    const windows = await listAllWindows();
    console.log(JSON.stringify(windows, null, 2));
    return;
  }

  // CLI Flag: custom window query (e.g. --window "iPhone")
  const windowIndex = args.indexOf('--window');
  const windowQuery = windowIndex !== -1 && args[windowIndex + 1] ? args[windowIndex + 1] : 'iPhone Mirroring';

  // CLI Flag: --capture-only
  if (args.includes('--capture-only')) {
    console.log(`Searching for window matching "${windowQuery}"...`);
    const win = await findTargetWindow(windowQuery);
    if (!win) {
      console.error(`Window matching "${windowQuery}" not found.`);
      console.log('Run with --list-windows to inspect visible windows.');
      process.exit(1);
    }
    console.log(`Found window: [${win.id}] "${win.owner}" - "${win.title}"`);
    console.log(`Bounds: ${JSON.stringify(win.bounds)}`);
    const { filePath } = await captureWindow(win.id);
    console.log(`Captured screenshot to: ${filePath}`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const singleTick = args.includes('--single-tick');

  // CLI Flag: --deck "Card1,Card2,..."
  const deckIndex = args.indexOf('--deck');
  const deckArg = deckIndex !== -1 && args[deckIndex + 1] ? args[deckIndex + 1] : undefined;
  const deckNames = deckArg ? deckArg.split(',').map((s) => s.trim()) : undefined;

  // Verify TypeSafe API key
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('Error: TYPESAFE_API_KEY is not set in environment or .env file.');
    process.exit(1);
  }

  const visionProvider = process.env.VISION_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'local');
  console.log(`[config] Vision Perceiver: ${visionProvider === 'anthropic' ? 'Anthropic Claude' : 'Apple Vision (Local Native, 0 API keys)'}`);

  const loop = new GameLoop({
    windowQuery,
    dryRun,
    maxTicks: singleTick ? 1 : undefined,
    deckNames,
  });

  await loop.run();
}

main().catch((err) => {
  console.error('Fatal error in agent:', err);
  process.exit(1);
});
