import 'dotenv/config';
import { captureWindow } from './capture.js';
import { startDashboard } from './dashboard.js';
import { GameLoop } from './loop.js';
import { findTargetWindow, listAllWindows } from './window.js';

function usage(): void {
  console.log(`Jev Clash Royale agent

Usage: npm start [-- <flags>]

Flags:
  --list-windows       List visible windows and exit
  --capture-only       Capture one frame of the target window and exit
  --window <query>     Window to drive (default: "iPhone Mirroring")
  --dry-run            Decide and log plays without sending any taps
  --single-tick        Run exactly one tick, then exit
  --local-only         Decide purely from local tactics, never calling the model
  --interval <ms>      Tick interval (default: 700)
  --record [dir]       Save every frame to recordings/<timestamp> (never pruned),
                       for tuning perception against real match footage
  --dashboard [port]   Serve the live dashboard (default port 5173)
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  if (args.includes('--list-windows')) {
    console.log(JSON.stringify(await listAllWindows(), null, 2));
    return;
  }

  const windowIndex = args.indexOf('--window');
  const windowQuery =
    windowIndex !== -1 && args[windowIndex + 1] ? args[windowIndex + 1] : 'iPhone Mirroring';

  if (args.includes('--capture-only')) {
    const win = await findTargetWindow(windowQuery);
    if (!win) {
      console.error(`No window matching "${windowQuery}". Try --list-windows.`);
      process.exit(1);
    }
    console.log(`Found [${win.id}] "${win.owner}" - "${win.title}" ${JSON.stringify(win.bounds)}`);
    const { filePath } = await captureWindow(win.id);
    console.log(`Captured to ${filePath}`);
    return;
  }

  const localOnly = args.includes('--local-only');
  if (!localOnly && !process.env.TYPESAFE_API_KEY) {
    console.warn('[config] TYPESAFE_API_KEY not set; running on local tactics only.');
  }

  const intervalIndex = args.indexOf('--interval');
  const tickIntervalMs =
    intervalIndex !== -1 && args[intervalIndex + 1] ? Number(args[intervalIndex + 1]) : undefined;

  let recordDir: string | undefined;
  const recordIndex = args.indexOf('--record');
  if (recordIndex !== -1) {
    const explicit = args[recordIndex + 1];
    recordDir =
      explicit && !explicit.startsWith('--')
        ? explicit
        : `recordings/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    console.log(`[config] recording every frame to ${recordDir} (pruning disabled)`);
  }

  const dashboardIndex = args.indexOf('--dashboard');
  let dashboard: ReturnType<typeof startDashboard> | undefined;
  if (dashboardIndex !== -1) {
    const explicit = args[dashboardIndex + 1];
    const port = explicit && !explicit.startsWith('--') ? Number(explicit) : 5173;
    dashboard = startDashboard(port);
    console.log(`[dashboard] ${dashboard.url}`);
  }

  const loop = new GameLoop({
    windowQuery,
    dryRun: args.includes('--dry-run'),
    maxTicks: args.includes('--single-tick') ? 1 : undefined,
    localOnly: localOnly || !process.env.TYPESAFE_API_KEY,
    ...(recordDir ? { recordDir } : {}),
    ...(tickIntervalMs ? { tickIntervalMs } : {}),
    ...(dashboard ? { onTick: dashboard.publish } : {}),
  });

  try {
    await loop.run();
  } finally {
    dashboard?.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
