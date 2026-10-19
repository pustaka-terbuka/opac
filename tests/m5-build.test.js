import fs from 'fs';
import path from 'path';
import vm from 'vm';
import test from 'node:test';
import assert from 'node:assert';
import { buildSite } from '../tools/lib/build.js';
import { recordToIso2709, iso2709ToRecord } from '../tools/lib/marc-iso2709.js';

const TEST_DIR = path.join(process.cwd(), 'tests', 'm5-tmp');
const DATA_DIR = path.join(TEST_DIR, 'data');
const DIST_DIR = path.join(TEST_DIR, 'dist');
const DUMPS_DIR = path.join(TEST_DIR, 'dumps');

function setupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(DATA_DIR, 'bib'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'holdings'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'orgs'), { recursive: true }); // Just in case
  
  // Orgs
  fs.writeFileSync(path.join(DATA_DIR, 'orgs.json'), JSON.stringify({
    "TEST1": { name: "Test Org 1", opac_url: "http://test1" }
  }));

  // Aliases
  fs.writeFileSync(path.join(DATA_DIR, 'aliases.jsonl'), JSON.stringify({ key: "OLD_ID", id: "REC1", type: "retired", ts: new Date().toISOString() }) + '\n');
  
  // Hostile Bib record
  const hostileXml = `<?xml version="1.0" encoding="UTF-8"?>
<marc:collection xmlns:marc="http://www.loc.gov/MARC21/slim">
  <marc:record>
    <marc:leader>00000nam a2200000 a 4500</marc:leader>
    <marc:controlfield tag="008">190102s2019    my |||||||||||||| ||eng d</marc:controlfield>
    <marc:datafield tag="245" ind1="1" ind2="0">
      <marc:subfield code="a">&lt;script&gt;alert('xss')&lt;/script&gt; :</marc:subfield>
    </marc:datafield>
    <marc:datafield tag="020" ind1=" " ind2=" ">
      <marc:subfield code="a">9781234567890</marc:subfield>
    </marc:datafield>
    <marc:datafield tag="022" ind1=" " ind2=" ">
      <marc:subfield code="a">0128-1232</marc:subfield>
    </marc:datafield>
    <marc:datafield tag="999" ind1=" " ind2=" ">
      <marc:subfield code="a">local data</marc:subfield>
    </marc:datafield>
  </marc:record>
</marc:collection>`;
  fs.mkdirSync(path.join(DATA_DIR, 'bib', 'RE'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'bib', 'RE', 'REC1.xml'), hostileXml);
  
  // Holdings
  fs.writeFileSync(path.join(DATA_DIR, 'holdings', 'REC1.json'), JSON.stringify([
    { org: "TEST1", call_number: "QA 76.9 .D3" }
  ]));
}

