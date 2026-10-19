import fs from 'fs';
import path from 'path';
import { parse as parseMarc, serialize as serializeMarc, contentHash, getControlField, getDataFields, getSubfield, addDataField, cloneRecord } from './marcxml.js';
import { extractIsbns } from './isbn.js';
import { generateFallbackKey } from './fallback-key.js';
import { loadAliases, saveAliases, lookupId, addAlias, retireId, validateAliasTable } from './aliases.js';
import { loadManifest, saveManifest, hasChanged } from './manifest.js';
import { generateId, getShard } from './id-generator.js';

function getRecordScore(record, sourcePriority) {
  // a. Leader/17
  const leader17 = (record.leader && record.leader.length > 17) ? record.leader[17] : 'u';
  const encLevels = { ' ': 10, '1': 9, '2': 8, '3': 7, '4': 6, '5': 5, '7': 4, '8': 3, 'u': 2, 'z': 1 };
  const encScore = encLevels[leader17] || 0;

  // b. 040 $a DLC
  const f040 = getDataFields(record, '040');
  let dlcScore = 0;
  if (f040.length > 0) {
    const a = getSubfield(f040[0], 'a');
    if (a === 'DLC') dlcScore = 1;
  }

  // c. Source priority
  const prioScore = sourcePriority;

  // d. Richness (count of 050, 082, 650)
  const richness = getDataFields(record, '050').length + getDataFields(record, '082').length + getDataFields(record, '650').length;

  return { encScore, dlcScore, prioScore, richness };
}

function isStrictlyBetter(incScore, extScore) {
  if (incScore.encScore > extScore.encScore) return true;
  if (incScore.encScore < extScore.encScore) return false;

  if (incScore.dlcScore > extScore.dlcScore) return true;
  if (incScore.dlcScore < extScore.dlcScore) return false;

  if (incScore.prioScore < extScore.prioScore) return true; // Lower priority number is better
  if (incScore.prioScore > extScore.prioScore) return false;

  if (incScore.richness > extScore.richness) return true;
  if (incScore.richness < extScore.richness) return false;

  return false;
}

function mergeProvenanceAndIdentifiers(target, source) {
  // Preserve 035 and 996 from source into target
  const source035s = getDataFields(source, '035');
  const source996s = getDataFields(source, '996');

  // Check if they already exist in target
  const target035s = getDataFields(target, '035').map(f => getSubfield(f, 'a'));
  const target996s = getDataFields(target, '996').map(f => getSubfield(f, 'a'));

  for (const f of source035s) {
    const val = getSubfield(f, 'a');
    if (val && !target035s.includes(val)) {
      addDataField(target, cloneRecord({ dataFields: [f] }).dataFields[0]);
    }
  }

  for (const f of source996s) {
    const val = getSubfield(f, 'a');
    if (val && !target996s.includes(val)) {
      addDataField(target, cloneRecord({ dataFields: [f] }).dataFields[0]);
    }
  }

  // Preserve 952 (Koha local holdings) and 852 (MARC location/call number)
  const source952s = getDataFields(source, '952');
  const target952Barcodes = getDataFields(target, '952').map(f => getSubfield(f, 'p'));
  for (const f of source952s) {
    const barcode = getSubfield(f, 'p');
    if (!barcode || !target952Barcodes.includes(barcode)) {
      addDataField(target, cloneRecord({ dataFields: [f] }).dataFields[0]);
    }
  }

  const source852s = getDataFields(source, '852');
  const target852s = getDataFields(target, '852').map(f => (getSubfield(f, 'b') || '') + ':' + (getSubfield(f, 'h') || ''));
  for (const f of source852s) {
    const key = (getSubfield(f, 'b') || '') + ':' + (getSubfield(f, 'h') || '');
    if (!target852s.includes(key)) {
      addDataField(target, cloneRecord({ dataFields: [f] }).dataFields[0]);
    }
  }
}

function getExistingIds(aliasMap) {
  const ids = new Set();
  for (const entry of aliasMap.values()) {
    ids.add(entry.id);
  }
  return ids;
}

