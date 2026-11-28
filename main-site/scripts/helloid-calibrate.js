#!/usr/bin/env node
// node scripts/helloid-calibrate.js [--json] [--list] [--target-fmr 0.001]
//
// The HelloID tuning report (api/_lib/helloid-calibration.js), the same as
// /manage's HelloID tuning tab shows admins, printed here: with up to 3000 face
// templates (the page uses 1000), --json, and --list for the check ids of
// pairs of accounts whose faces score above FACE_MATCH. Run it with the
// production SUPABASE_URL, SUPABASE_SERVICE_KEY and TOTP_ENCRYPTION_KEY in
// the environment; it only reads.

import { pathToFileURL } from 'node:url';

async function main() {
  const args = process.argv.slice(2);
  let targetFmr = 0.001;
  const targetAt = args.indexOf('--target-fmr');
  if (targetAt >= 0) {
    targetFmr = Number(args[targetAt + 1]);
  }
  const { CURRENT_THRESHOLDS } = await import('../api/_lib/helloid.js');
  const { tuningReport, printReport } = await import('../api/_lib/helloid-calibration.js');
  const report = await tuningReport(CURRENT_THRESHOLDS, { targetFmr });
  if (args.includes('--json')) {
    const plain = { ...report };
    delete plain.pairsAbove;
    console.log(JSON.stringify(plain, null, 2));
  } else {
    console.log(`Face model: ${CURRENT_THRESHOLDS.model}\n`);
    console.log(printReport(report));
  }
  if (args.includes('--list')) {
    console.log('\nPairs of accounts above FACE_MATCH (check ids):');
    for (const pair of report.pairsAbove(CURRENT_THRESHOLDS.faceMatch)) {
      console.log(`  ${pair.score.toFixed(3)}  ${pair.checks.join('  ')}`);
    }
  }
}

// Run as a command (not imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(cause);
    process.exit(1);
  });
}
