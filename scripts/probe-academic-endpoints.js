#!/usr/bin/env node

import { ACADEMIC_LIBRARIES } from '../tools/lib/academic-registry.js';

async function probeLibrary(lib) {
  const result = {
    code: lib.sourceCode,
    name: lib.shortName || lib.sourceName,
    opacUrl: lib.opacUrl,
    platform: lib.platform,
    status: null,
    finalUrl: null,
    catalogSystem: null,
    error: null
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const resp = await fetch(lib.opacUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(timeout);

    result.status = resp.status;
    result.finalUrl = resp.url;

    const html = await resp.text();
    if (html.includes('koha') || html.includes('opac-detail') || html.includes('Koha')) {
      result.catalogSystem = 'Koha';
    } else if (html.includes('ebsco') || html.includes('locate') || html.includes('eds')) {
      result.catalogSystem = 'EBSCO';
    } else if (html.includes('primo') || html.includes('exlibris')) {
      result.catalogSystem = 'Primo/Alma';
    } else if (html.includes('symphony') || html.includes('sirsi') || html.includes('enterprise')) {
      result.catalogSystem = 'SirsiDynix';
    } else if (html.includes('permata') || html.includes('marcPane')) {
      result.catalogSystem = 'PERMATA';
    } else {
      result.catalogSystem = 'Unknown / Custom Portal';
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

async function main() {
  console.log('Probing all 26 Academic Library Endpoints...\n');
  const results = [];
  for (const lib of ACADEMIC_LIBRARIES) {
    const res = await probeLibrary(lib);
    results.push(res);
    const statusStr = res.status ? `HTTP ${res.status}` : `ERR: ${res.error}`;
    console.log(`[${res.code.toUpperCase().padEnd(8)}] ${statusStr.padEnd(25)} | System: ${(res.catalogSystem || 'N/A').padEnd(15)} | ${res.name}`);
  }
}

main();