function toFallbackFormat(record) {
  const fields = [];
  if (record.controlFields) {
    for (const cf of record.controlFields) {
      fields.push({ [cf.tag]: cf.value });
    }
  }
  if (record.dataFields) {
    for (const df of record.dataFields) {
      const subfields = df.subfields ? df.subfields.map(sf => ({ [sf.code]: sf.value })) : [];
      fields.push({ [df.tag]: { ind1: df.ind1, ind2: df.ind2, subfields } });
    }
  }
  return { fields };
}

export async function mergeInbox(inboxPath, options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const sourcesPath = options.sourcesPath || path.join(process.cwd(), 'sources.json');
  const dryRun = options.dryRun || false;
  
  const report = {
    new: 0,
    updated: 0,
    unchanged: 0,
    mergedIntoExisting: 0,
    ambiguous: 0,
    errors: 0
  };

  const bibDir = path.join(dataDir, 'bib');
  const aliasesPath = path.join(dataDir, 'aliases.jsonl');
  let manifestPath = path.join(bibDir, 'manifest.json');
  if (!fs.existsSync(manifestPath) && fs.existsSync(manifestPath + '.gz')) {
    manifestPath = manifestPath + '.gz';
  }
  
  if (!fs.existsSync(bibDir) && !dryRun) {
    fs.mkdirSync(bibDir, { recursive: true });
  }

  const hasAliases = fs.existsSync(aliasesPath) || fs.existsSync(aliasesPath + '.gz');
  if (fs.existsSync(bibDir) && hasAliases) {
    const val = validateAliasTable(aliasesPath);
    if (!val.valid) {
      throw new Error(`Corrupt alias table: ${val.error}`);
    }
  } else if (fs.existsSync(bibDir) && fs.readdirSync(bibDir).some(f => {
    const stat = fs.statSync(path.join(bibDir, f));
    return stat.isDirectory() && f.length === 2; // Check for shards
  })) {
    if (!hasAliases) {
      throw new Error("Alias table missing but bib records exist.");
    }
  }

  const aliasMap = loadAliases(aliasesPath);
  const manifest = loadManifest(manifestPath);
  const existingIds = getExistingIds(aliasMap);
  
  let sources = {};
  if (fs.existsSync(sourcesPath)) {
    sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
  }

  const recordsDir = path.join(inboxPath, 'records');
  const files = fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir).filter(f => f.endsWith('.xml')) : [];

  let fileIndex = 0;
  const totalFiles = files.length;
  for (const file of files) {
    fileIndex++;
    if (fileIndex % 500 === 0 || fileIndex === totalFiles) {
      console.log(`[MERGE PROGRESS] ${fileIndex}/${totalFiles} files (${((fileIndex / totalFiles) * 100).toFixed(1)}%) - new: ${report.new}, unchanged: ${report.unchanged}, merged: ${report.mergedIntoExisting}, ambiguous: ${report.ambiguous}`);
    }
    const filePath = path.join(recordsDir, file);
    try {
      const xmlStr = fs.readFileSync(filePath, 'utf8');
      const records = parseMarc(xmlStr);
      
      for (const record of records) {
        // Extract identifiers
        const isbns = extractIsbns(record).map(i => i.isbn13); // isbn.js returns objects
        const fallbackKey = generateFallbackKey(toFallbackFormat(record));
        
        let sourceCode = 'unknown';
        const f996 = getDataFields(record, '996');
        if (f996.length > 0) {
          sourceCode = getSubfield(f996[0], 'a') || 'unknown';
        }
        if (sourceCode === 'unknown') {
          const f003 = getControlField(record, '003');
          if (f003 && sources[f003.toLowerCase()]) {
            sourceCode = f003.toLowerCase();
          } else if (f003 && sources[f003]) {
            sourceCode = f003;
          }
        }
        
        const sourceInfo = sources[sourceCode] || { prefix: 'UNK', priority: 999 };
        const raw001 = getControlField(record, '001');
        const id035 = raw001 ? `(${sourceInfo.prefix})${raw001}` : null;
        
        // Ensure the record has the proper 035 for its 001
        if (id035) {
          let has035 = false;
          for (const f of getDataFields(record, '035')) {
            if (getSubfield(f, 'a') === id035) has035 = true;
          }
          if (!has035) {
            addDataField(record, { tag: '035', ind1: ' ', ind2: ' ', subfields: [{ code: 'a', value: id035 }] });
          }
        }

        // Look up IDs
        const matchSet = new Set();
        if (id035) {
          const m = lookupId(aliasMap, `035:${id035}`);
          if (m) matchSet.add(m);
        }
        for (const isbn of isbns) {
          if (!isbn) continue;
          const m = lookupId(aliasMap, `isbn:${isbn}`);
          if (m) matchSet.add(m);
        }
        
        let fbMatch = null;
        if (fallbackKey) {
          const m = lookupId(aliasMap, `fb:${fallbackKey}`);
          if (m) fbMatch = m;
        }

        if (fbMatch) {
          matchSet.add(fbMatch);
        }

        if (matchSet.size > 1) {
          // Ambiguous
          report.ambiguous++;
          // Treat as a new record
          matchSet.clear();
        }

        let targetId = null;
        let isNew = false;

        if (matchSet.size === 1) {
          targetId = Array.from(matchSet)[0];
        } else {
          targetId = generateId(existingIds);
          existingIds.add(targetId);
          isNew = true;
        }

        let finalRecord = record;

        if (!isNew) {
          const shard = getShard(targetId);
          const targetPath = path.join(bibDir, shard, `${targetId}.xml`);
          let existingRecord = null;
          if (fs.existsSync(targetPath)) {
            existingRecord = parseMarc(fs.readFileSync(targetPath, 'utf8'))[0];
          }

          if (existingRecord) {
            const incScore = getRecordScore(record, sourceInfo.priority);
            
            // Reconstruct existing priority based on 996 or 003
            let extPriority = 999;
            const ext996 = getDataFields(existingRecord, '996');
            if (ext996.length > 0) {
               const extSource = getSubfield(ext996[0], 'a');
               if (sources[extSource]) extPriority = sources[extSource].priority;
            } else {
               const ext003 = getControlField(existingRecord, '003');
               if (ext003 && sources[ext003.toLowerCase()]) extPriority = sources[ext003.toLowerCase()].priority;
               else if (ext003 && sources[ext003]) extPriority = sources[ext003].priority;
            }
            const extScore = getRecordScore(existingRecord, extPriority);

            if (isStrictlyBetter(incScore, extScore)) {
              finalRecord = record;
              mergeProvenanceAndIdentifiers(finalRecord, existingRecord);
              // In this case, incoming is just update but might count as merged
              report.mergedIntoExisting++;
            } else {
              finalRecord = existingRecord;
              mergeProvenanceAndIdentifiers(finalRecord, record);
              report.mergedIntoExisting++; // Also merged
            }
          } else {
             // target path missing, treat as new but use the matched id
             isNew = true; 
          }
        }

        if (isNew && matchSet.size === 0) {
           report.new++;
        }

        const newHash = contentHash(finalRecord);
        if (!isNew && !hasChanged(manifest, targetId, newHash)) {
          // unchanged
          // Un-decrement mergedIntoExisting since it wasn't actually changed?
          // The prompt says "merged-into-existing, ambiguous". Let's say unchanged if hash is same.
          report.unchanged++;
          report.mergedIntoExisting--;
        } else {
           if (!dryRun) {
             const shard = getShard(targetId);
             const shardDir = path.join(bibDir, shard);
             if (!fs.existsSync(shardDir)) fs.mkdirSync(shardDir, { recursive: true });
             fs.writeFileSync(path.join(shardDir, `${targetId}.xml`), serializeMarc([finalRecord]), 'utf8');
             manifest[targetId] = newHash;
             
             // Update aliases
             if (id035) addAlias(aliasMap, `035:${id035}`, '035', targetId);
             for (const isbn of isbns) {
                if (isbn) addAlias(aliasMap, `isbn:${isbn}`, 'isbn', targetId);
             }
             if (fallbackKey) addAlias(aliasMap, `fb:${fallbackKey}`, 'fallback', targetId);
           }
        }
      }
    } catch (err) {
      console.error(`Error processing ${file}:`, err);
      report.errors++;
    }

    if (!dryRun && fileIndex % 2000 === 0) {
      saveAliases(aliasesPath, aliasMap);
      saveManifest(manifestPath, manifest);
      console.log(`[CHECKPOINT] Checkpointed aliases and manifest at file ${fileIndex}/${totalFiles}`);
    }
  }

  if (!dryRun) {
    saveAliases(aliasesPath, aliasMap);
    saveManifest(manifestPath, manifest);
  }

  return report;
}