test('Build System Tests', async (t) => {
  setupTestDir();

  await t.test('1-6: Build and verify outputs', async () => {
    const report = await buildSite({
      dataDir: DATA_DIR,
      distDir: DIST_DIR,
      dumpsDir: DUMPS_DIR,
      baseUrl: '/',
      config: { sizeWarnMB: 10, sizeFailMB: 20 },
      isbnFetchFiles: true
    });
    
    assert.strictEqual(report.recordsProcessed, 1);
    assert.strictEqual(report.bookPages, 1);
    
    // Book pages
    const indexHtml = fs.readFileSync(path.join(DIST_DIR, 'book', 'REC1', 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;'), 'XSS must be escaped');
    assert.ok(indexHtml.includes('og:title'), 'Open Graph tags must be present');
    
    // Fetch files
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'id', 'REC1.xml')));
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'isbn', '9781234567890.xml')));
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'issn', '01281232.xml')));

    // Attribution verification in endpoint
    const idXml = fs.readFileSync(path.join(DIST_DIR, 'id', 'REC1.xml'), 'utf8');
    assert.ok(idXml.includes('PustakaTerbuka'), 'PustakaTerbuka attribution must be present');
    assert.ok(idXml.includes('https://github.com/pustaka-terbuka/opac'), 'GitHub link must be present in attribution');
    assert.ok(idXml.includes('tag="900"'), 'Custom tag 900 must be present');
    assert.ok(idXml.includes('tag="856"'), 'MARC 856 tag must be present');
    assert.ok(idXml.includes('tag="040"'), 'MARC 040 tag must be present');
    assert.ok(idXml.includes('code="d">PustakaTerbuka'), 'MARC 040 $d must credit PustakaTerbuka');
    
    // Org index
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'org', 'TEST1', 'index.json')));
    
    // Pagefind
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'pagefind', 'pagefind.js')));
    
    // Resolver
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'book', 'index.html')));
    const aliases = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'book', 'aliases.json'), 'utf8'));
    assert.strictEqual(aliases['OLD_ID'], 'REC1');
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'book', 'aliases')));
    let h = 2166136261;
    for (let i = 0; i < 'OLD_ID'.length; i++) h = Math.imul(h ^ 'OLD_ID'.charCodeAt(i), 16777619);
    const shardHex = ((h >>> 0) % 256).toString(16).padStart(2, '0');
    const shardData = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'book', 'aliases', `${shardHex}.json`), 'utf8'));
    assert.strictEqual(shardData['OLD_ID'], 'REC1');
    
    // Clean export
    const cleanXml = fs.readFileSync(path.join(DIST_DIR, 'export', 'REC1.xml'), 'utf8');
    assert.ok(!cleanXml.includes('999'), '99x fields must be stripped in exports');
    assert.ok(cleanXml.includes('tag="900"'), 'Attribution 900 tag preserved in clean export');
  });

  await t.test('7: Size gate fails', async () => {
    try {
      await buildSite({
        dataDir: DATA_DIR,
        distDir: DIST_DIR,
        dumpsDir: DUMPS_DIR,
        baseUrl: '/',
        config: { sizeWarnMB: 0, sizeFailMB: 0.0001 },
        isbnFetchFiles: true
      });
      assert.fail('Should have thrown size exception');
    } catch (e) {
      assert.match(e.message, /exceeds fail threshold/);
    }
  });

  await t.test('8: Incremental build is no-op', async () => {
    const bookFile = path.join(DIST_DIR, 'book', 'REC1', 'index.html');
    const mtimeBefore = fs.statSync(bookFile).mtimeMs;
    
    // Wait a bit
    await new Promise(r => setTimeout(r, 100));
    
    await buildSite({
      dataDir: DATA_DIR,
      distDir: DIST_DIR,
      dumpsDir: DUMPS_DIR,
      baseUrl: '/',
      config: { sizeWarnMB: 10, sizeFailMB: 20 },
      isbnFetchFiles: true
    });
    
    const mtimeAfter = fs.statSync(bookFile).mtimeMs;
    assert.strictEqual(mtimeAfter, mtimeBefore, 'Unchanged file should not be rewritten');
  });

  await t.test('9: ISO 2709 round-trip', async () => {
    const record = {
      leader: '00000nam a2200000 a 4500',
      controlFields: [
        { tag: '001', value: '12345' },
        { tag: '008', value: '190102s2019    my |||||||||||||| ||eng d' }
      ],
      dataFields: [
        {
          tag: '245',
          ind1: '1',
          ind2: '0',
          subfields: [
            { code: 'a', value: 'Test Title /' },
            { code: 'c', value: 'Author.' }
          ]
        }
      ]
    };
    
    const buf = recordToIso2709(record);
    const parsed = iso2709ToRecord(buf);
    
    assert.strictEqual(parsed.controlFields.length, 2);
    assert.strictEqual(parsed.controlFields[0].value, '12345');
    assert.strictEqual(parsed.dataFields.length, 1);
    assert.strictEqual(parsed.dataFields[0].subfields[0].value, 'Test Title /');
  });

  await t.test('10: Universal viewer script syntax validity', async () => {
    const bookHtmlPath = path.join(DIST_DIR, 'book', 'index.html');
    assert.ok(fs.existsSync(bookHtmlPath), 'book/index.html must exist');
    const html = fs.readFileSync(bookHtmlPath, 'utf8');
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'script tag must exist in book/index.html');
    assert.doesNotThrow(() => {
      new vm.Script(scriptMatch[1], { filename: 'book-viewer.js' });
    }, 'Viewer script must parse with no SyntaxError');
  });
});
