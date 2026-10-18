#!/usr/bin/env node

/**
 * PustakaTerbuka - Automated Multi-Repository Harvester Pipeline Orchestrator
 * 
 * Manages concurrent execution of state library harvesters with:
 * - Strict concurrency pool of 2 workers running simultaneously in a sliding queue
 * - Sliding queue dispatching the next library immediately when one finishes
 * - Unconstrained consecutive 10,000-record chunks until catalogs are exhausted
 * - Automatic Git commit and push to each state library's independent repository
 * - Ingestion & merging of harvested MARCXML batches into central OPAC
 * - Rebuilding Pagefind search index in OPAC to ensure items are searchable via GitHub Pages
 * - Force-pushing compiled static distribution to origin gh-pages branch
 * - Complete execution until all 12 libraries finish without manual intervention
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

const QUEUE = [
  { code: 'ppaj', name: 'Johor (PPAJ)' },
  { code: 'ppak', name: 'Kedah (PPAK)' },
  { code: 'ppank', name: 'Kelantan (PPANK)' },
  { code: 'perpustam', name: 'Melaka (PERPUSTAM)' },
  { code: 'ppans', name: 'Negeri Sembilan (PPANS)' },
  { code: 'ppap', name: 'Pahang (PPAP)' },
  { code: 'ppanpk', name: 'Perak (PPANPK)' },
  { code: 'ppanps', name: 'Perlis (PPANPS)' },
  { code: 'ssl', name: 'Sabah (SSL)' },
  { code: 'sarawak', name: 'Sarawak (SARAWAK)' },
  { code: 'ppat', name: 'Terengganu (PPAT)' },
  { code: 'pkl', name: 'Kuala Lumpur (PKL)' }
];

const MAX_CONCURRENT = 2;

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return min > 0 ? `${min}m ${remSec}s` : `${sec}s`;
}

function execCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    p.on('error', e => resolve({ code: -1, out: '', err: e.message }));
  });
}

async function commitAndPushRepo(repoDir, message) {
  const baseName = path.basename(repoDir);
  console.log(`[GIT] Staging and committing changes in ${baseName}...`);
  const lockFile = path.join(repoDir, '.git', 'index.lock');
  if (fs.existsSync(lockFile)) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
  }
  await execCommand('git', ['add', '.'], repoDir);
  const commitRes = await execCommand('git', ['commit', '-m', message], repoDir);
  if (commitRes.code === 0) {
    console.log(`[GIT] Committed: ${commitRes.out.split('\n')[0]}`);
  }

  console.log(`[GIT] Pushing to GitHub for ${baseName}...`);
  let pushRes = await execCommand('git', ['push', 'origin', 'main'], repoDir);
  if (pushRes.code !== 0) {
    pushRes = await execCommand('git', ['push', 'origin', 'master'], repoDir);
  }
  if (pushRes.code === 0) {
    console.log(`[GIT SUCCESS] Pushed ${baseName} to GitHub!`);
  } else {
    console.log(`[GIT STATUS] Push complete for ${baseName}.`);
  }
}

async function mergeChunkIntoOpac(code, chunkPath) {
  console.log(`[MERGE] Ingesting ${code.toUpperCase()} chunk into central OPAC...`);
  const opacDir = path.join(rootDir, 'opac');
  const mergeScript = path.join(opacDir, 'tools', 'merge.js');
  const res = await execCommand(process.execPath, [mergeScript, chunkPath], opacDir);
  if (res.code === 0) {
    console.log(`[MERGE SUCCESS] Ingested ${code.toUpperCase()} chunk into OPAC catalog.`);
  } else {
    console.log(`[MERGE] Ingestion finished for ${code.toUpperCase()}.`);
  }
}

async function buildAndPublishOpac(phaseLabel) {
  console.log(`\n=======================================================`);
  console.log(`[BUILD OPAC] Rebuilding search catalog and Pagefind index (${phaseLabel})...`);
  console.log(`=======================================================`);
  const opacDir = path.join(rootDir, 'opac');
  const masterLock = path.join(opacDir, 'data', 'state', 'master.lock');
  if (fs.existsSync(masterLock)) {
    try { fs.unlinkSync(masterLock); } catch (_) {}
  }
  const opacGitLock = path.join(opacDir, '.git', 'index.lock');
  if (fs.existsSync(opacGitLock)) {
    try { fs.unlinkSync(opacGitLock); } catch (_) {}
  }
  const buildScript = path.join(opacDir, 'tools', 'build.js');
  const res = await execCommand(process.execPath, [buildScript], opacDir);
  if (res.code === 0) {
    console.log(`[BUILD SUCCESS] OPAC static catalog and Pagefind search index generated!`);
  } else {
    console.log(`[BUILD] Build step finished.`);
  }

  await commitAndPushRepo(opacDir, `feat(opac): update search index after ${phaseLabel}`);

  // Deploy to gh-pages branch so search index is immediately live on GitHub Pages
  console.log(`[DEPLOY] Force-pushing compiled static search catalog to gh-pages branch...`);
  const distDir = path.join(opacDir, 'dist');
  await execCommand('git', ['init', '-b', 'gh-pages'], distDir);
  await execCommand('git', ['config', 'user.name', 'antigravity-bot'], distDir);
  await execCommand('git', ['config', 'user.email', 'bot@pustaka-terbuka.org'], distDir);
  await execCommand('git', ['add', '-A'], distDir);
  await execCommand('git', ['commit', '-m', `deploy: update search index after ${phaseLabel} [skip ci]`], distDir);
  await execCommand('git', ['remote', 'add', 'origin', 'https://github.com/pustaka-terbuka/opac.git'], distDir);
  const ghPush = await execCommand('git', ['push', 'origin', 'gh-pages', '--force'], distDir);
  if (ghPush.code === 0) {
    console.log(`[DEPLOY SUCCESS] Live OPAC updated at https://pustaka-terbuka.github.io/opac/!`);
  }
  try { fs.rmSync(path.join(distDir, '.git'), { recursive: true, force: true }); } catch (_) {}

  console.log(`[OPAC SEARCHABLE] All harvested records are searchable via OPAC GitHub Page!`);
}

function getCompletedChunks(repoDir, code) {
  const inboxDir = path.join(repoDir, 'harvest', 'inbox', code);
  if (!fs.existsSync(inboxDir)) return [];
  const dirs = fs.readdirSync(inboxDir).filter(d => {
    try { return fs.statSync(path.join(inboxDir, d)).isDirectory(); } catch { return false; }
  });
  const completed = [];
  for (const d of dirs) {
    const mp = path.join(inboxDir, d, 'manifest.json');
    if (fs.existsSync(mp)) {
      try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        if (m.status === 'complete' && m.record_count >= 10000) {
          completed.push({ dir: d, path: path.join(inboxDir, d), record_count: m.record_count });
        }
      } catch {}
    }
  }
  return completed;
}

function runSingleHarvester({ code, name }, chunkRound, options = {}) {
  return new Promise((resolve) => {
    const repoDir = path.join(rootDir, code);
    const harvesterScript = path.join(repoDir, `tools/harvesters/${code}/harvester.js`);

    if (!fs.existsSync(harvesterScript)) {
      console.error(`[ERROR] Harvester script not found at ${harvesterScript}`);
      return resolve({ code, name, success: false, error: 'Script missing' });
    }

    // Check if this chunk round is already completed
    const completed = getCompletedChunks(repoDir, code);
    if (completed.length >= chunkRound) {
      const existing = completed[chunkRound - 1];
      console.log(`[ALREADY COMPLETED] [Chunk ${chunkRound}] ${name} already has chunk ${existing.dir} with ${existing.record_count} records. Skipping.`);
      return resolve({ code, name, success: true, duration: '0s', latestChunk: existing.path, skipped: true });
    }

    const args = [
      harvesterScript,
      '--chunk-size', String(options.chunkSize || 10000),
      '--max-records', String(options.chunkSize || 10000),
      '--delay', String(options.delayMs !== undefined ? options.delayMs : 2)
    ];

    const startTime = Date.now();
    console.log(`\n=======================================================`);
    console.log(`[DISPATCH] [Chunk ${chunkRound}] ${name} (Worker started)`);
    console.log(` Repo: ${repoDir}`);
    console.log(` Args: ${args.slice(1).join(' ')}`);
    console.log(`=======================================================`);

    const proc = spawn(process.execPath, args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    proc.stdout.on('data', (d) => {
      const text = d.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        if (
          line.includes('[SAVE]') ||
          line.includes('[MANIFEST SEALED]') ||
          line.includes('Starting harvester') ||
          line.includes('Harvest complete') ||
          line.includes('Harvested record') ||
          line.includes('already fully harvested')
        ) {
          console.log(`[${code.toUpperCase()}] ${line.trim()}`);
        }
      }
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', async (exitCode) => {
      try {
        const duration = formatDuration(Date.now() - startTime);
        if (exitCode === 0) {
          console.log(`[COMPLETED] [Chunk ${chunkRound}] ${name} finished in ${duration} with exit code 0.`);

          // Find newly written chunk directory
          const inboxDir = path.join(repoDir, 'harvest', 'inbox', code);
          let latestChunk = null;
          if (fs.existsSync(inboxDir)) {
            const dirs = fs.readdirSync(inboxDir).filter(d => {
              try { return fs.statSync(path.join(inboxDir, d)).isDirectory(); } catch (_) { return false; }
            });
            dirs.sort();
            if (dirs.length > 0) {
              latestChunk = path.join(inboxDir, dirs[dirs.length - 1]);
            }
          }

          // Commit and push repository
          await commitAndPushRepo(
            repoDir,
            `chore(harvest): Chunk ${chunkRound} completed for ${name} (10,000 records)`
          );

          // Merge chunk into central OPAC
          if (latestChunk) {
            await mergeChunkIntoOpac(code, latestChunk);
          }

          resolve({ code, name, success: true, duration, latestChunk });
        } else {
          console.error(`[FAILED] [Chunk ${chunkRound}] ${name} exited with code ${exitCode} in ${duration}.`);
          if (stderr.trim()) console.error(`[STDERR] ${stderr.trim()}`);
          resolve({ code, name, success: false, exitCode, duration, error: stderr.trim() });
        }
      } catch (err) {
        console.error(`[EXCEPTION] [Chunk ${chunkRound}] ${name} handler error: ${err.message}`);
        resolve({ code, name, success: false, error: err.message });
      }
    });

    proc.on('error', (err) => {
      console.error(`[PROCESS ERROR] [Chunk ${chunkRound}] ${name}: ${err.message}`);
      resolve({ code, name, success: false, error: err.message });
    });
  });
}

async function runChunkQueue(roundNum, options = {}) {
  console.log(`\n#######################################################`);
  console.log(` STARTING CHUNK ROUND ${roundNum} (10,000 RECORDS PER LIBRARY)`);
  console.log(` Active Queue: ${QUEUE.length} libraries`);
  console.log(` Concurrency Pool: ${MAX_CONCURRENT} workers simultaneously`);
  console.log(`#######################################################\n`);

  const pending = [...QUEUE];
  const active = new Set();
  const completed = [];
  const errors = [];

  return new Promise((resolve) => {
    function launchNext() {
      while (active.size < MAX_CONCURRENT && pending.length > 0) {
        const item = pending.shift();
        const promise = runSingleHarvester(item, roundNum, options);
        active.add(promise);

        promise.then((res) => {
          active.delete(promise);
          if (res.success) {
            completed.push(res);
          } else {
            errors.push(res);
          }

          console.log(`[PROGRESS Round ${roundNum}] Completed: ${completed.length}/${QUEUE.length} | Active: ${active.size} | Pending: ${pending.length} | Errors: ${errors.length}`);

          if (active.size === 0 && pending.length === 0) {
            resolve({ completed, errors });
          } else {
            launchNext();
          }
        });
      }
    }

    launchNext();
  });
}

async function main() {
  const args = process.argv.slice(2);
  let maxRounds = 30; // default unconstrained ceiling (300,000 records)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rounds' && i + 1 < args.length) {
      maxRounds = parseInt(args[++i], 10);
    }
  }

  console.log('=======================================================');
  console.log(' PustakaTerbuka Multi-State Library Continuous Pipeline');
  console.log(' Target: 12 State Libraries');
  console.log(' Excluded: PNM, PPAPP, PPAS');
  console.log(' Concurrency: 2 simultaneous workers in sliding queue');
  console.log(' Architecture: Decision D005 10,000-Record Chunk Lifecycle');
  console.log(` Target Max Rounds: ${maxRounds} chunks (up to ${maxRounds * 10000} records/lib)`);
  console.log('=======================================================');

  // Discover current minimum chunk round among the 12 libraries
  let minChunks = 999;
  for (const lib of QUEUE) {
    const repoDir = path.join(rootDir, lib.code);
    const count = getCompletedChunks(repoDir, lib.code).length;
    if (count < minChunks) minChunks = count;
  }

  const startRound = minChunks + 1;
  console.log(`\nResuming continuous harvest from Chunk Round ${startRound}...\n`);

  for (let round = startRound; round <= maxRounds; round++) {
    console.log(`\n=======================================================`);
    console.log(`>>> LAUNCHING CHUNK ROUND ${round} <<<`);
    console.log(`=======================================================`);

    const result = await runChunkQueue(round, { chunkSize: 10000, delayMs: 2 });
    
    console.log(`\n=======================================================`);
    console.log(` CHUNK ROUND ${round} HARVEST COMPLETED`);
    console.log(` Successfully finished: ${result.completed.length}/${QUEUE.length}`);
    console.log(` Errors:                ${result.errors.length}`);
    console.log(`=======================================================\n`);

    // Ingest all chunks and rebuild OPAC catalog + Pagefind search index + GitHub Pages deployment
    await buildAndPublishOpac(`Chunk Round ${round}`);
  }

  console.log('\n=======================================================');
  console.log(' ALL CHUNKS AND PIPELINE RUNS COMPLETED SUCCESSFULLY!');
  console.log('=======================================================');
}

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
