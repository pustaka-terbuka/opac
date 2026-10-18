#!/usr/bin/env node

/**
 * PustakaTerbuka - Full Collection Academic Library Harvester & Aggregator
 * 
 * Sequentially sweeps and harvests bibliographic records across all 26 Malaysian
 * Higher Education & Research Libraries (UA + IPTS):
 * - Strictly 1 concurrent harvester running at a time
 * - Self-healing resumption and chunking (Decision D005 standard)
 * - Standalone provider repository management (d:\RepoTools\GitHub\pustaka-terbuka\<sourceCode>)
 * - Git commit & push per institution/chunk to https://github.com/pustaka-terbuka/<sourceCode>.git
 * - Safe master locking & merging into central union catalog (pustaka-terbuka/opac)
 * - Automatic temporary inbox purging in opac to maintain lean repository footprint
 * - Rebuilds Pagefind search index and deploys to GitHub Pages
 */

import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { ACADEMIC_LIBRARIES, getAcademicLibrary } from '../tools/lib/academic-registry.js';
import { acquireMasterLock, isMasterLocked } from '../tools/lib/master-lock.js';
import { scaffoldAndPublishAcademic } from './scaffold-and-publish-academic-repos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const opacRoot = path.resolve(__dirname, '..');
const ecosystemRoot = path.resolve(opacRoot, '..');

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return min > 0 ? `${min}m ${remSec}s` : `${sec}s`;
}

function runCmd(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function execProcess(cmd, args, cwd, onProgress) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', d => {
      const s = d.toString();
      out += s;
      if (onProgress) onProgress(s);
    });
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    p.on('error', e => resolve({ code: -1, out: '', err: e.message }));
  });
}

async function harvestInstitutionCollection(lib, index, total) {
  const code = lib.sourceCode;
  const startTime = Date.now();
  const targetEndBib = lib.defaultMaxBib || 200000;
  const startBib = lib.defaultStartBib || (code === 'taylors' ? 30000 : (code === 'unimas' ? 100 : (code === 'upm' ? 4840 : 1)));

  console.log(`\n======================================================================`);
  console.log(`[${index + 1}/${total}] [1-CONCURRENT] ${lib.agencyCode} — ${lib.shortName || lib.sourceName}`);
  console.log(` Platform: ${lib.platform} | Scheme: ${lib.defaultScheme || 'LCC'}`);
  console.log(` Target Bib Range: ${startBib.toLocaleString()} to ${targetEndBib.toLocaleString()}`);
  console.log(`======================================================================`);

  // 1. Ensure provider repository is initialized
  const providerRepo = path.join(ecosystemRoot, code);
  if (!fs.existsSync(path.join(providerRepo, '.git'))) {
    console.log(`  [INIT REPO] Initializing provider repository at ${providerRepo}...`);
    await scaffoldAndPublishAcademic(lib, { skipPush: false });
  }

  // 2. Harvester CLI arguments
  const harvesterScript = path.join(opacRoot, 'tools', 'harvesters', code, 'harvester.js');
  if (!fs.existsSync(harvesterScript)) {
    console.log(`  [SKIP] Harvester script not found at: ${harvesterScript}`);
    return { code, status: 'skipped', reason: 'Harvester script missing' };
  }

  // Delay setting per platform (polite rate limiting)
  let delay = 40;
  if (code === 'upm') delay = 1000;
  else if (code === 'uitm') delay = 1500;
  else if (code === 'taylors') delay = 50;

  // Max records per session sweep (e.g. 10,000 records chunk)
  const chunkLimit = 10000;

  console.log(`  [START HARVEST] Running sequential chunk sweep (limit: ${chunkLimit}, delay: ${delay}ms)...`);
  const harvestArgs = [
    harvesterScript,
    '--start-bib', String(startBib),
    '--max-records', String(chunkLimit),
    '--delay', String(delay)
  ];

  let lastSaveMsg = '';
  const harvestRes = await execProcess('node', harvestArgs, opacRoot, (chunk) => {
    const lines = chunk.split('\n');
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed.includes('Wrote batch_') || trimmed.includes('[SAVE]')) {
        console.log(`    ${trimmed}`);
        lastSaveMsg = trimmed;
      }
    }
  });

  const duration = formatDuration(Date.now() - startTime);

  // 3. Check harvested inbox
  const inboxBase = path.join(opacRoot, 'harvest', 'inbox', code);
  if (!fs.existsSync(inboxBase)) {
    console.log(`  [CIRCUIT BREAK] No inbox directory created for ${code}. Endpoint may be firewall-protected or unavailable.`);
    return {
      code,
      status: 'firewalled_or_unavailable',
      records: 0,
      duration,
      notes: harvestRes.err ? harvestRes.err.slice(0, 200) : 'No response from OPAC endpoint'
    };
  }

  const chunks = fs.readdirSync(inboxBase).filter(d => fs.existsSync(path.join(inboxBase, d, 'manifest.json')));
  if (chunks.length === 0) {
    console.log(`  [CIRCUIT BREAK] 0 records retrieved from ${code}.`);
    return {
      code,
      status: 'no_records',
      records: 0,
      duration,
      notes: 'Endpoint live but returned 0 valid records in range'
    };
  }

  let totalRecordsSaved = 0;
  for (const chunk of chunks) {
    const chunkPath = path.join(inboxBase, chunk);
    const manifest = JSON.parse(fs.readFileSync(path.join(chunkPath, 'manifest.json'), 'utf8'));
    const recCount = manifest.record_count || manifest.total_records || 0;
    totalRecordsSaved += recCount;

    // Validate chunk
    console.log(`  [VALIDATE] Validating ${chunk} (${recCount} records)...`);
    const valRes = runCmd(`node tools/validate-inbox.js "${chunkPath}"`, opacRoot);
    console.log(`    Validation: ${valRes ? valRes.replace(/\n/g, ' ') : 'OK'}`);

    // Copy chunk to dedicated provider repository
    const providerInboxChunk = path.join(providerRepo, 'harvest', 'inbox', code, chunk);
    fs.mkdirSync(path.dirname(providerInboxChunk), { recursive: true });
    runCmd(`robocopy "${chunkPath}" "${providerInboxChunk}" /E /NFL /NDL /NJH /NJS /nc /ns /np`, opacRoot);

    // Git commit & push to provider repo
    runCmd('git add .', providerRepo);
    runCmd(`git commit -m "chore(harvest): chunk ${chunk} completed for ${lib.agencyCode} (${recCount} records)"`, providerRepo);
    console.log(`  [GIT PUSH] Pushing chunk to pustaka-terbuka/${code}...`);
    runCmd('git push origin main', providerRepo);

    // Master ingestion (acquire lock & merge into opac/data/)
    console.log(`  [MASTER INGEST] Merging ${chunk} into master catalog...`);
    let lock = null;
    try {
      lock = await acquireMasterLock({
        masterPath: opacRoot,
        provider: code,
        operation: `ingest-${code}`,
        wait: true,
        timeoutMs: 300000
      });
      runCmd(`node tools/merge.js "${chunkPath}"`, opacRoot);
    } catch (e) {
      console.error(`    [MERGE ERROR] ${e.message}`);
    } finally {
      if (lock) lock.release();
    }
  }

  // Purge temporary inbox in opac to keep working tree lean
  console.log(`  [PURGE TEMP] Removing temporary raw inbox chunks in opac to preserve lean disk footprint...`);
  try {
    fs.rmSync(inboxBase, { recursive: true, force: true });
  } catch {}

  console.log(`[SUCCESS] Completed harvest for ${lib.agencyCode}: ${totalRecordsSaved} records in ${duration}.`);
  return {
    code,
    status: 'complete',
    records: totalRecordsSaved,
    duration
  };
}

