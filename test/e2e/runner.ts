/**
 * Master E2E Test Suite Runner for P2Sharer
 * Executes all 4 tiers of tests:
 *   Tier 1: Feature Coverage
 *   Tier 2: Boundary & Corner Cases
 *   Tier 3: Cross-Feature Combinations
 *   Tier 4: Real-World Application Scenarios
 *
 * Usage:
 *   node --experimental-strip-types test/e2e/runner.ts
 *   node --experimental-strip-types test/e2e/runner.ts --tier=1
 *   node --experimental-strip-types test/e2e/runner.ts --tier=2
 *   node --experimental-strip-types test/e2e/runner.ts --tier=3
 *   node --experimental-strip-types test/e2e/runner.ts --tier=4
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

interface TierConfig {
  id: number;
  name: string;
  pattern: string;
  expectedTests: number;
}

const TIERS: TierConfig[] = [
  {
    id: 1,
    name: 'Tier 1: Feature Coverage (Isolation)',
    pattern: 'test/e2e/tier1-feature-coverage/*.test.ts',
    expectedTests: 36,
  },
  {
    id: 2,
    name: 'Tier 2: Boundary & Corner Cases',
    pattern: 'test/e2e/tier2-boundary-corners/*.test.ts',
    expectedTests: 32,
  },
  {
    id: 3,
    name: 'Tier 3: Cross-Feature Combinations',
    pattern: 'test/e2e/tier3-cross-feature/*.test.ts',
    expectedTests: 15,
  },
  {
    id: 4,
    name: 'Tier 4: Real-World Application Scenarios',
    pattern: 'test/e2e/tier4-real-world/*.test.ts',
    expectedTests: 12,
  },
];

interface TierResult {
  tier: TierConfig;
  passed: boolean;
  testsCount: number;
  passCount: number;
  failCount: number;
  durationMs: number;
  output: string;
}

function parseTapOutput(raw: string): { tests: number; pass: number; fail: number; durationMs: number } {
  let tests = 0;
  let pass = 0;
  let fail = 0;
  let durationMs = 0;

  const testsMatch = raw.match(/# tests\s+(\d+)/);
  if (testsMatch && testsMatch[1]) tests = parseInt(testsMatch[1], 10);

  const passMatch = raw.match(/# pass\s+(\d+)/);
  if (passMatch && passMatch[1]) pass = parseInt(passMatch[1], 10);

  const failMatch = raw.match(/# fail\s+(\d+)/);
  if (failMatch && failMatch[1]) fail = parseInt(failMatch[1], 10);

  const durationMatch = raw.match(/# duration_ms\s+([\d.]+)/);
  if (durationMatch && durationMatch[1]) durationMs = parseFloat(durationMatch[1]);

  return { tests, pass, fail, durationMs };
}

function runTier(tier: TierConfig): TierResult {
  const cmd = `node --experimental-strip-types --test ${tier.pattern}`;
  const start = Date.now();
  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = parseTapOutput(stdout);
    return {
      tier,
      passed: parsed.fail === 0 && parsed.pass > 0,
      testsCount: parsed.tests,
      passCount: parsed.pass,
      failCount: parsed.fail,
      durationMs: parsed.durationMs || (Date.now() - start),
      output: stdout,
    };
  } catch (err: any) {
    const stdout = (err.stdout?.toString() || '') + '\n' + (err.stderr?.toString() || '');
    const parsed = parseTapOutput(stdout);
    return {
      tier,
      passed: false,
      testsCount: parsed.tests,
      passCount: parsed.pass,
      failCount: Math.max(1, parsed.fail),
      durationMs: Date.now() - start,
      output: stdout,
    };
  }
}

function main() {
  console.log('\n' + '='.repeat(80));
  console.log('   P2Sharer E2E Test Suite Runner — 4-Tier Test Architecture');
  console.log('='.repeat(80) + '\n');

  const args = process.argv.slice(2);
  const tierArg = args.find((a) => a.startsWith('--tier='));
  let selectedTiers = TIERS;

  if (tierArg) {
    const tierNum = parseInt(tierArg.split('=')[1]!, 10);
    const filtered = TIERS.filter((t) => t.id === tierNum);
    if (filtered.length > 0) {
      selectedTiers = filtered;
      console.log(`[Runner] Filtered execution: Running Tier ${tierNum} only.\n`);
    } else {
      console.error(`[Runner] Unknown tier number: ${tierNum}. Running all tiers.\n`);
    }
  }

  const results: TierResult[] = [];
  let allPassed = true;
  let grandTotalTests = 0;
  let grandTotalPass = 0;
  let grandTotalFail = 0;
  const runnerStart = Date.now();

  for (const tier of selectedTiers) {
    process.stdout.write(`Executing ${tier.name}... `);
    const result = runTier(tier);
    results.push(result);

    grandTotalTests += result.testsCount;
    grandTotalPass += result.passCount;
    grandTotalFail += result.failCount;

    if (!result.passed) {
      allPassed = false;
      console.log(`[FAILED] (${(result.durationMs / 1000).toFixed(2)}s)`);
      console.log(`  Tests: ${result.testsCount}, Passed: ${result.passCount}, Failed: ${result.failCount}`);
    } else {
      console.log(`[PASSED] (${(result.durationMs / 1000).toFixed(2)}s) — ${result.passCount}/${result.testsCount} passed`);
    }
  }

  const grandTotalDuration = (Date.now() - runnerStart) / 1000;

  console.log('\n' + '-'.repeat(80));
  console.log('                           SUMMARY MATRIX');
  console.log('-'.repeat(80));
  console.log(
    'Tier                                      Status    Tests  Passed  Failed  Duration'
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    const statusStr = r.passed ? 'PASSED' : 'FAILED';
    const namePadded = r.tier.name.padEnd(41, ' ');
    const statusPadded = statusStr.padEnd(9, ' ');
    const testsPadded = String(r.testsCount).padStart(5, ' ');
    const passPadded = String(r.passCount).padStart(7, ' ');
    const failPadded = String(r.failCount).padStart(7, ' ');
    const durPadded = `${(r.durationMs / 1000).toFixed(2)}s`.padStart(9, ' ');

    console.log(`${namePadded} ${statusPadded} ${testsPadded} ${passPadded} ${failPadded} ${durPadded}`);
  }

  console.log('-'.repeat(80));
  console.log(
    `TOTALS                                              ${String(grandTotalTests).padStart(5, ' ')} ${String(grandTotalPass).padStart(7, ' ')} ${String(grandTotalFail).padStart(7, ' ')} ${grandTotalDuration.toFixed(2)}s`.padStart(80, ' ')
  );
  console.log('='.repeat(80));

  if (allPassed) {
    console.log(`\n🎉 ALL ${grandTotalTests} E2E TESTS PASSED CLEANLY (0 Failures)\n`);
    process.exit(0);
  } else {
    console.error(`\n❌ TEST SUITE FAILED: ${grandTotalFail} tests failed\n`);
    process.exit(1);
  }
}

main();