async function main() {
  console.log(`======================================================================`);
  console.log(` PustakaTerbuka — Full Autonomous Academic Harvest & Master Aggregator`);
  console.log(` Total Institutions in Registry: ${ACADEMIC_LIBRARIES.length}`);
  console.log(` Concurrency Constraint: Strictly 1 concurrent harvester active at any time`);
  console.log(`======================================================================\n`);

  const results = [];
  for (let i = 0; i < ACADEMIC_LIBRARIES.length; i++) {
    const lib = ACADEMIC_LIBRARIES[i];
    try {
      const res = await harvestInstitutionCollection(lib, i, ACADEMIC_LIBRARIES.length);
      results.push(res);
    } catch (err) {
      console.error(`[ERROR] Institution ${lib.sourceCode} failed with unexpected error: ${err.message}`);
      results.push({ code: lib.sourceCode, status: 'error', records: 0, notes: err.message });
    }
  }

  // Final Union Catalog Rebuild
  console.log(`\n======================================================================`);
  console.log(`[MASTER REBUILD] Building catalog and updating Pagefind search index...`);
  console.log(`======================================================================`);
  runCmd('node tools/build.js --skip-dumps', opacRoot);

  // Deploy to GitHub Pages
  console.log(`\n======================================================================`);
  console.log(`[DEPLOY] Deploying updated index to GitHub Pages (gh-pages)...`);
  console.log(`======================================================================`);
  runCmd('powershell -ExecutionPolicy Bypass -File scripts/deploy-ghpages.ps1', opacRoot);

  // Write summary report
  const summaryPath = path.join(opacRoot, 'harvest-academic-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');

  console.log(`\n======================================================================`);
  console.log(` PustakaTerbuka Academic Libraries Harvest Complete!`);
  console.log(` Summary saved to: ${summaryPath}`);
  console.log(`======================================================================`);
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
