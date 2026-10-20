function getBaseUrl() {
  const path = window.location.pathname;
  if (path.includes('/opac')) return '/opac/';
  if (path.includes('/master')) return '/master/';
  if (path.includes('/pustaka-terbuka')) return '/pustaka-terbuka/';
  if (window.location.hostname.endsWith('github.io')) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 0) return `/${parts[0]}/`;
  }
  return '/';
}
const BASE_URL = getBaseUrl();
let i18n = {};
let currentLang = 'en';
let pagefind = null;
let currentOrg = null;
let currentDdc = '';
let currentSearchField = 'all'; // 'all', 'title', 'author', 'subject', 'isbn', 'call'
let currentSort = 'relevance'; // 'relevance', 'year-desc', 'year-asc', 'title-asc'
let searchDebounceTimer = null;
let searchSequenceToken = 0;
const resultDataCache = new Map();
let lastSearchTimeMs = 0;
let orgsData = {};
let orgHoldingsMap = {}; // recordId -> { call_number }
let basket = new Set(); // Set of recordIds

// Pagination state
let currentSearchResults = [];
let currentPage = 1;
const PAGE_SIZE = 10;
let currentQuery = '';

/* ==========================================================================
   IndexedDB Offline & Caching Layer (PustakaDB)
   ========================================================================== */
const PustakaDB = (() => {
  const DB_NAME = 'pustaka-opac-db';
  const DB_VERSION = 1;
  const STORES = ['records', 'shards', 'orgs', 'queries'];
  let dbPromise = null;

  function isAvailable() {
    return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
  }

  function getDB() {
    if (!isAvailable()) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = window.indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            for (const store of STORES) {
              if (!db.objectStoreNames.contains(store)) {
                db.createObjectStore(store, { keyPath: 'key' });
              }
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => {
            console.warn('[PustakaDB] IndexedDB error, fallback to memory/network');
            resolve(null);
          };
        } catch (err) {
          console.warn('[PustakaDB] IndexedDB unavailable:', err);
          resolve(null);
        }
      });
    }
    return dbPromise;
  }

  async function get(storeName, key) {
    const db = await getDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result && req.result.data !== undefined) {
            resolve(req.result.data);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function set(storeName, key, data, ttlMs = 86400000) {
    const db = await getDB();
    if (!db) return;
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put({ key, data, expiresAt: Date.now() + ttlMs, cachedAt: Date.now() });
    } catch (e) {
      // Graceful ignore
    }
  }

  async function getWithExpiry(storeName, key) {
    const db = await getDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => {
          const item = req.result;
          if (item && item.data !== undefined) {
            const isExpired = item.expiresAt && Date.now() > item.expiresAt;
            resolve({ data: item.data, isExpired });
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function cachedFetchJson(url, storeName, key, ttlMs = 86400000) {
    const cached = await getWithExpiry(storeName, key);
    if (cached && !cached.isExpired) {
      return cached.data;
    }

    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        set(storeName, key, data, ttlMs).catch(() => {});
        return data;
      }
    } catch (err) {
      console.warn(`[PustakaDB] Network fetch error for ${url}:`, err.message);
      if (cached && cached.data) return cached.data;
      throw err;
    }
    if (cached && cached.data) return cached.data;
    return null;
  }

  async function cachedFetchText(url, storeName, key, ttlMs = 86400000) {
    const cached = await getWithExpiry(storeName, key);
    if (cached && !cached.isExpired) {
      return cached.data;
    }

    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        set(storeName, key, text, ttlMs).catch(() => {});
        return text;
      }
    } catch (err) {
      console.warn(`[PustakaDB] Network fetch error for ${url}:`, err.message);
      if (cached && cached.data) return cached.data;
      throw err;
    }
    if (cached && cached.data) return cached.data;
    return null;
  }

  async function clearCache() {
    const db = await getDB();
    if (!db) return;
    for (const storeName of STORES) {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
      } catch (e) {}
    }
  }

  async function getStorageStats() {
    const db = await getDB();
    if (!db) return { supported: false, records: 0, orgs: 0, shards: 0, queries: 0, bytes: 0 };
    return new Promise(async (resolve) => {
      try {
        const tx = db.transaction(STORES, 'readonly');
        let records = 0, orgs = 0, shards = 0, queries = 0;
        
        tx.objectStore('records').count().onsuccess = (e) => { records = e.target.result; };
        tx.objectStore('orgs').count().onsuccess = (e) => { orgs = e.target.result; };
        tx.objectStore('shards').count().onsuccess = (e) => { shards = e.target.result; };
        tx.objectStore('queries').count().onsuccess = (e) => { queries = e.target.result; };

        let estimatedBytes = 0;
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
          try {
            const estimate = await navigator.storage.estimate();
            estimatedBytes = estimate.usage || 0;
          } catch (e) {}
        }

        tx.oncomplete = () => {
          resolve({
            supported: true,
            records,
            orgs,
            shards,
            queries,
            totalItems: records + orgs + shards + queries,
            bytes: estimatedBytes
          });
        };
        tx.onerror = () => resolve({ supported: true, records: 0, orgs: 0, shards: 0, queries: 0, bytes: 0 });
      } catch (err) {
        resolve({ supported: false, records: 0, orgs: 0, shards: 0, queries: 0, bytes: 0 });
      }
    });
  }

  return {
    isAvailable,
    get,
    set,
    cachedFetchJson,
    cachedFetchText,
    clearCache,
    getStorageStats
  };
})();
if (typeof window !== 'undefined') {
  window.PustakaDB = PustakaDB;
}

async function getResultData(res) {
  if (resultDataCache.has(res.id)) {
    return resultDataCache.get(res.id);
  }
  const cached = await PustakaDB.get('records', res.id);
  if (cached) {
    resultDataCache.set(res.id, cached);
    return cached;
  }
  const data = await res.data();
  resultDataCache.set(res.id, data);
  PustakaDB.set('records', res.id, data, 7 * 86400000).catch(() => {});
  return data;
}

function extractSearchIsbn(text) {
  if (!text) return null;
  const match = text.match(/([\d\-\sX]{9,})/i);
  if (!match) return null;
  const clean = match[1].replace(/[-\s]/g, '').toUpperCase();
  if (clean.length === 10 || clean.length === 13) {
    return clean;
  }
  return null;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* Theme Management (Light / Dark Mode) */
function initTheme() {
  const savedTheme = localStorage.getItem('pustaka-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  applyTheme(initialTheme);

  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('pustaka-theme', next);
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

/* Localization */
async function loadI18n(lang) {
  try {
    const res = await fetch(`${BASE_URL}i18n/${lang}.json`);
    if (!res.ok) throw new Error('Network response was not ok');
    i18n = await res.json();
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (i18n[key]) {
        el.textContent = i18n[key];
      }
    });

    const searchInput = document.getElementById('search-input');
    if (searchInput && i18n['search_placeholder']) {
      searchInput.placeholder = i18n['search_placeholder'];
    }

    const fieldSelect = document.getElementById('search-field');
    if (fieldSelect) {
      fieldSelect.querySelectorAll('option').forEach(opt => {
        const key = opt.getAttribute('data-i18n');
        if (key && i18n[key]) opt.textContent = i18n[key];
      });
    }

    const sortSelect = document.getElementById('sort-filter');
    if (sortSelect) {
      sortSelect.querySelectorAll('option').forEach(opt => {
        const key = opt.getAttribute('data-i18n');
        if (key && i18n[key]) opt.textContent = i18n[key];
      });
    }
    
    const btn = document.getElementById('download-basket-btn');
    if (btn && i18n['download_basket']) {
      btn.textContent = i18n['download_basket'];
    }

    renderActiveFilters();
  } catch (err) {
    console.error('Failed to load i18n', err);
  }
}

function updateLangSelect() {
  const select = document.getElementById('lang-select');
  if (select) {
    select.value = currentLang;
    select.addEventListener('change', (e) => {
      const newLang = e.target.value;
      const url = new URL(window.location);
      url.searchParams.set('lang', newLang);
      window.history.pushState({}, '', url);
      currentLang = newLang;
      document.documentElement.lang = currentLang;
      loadI18n(currentLang);
    });
  }
}

/* ==========================================================================
   Organization State & Enhanced Combobox Management
   ========================================================================== */
let orgFilterCounts = {}; // orgCode -> record count
let allOrgListItems = [];
let activeOrgTypeFilter = 'all';
let orgComboboxSearchQuery = '';
let currentShelfScheme = 'DDC';
let shelfBrowseDataCache = {};

function getSectorTitle(type) {
  switch (type) {
    case 'public': return i18n['org_tab_public'] || 'Perpustakaan Awam & Negeri';
    case 'university': return i18n['org_tab_university'] || 'Perpustakaan Universiti & Kolej';
    case 'special': return i18n['org_tab_special'] || 'Perpustakaan Khusus & Agensi';
    case 'school': return i18n['org_tab_school'] || 'Perpustakaan Sekolah';
    default: return i18n['organization'] || 'Organisasi';
  }
}

function updateOrgComboboxUI(selectedOrg) {
  const triggerLabel = document.getElementById('org-trigger-label');
  const triggerBadge = document.getElementById('org-trigger-count-badge');
  const triggerBtn = document.getElementById('org-combobox-trigger');

  if (!selectedOrg) {
    if (triggerLabel) triggerLabel.textContent = i18n['all_organizations'] || 'Semua Organisasi';
    if (triggerBadge) triggerBadge.style.display = 'none';
    if (triggerBtn) triggerBtn.setAttribute('title', i18n['all_organizations'] || 'Semua Organisasi');
    return;
  }

  const orgInfo = orgsData[selectedOrg];
  const count = orgFilterCounts[selectedOrg] || 0;
  const displayName = orgInfo?.name ? `${orgInfo.name} (${selectedOrg})` : selectedOrg;

  if (triggerLabel) triggerLabel.textContent = displayName;
  if (triggerBtn) triggerBtn.setAttribute('title', displayName);

  if (triggerBadge) {
    if (count > 0) {
      triggerBadge.textContent = `${count.toLocaleString()}`;
      triggerBadge.style.display = 'inline-block';
    } else {
      triggerBadge.style.display = 'none';
    }
  }
}

async function updateStorageStatusUI() {
  const textEl = document.getElementById('storage-status-text');
  const clearBtn = document.getElementById('storage-clear-btn');
  if (!textEl) return;

  const stats = await PustakaDB.getStorageStats();
  if (!stats.supported) {
    textEl.textContent = 'Storan Pelayar: Mod Memori';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }

  const mb = stats.bytes > 0 ? ` (${(stats.bytes / (1024 * 1024)).toFixed(1)} MB)` : '';
  textEl.textContent = `Storan Luar Talian: ${stats.records} rekod, ${stats.orgs} indeks${mb}`;

  if (clearBtn && !clearBtn._attached) {
    clearBtn._attached = true;
    clearBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await PustakaDB.clearCache();
      resultDataCache.clear();
      shelfBrowseDataCache = {};
      orgHoldingsMap = {};
      await updateStorageStatusUI();
      const toast = document.getElementById('modal-toast');
      if (toast) {
        toast.textContent = '✓ Storan luar talian dikosongkan!';
        toast.style.display = 'inline-block';
        setTimeout(() => { toast.style.display = 'none'; }, 2200);
      }
    });
  }
}

async function loadOrgs() {
  try {
    try {
      const data = await PustakaDB.cachedFetchJson(`${BASE_URL}orgs.json`, 'orgs', 'registry', 86400000);
      if (data) orgsData = data;
    } catch (e) {
      console.warn('Could not load orgs.json:', e);
    }

    let filters = null;
    if (pagefind) {
      try {
        filters = await pagefind.filters();
      } catch (e) {}
    }

    orgFilterCounts = {};
    if (filters && filters.organization) {
      for (const [code, count] of Object.entries(filters.organization)) {
        orgFilterCounts[code] = Number(count) || 0;
      }
    }

    const select = document.getElementById('org-filter');
    if (!select) return;

    // Reset native options except the first "Semua Organisasi"
    while (select.options.length > 1) {
      select.remove(1);
    }

    const allOrgCodes = new Set();
    Object.keys(orgsData).forEach(code => allOrgCodes.add(code));
    Object.keys(orgFilterCounts).forEach(code => allOrgCodes.add(code));

    allOrgListItems = Array.from(allOrgCodes).map(code => {
      const data = orgsData[code] || {};
      return {
        code,
        name: data.name || code,
        type: data.type || 'public',
        state: data.state || '',
        default_scheme: data.default_scheme || 'DDC',
        opac_url: data.opac_url || '',
        contact: data.contact || '',
        count: orgFilterCounts[code] || 0
      };
    });

    // Partition: Active collections first (with record count), followed by categories
    const activeOrgs = allOrgListItems.filter(item => item.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const publicOrgs = allOrgListItems.filter(item => item.type === 'public' && item.count === 0).sort((a, b) => a.name.localeCompare(b.name));
    const uniOrgs = allOrgListItems.filter(item => item.type === 'university' && item.count === 0).sort((a, b) => a.name.localeCompare(b.name));
    const specialOrgs = allOrgListItems.filter(item => item.type === 'special' && item.count === 0).sort((a, b) => a.name.localeCompare(b.name));
    const schoolOrgs = allOrgListItems.filter(item => item.type === 'school' && item.count === 0).sort((a, b) => a.name.localeCompare(b.name));

    // Populate native <select> with categorized <optgroup>s (keeps automated tests & accessibility 100% working)
    if (activeOrgs.length > 0) {
      const groupActive = document.createElement('optgroup');
      groupActive.label = `⭐ ${i18n['org_tab_active'] || 'Perpustakaan Berpenyertaan Aktif (Ada Koleksi)'}`;
      for (const item of activeOrgs) {
        const opt = document.createElement('option');
        opt.value = item.code;
        opt.textContent = `${item.name} (${item.code}) — ${item.count.toLocaleString()} rekod`;
        groupActive.appendChild(opt);
      }
      select.appendChild(groupActive);
    }

    const sectorGroups = [
      { label: i18n['org_tab_public'] || 'Perpustakaan Awam & Negeri', items: publicOrgs },
      { label: i18n['org_tab_university'] || 'Perpustakaan Universiti & Kolej', items: uniOrgs },
      { label: i18n['org_tab_special'] || 'Perpustakaan Khusus & Agensi', items: specialOrgs },
      { label: i18n['org_tab_school'] || 'Perpustakaan Sekolah', items: schoolOrgs }
    ];

    for (const sec of sectorGroups) {
      if (sec.items.length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = sec.label;
        for (const item of sec.items) {
          const opt = document.createElement('option');
          opt.value = item.code;
          const statusText = item.count > 0 ? `${item.count.toLocaleString()} rekod` : (i18n['org_in_progress'] || 'Rakan Kongsi');
          opt.textContent = `${item.name} (${item.code}) — ${statusText}`;
          grp.appendChild(opt);
        }
        select.appendChild(grp);
      }
    }

    // Initialize custom combobox UI
    setupOrgCombobox();

    // Check URL query param ?org=
    const urlParams = new URLSearchParams(window.location.search);
    const urlOrg = urlParams.get('org');
    if (urlOrg && allOrgCodes.has(urlOrg)) {
      select.value = urlOrg;
      currentOrg = urlOrg;
      updateOrgComboboxUI(urlOrg);
    }

    if (!select._listenerAttached) {
      select._listenerAttached = true;
      select.addEventListener('change', async (e) => {
        const val = e.target.value;
        const url = new URL(window.location);
        if (val) {
          url.searchParams.set('org', val);
        } else {
          url.searchParams.delete('org');
        }
        window.history.pushState({}, '', url);
        updateOrgComboboxUI(val);
        await onOrgChange(val);
      });
    }

    if (urlOrg) {
      await onOrgChange(urlOrg);
    }
  } catch (err) {
    console.error('Failed to load orgs:', err);
  }
}

function setupOrgCombobox() {
  const trigger = document.getElementById('org-combobox-trigger');
  const dropdown = document.getElementById('org-combobox-dropdown');
  const searchInput = document.getElementById('org-dropdown-search');
  const clearSearchBtn = document.getElementById('org-search-clear-btn');
  const typeTabsContainer = document.getElementById('org-type-tabs');
  const resetBtn = document.getElementById('org-dropdown-reset-btn');
  const select = document.getElementById('org-filter');

  if (!trigger || !dropdown) return;

  function openDropdown() {
    dropdown.style.display = 'flex';
    trigger.setAttribute('aria-expanded', 'true');
    renderOrgComboboxList();
    if (searchInput) {
      setTimeout(() => searchInput.focus(), 50);
    }
  }

  function closeDropdown() {
    dropdown.style.display = 'none';
    trigger.setAttribute('aria-expanded', 'false');
  }

  function toggleDropdown() {
    if (dropdown.style.display === 'none' || !dropdown.style.display) {
      openDropdown();
    } else {
      closeDropdown();
    }
  }

  if (!trigger._attached) {
    trigger._attached = true;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });
  }

  if (searchInput && !searchInput._attached) {
    searchInput._attached = true;
    searchInput.addEventListener('input', (e) => {
      orgComboboxSearchQuery = e.target.value.trim().toLowerCase();
      if (clearSearchBtn) {
        clearSearchBtn.style.display = orgComboboxSearchQuery ? 'inline-block' : 'none';
      }
      renderOrgComboboxList();
    });
  }

  if (clearSearchBtn && !clearSearchBtn._attached) {
    clearSearchBtn._attached = true;
    clearSearchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      orgComboboxSearchQuery = '';
      clearSearchBtn.style.display = 'none';
      renderOrgComboboxList();
    });
  }

  if (typeTabsContainer && !typeTabsContainer._attached) {
    typeTabsContainer._attached = true;
    typeTabsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.org-type-tab');
      if (!btn) return;
      typeTabsContainer.querySelectorAll('.org-type-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeOrgTypeFilter = btn.getAttribute('data-type') || 'all';
      renderOrgComboboxList();
    });
  }

  if (resetBtn && !resetBtn._attached) {
    resetBtn._attached = true;
    resetBtn.addEventListener('click', () => {
      if (select) {
        select.value = '';
        select.dispatchEvent(new Event('change'));
      }
      closeDropdown();
    });
  }

  // Dismiss dropdown on click outside or Escape key
  if (!document._orgComboboxDismissAttached) {
    document._orgComboboxDismissAttached = true;
    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('org-combobox-wrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        closeDropdown();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dropdown.style.display !== 'none') {
        closeDropdown();
        trigger.focus();
      }
    });
  }

  renderOrgComboboxList();
}

function renderOrgComboboxList() {
  const listContainer = document.getElementById('org-dropdown-list');
  const countInfo = document.getElementById('org-dropdown-count-info');
  const select = document.getElementById('org-filter');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  const q = orgComboboxSearchQuery;
  const typeFilter = activeOrgTypeFilter;

  // Filter items by type and search query
  const filtered = allOrgListItems.filter(item => {
    if (typeFilter === 'active' && item.count === 0) return false;
    if (typeFilter !== 'all' && typeFilter !== 'active' && item.type !== typeFilter) return false;

    if (q) {
      const matchCode = item.code.toLowerCase().includes(q);
      const matchName = item.name.toLowerCase().includes(q);
      const matchState = item.state.toLowerCase().includes(q);
      const matchType = item.type.toLowerCase().includes(q);
      let matchAlias = false;
      if (q.includes('penang') && item.state.toLowerCase().includes('pulau pinang')) matchAlias = true;
      if (q.includes('malacca') && item.state.toLowerCase().includes('melaka')) matchAlias = true;
      if (q.includes('kl') && item.state.toLowerCase().includes('kuala lumpur')) matchAlias = true;
      return matchCode || matchName || matchState || matchType || matchAlias;
    }
    return true;
  });

  if (countInfo) {
    const template = i18n['org_showing_count'] || 'Memaparkan {0} daripada {1} perpustakaan';
    countInfo.textContent = template.replace('{0}', filtered.length).replace('{1}', allOrgListItems.length);
  }

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div class="org-dropdown-empty">
        <p>Tiada perpustakaan sepadan dengan carian "<strong>${escapeHTML(q)}</strong>".</p>
      </div>
    `;
    return;
  }

  // Option for "Semua Organisasi" (at top of list if no search query)
  if (!q && (typeFilter === 'all' || typeFilter === 'active')) {
    const allOpt = document.createElement('div');
    allOpt.className = 'org-option-item' + (!currentOrg ? ' is-selected' : '');
    allOpt.innerHTML = `
      <div class="org-option-content">
        <div class="org-option-title-row">
          <span class="org-option-name"><strong>${escapeHTML(i18n['all_organizations'] || 'Semua Organisasi')}</strong></span>
        </div>
        <div class="org-option-meta-row">
          <span>Katalog Induk Terbuka Kebangsaan</span>
        </div>
      </div>
      <div class="org-option-badges">
        <span class="org-badge-count-pill">Semua</span>
      </div>
    `;
    allOpt.onclick = () => {
      if (select) {
        select.value = '';
        select.dispatchEvent(new Event('change'));
      }
      const dropdown = document.getElementById('org-combobox-dropdown');
      if (dropdown) dropdown.style.display = 'none';
    };
    listContainer.appendChild(allOpt);
  }

  // Group items by category if no search query, or flat list if searching
  if (!q && typeFilter === 'all') {
    const active = filtered.filter(x => x.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const publicList = filtered.filter(x => x.type === 'public' && x.count === 0).sort((a, b) => a.name.localeCompare(b.name));
    const uniList = filtered.filter(x => x.type === 'university' && x.count === 0).sort((a, b) => a.name.localeCompare(b.name));
    const specList = filtered.filter(x => x.type === 'special' && x.count === 0).sort((a, b) => a.name.localeCompare(b.name));
    const schoolList = filtered.filter(x => x.type === 'school' && x.count === 0).sort((a, b) => a.name.localeCompare(b.name));

    const groups = [
      { header: `⭐ ${i18n['org_tab_active'] || 'Perpustakaan Berpenyertaan Aktif (Ada Koleksi)'}`, items: active },
      { header: i18n['org_tab_public'] || 'Perpustakaan Awam & Negeri', items: publicList },
      { header: i18n['org_tab_university'] || 'Perpustakaan Universiti & Kolej', items: uniList },
      { header: i18n['org_tab_special'] || 'Perpustakaan Khusus & Agensi', items: specList },
      { header: i18n['org_tab_school'] || 'Perpustakaan Sekolah', items: schoolList }
    ];

    for (const g of groups) {
      if (g.items.length === 0) continue;
      const h = document.createElement('div');
      h.className = 'org-group-header';
      h.innerHTML = `<span>${escapeHTML(g.header)}</span><span>${g.items.length}</span>`;
      listContainer.appendChild(h);

      for (const item of g.items) {
        listContainer.appendChild(createOrgOptionElement(item));
      }
    }
  } else {
    const sorted = filtered.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    for (const item of sorted) {
      listContainer.appendChild(createOrgOptionElement(item));
    }
  }
}

function createOrgOptionElement(item) {
  const el = document.createElement('div');
  const isSelected = currentOrg === item.code;
  el.className = 'org-option-item' + (isSelected ? ' is-selected' : '');

  const countBadgeHtml = item.count > 0
    ? `<span class="org-badge-count-pill">${item.count.toLocaleString()} rekod</span>`
    : `<span class="org-badge-count-pill is-zero">${escapeHTML(i18n['org_in_progress'] || 'Rakan Kongsi')}</span>`;

  const stateHtml = item.state ? `<span class="org-badge-state">📍 ${escapeHTML(item.state)}</span>` : '';
  const typeLabel = getSectorTitle(item.type);

  el.innerHTML = `
    <div class="org-option-content">
      <div class="org-option-title-row">
        <span class="org-option-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</span>
      </div>
      <div class="org-option-meta-row">
        <span>${escapeHTML(typeLabel)}</span>
        ${stateHtml ? '<span>•</span> ' + stateHtml : ''}
      </div>
    </div>
    <div class="org-option-badges">
      <span class="org-badge-code">${escapeHTML(item.code)}</span>
      ${countBadgeHtml}
    </div>
  `;

  // Predictive prefetch of org holdings when hovered
  el.addEventListener('pointerenter', () => {
    if (item.code && item.count > 0) {
      PustakaDB.cachedFetchJson(`${BASE_URL}org/${item.code}/index.json`, 'orgs', `holdings:${item.code}`).catch(() => {});
    }
  }, { once: true });

  el.onclick = () => {
    const select = document.getElementById('org-filter');
    if (select) {
      select.value = item.code;
      select.dispatchEvent(new Event('change'));
    }
    const dropdown = document.getElementById('org-combobox-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  };

  return el;
}

async function onOrgChange(org) {
  currentOrg = org;
  orgHoldingsMap = {};
  updateOrgComboboxUI(org);

  const banner = document.getElementById('org-profile-banner');
  const shelfDrawer = document.getElementById('org-shelf-drawer');

  if (shelfDrawer) {
    shelfDrawer.style.display = 'none';
  }

  if (org) {
    const orgInfo = orgsData[org] || { name: org };
    const count = orgFilterCounts[org] || 0;

    // Fetch holdings index for this organization
    try {
      const data = await PustakaDB.cachedFetchJson(`${BASE_URL}org/${org}/index.json`, 'orgs', `holdings:${org}`, 86400000);
      if (data && Array.isArray(data)) {
        for (const item of data) {
          orgHoldingsMap[item.id] = item;
        }
      }
    } catch (e) {
      console.warn('Could not load org holdings index:', e);
    }

    // Render Organization Profile Banner
    if (banner) {
      const titleEl = document.getElementById('org-banner-name');
      const codeEl = document.getElementById('org-banner-code');
      const typeEl = document.getElementById('org-banner-type');
      const stateEl = document.getElementById('org-banner-state');
      const countEl = document.getElementById('org-banner-count');
      const schemeEl = document.getElementById('org-banner-scheme');
      const opacLinkEl = document.getElementById('org-banner-opac-link');
      const shelfBtn = document.getElementById('org-banner-shelf-toggle-btn');
      const closeBtn = document.getElementById('org-banner-close-btn');

      if (titleEl) titleEl.textContent = orgInfo.name || org;
      if (codeEl) codeEl.textContent = org;
      if (typeEl) typeEl.textContent = getSectorTitle(orgInfo.type);
      if (stateEl) stateEl.textContent = orgInfo.state ? `📍 ${orgInfo.state}` : 'Malaysia';
      if (countEl) countEl.textContent = `📚 ${count.toLocaleString()} rekod katalog diindeks`;
      if (schemeEl) schemeEl.textContent = `🏷️ Skim: ${orgInfo.default_scheme || 'DDC'}`;

      if (opacLinkEl) {
        if (orgInfo.opac_url) {
          opacLinkEl.href = orgInfo.opac_url;
          opacLinkEl.style.display = 'inline-flex';
        } else {
          opacLinkEl.style.display = 'none';
        }
      }

      const preloadBtn = document.getElementById('org-banner-preload-btn');
      const preloadText = document.getElementById('org-banner-preload-text');
      if (preloadBtn) {
        PustakaDB.get('orgs', `holdings:${org}`).then(cached => {
          if (cached && Array.isArray(cached) && cached.length > 0) {
            if (preloadText) preloadText.textContent = `✓ Koleksi Dipramuat (${cached.length})`;
            preloadBtn.classList.add('is-preloaded');
          } else {
            if (preloadText) preloadText.textContent = '⚡ Pramuat Koleksi';
            preloadBtn.classList.remove('is-preloaded');
          }
        });

        preloadBtn.onclick = async () => {
          if (preloadText) preloadText.textContent = '⚡ Memuatkan...';
          try {
            const hData = await PustakaDB.cachedFetchJson(`${BASE_URL}org/${org}/index.json`, 'orgs', `holdings:${org}`, 86400000);
            const scheme = orgInfo.default_scheme || 'DDC';
            await PustakaDB.cachedFetchJson(`${BASE_URL}browse/${org}/${scheme}.json`, 'orgs', `shelf:${org}:${scheme}`, 86400000);
            const recCount = (hData && Array.isArray(hData)) ? hData.length : count;
            if (preloadText) preloadText.textContent = `✓ Koleksi Dipramuat (${recCount})`;
            preloadBtn.classList.add('is-preloaded');
            updateStorageStatusUI();
          } catch (e) {
            if (preloadText) preloadText.textContent = 'Ralat Pramuat';
          }
        };
      }

      if (shelfBtn && !shelfBtn._attached) {
        shelfBtn._attached = true;
        shelfBtn.onclick = () => toggleOrgShelfDrawer();
      }

      if (closeBtn && !closeBtn._attached) {
        closeBtn._attached = true;
        closeBtn.onclick = () => {
          const select = document.getElementById('org-filter');
          if (select) {
            select.value = '';
            select.dispatchEvent(new Event('change'));
          }
        };
      }

      banner.style.display = 'block';
    }
  } else {
    if (banner) banner.style.display = 'none';
  }

  renderActiveFilters();
  const customInput = document.getElementById('search-input');
  const resultsContainer = document.getElementById('search-results');
  if (resultsContainer) {
    await performSearch(customInput ? customInput.value : '', resultsContainer, false);
  }
}

async function toggleOrgShelfDrawer() {
  const shelfDrawer = document.getElementById('org-shelf-drawer');
  if (!shelfDrawer || !currentOrg) return;

  if (shelfDrawer.style.display === 'block') {
    shelfDrawer.style.display = 'none';
    return;
  }

  shelfDrawer.style.display = 'block';
  await renderOrgShelfBrowse(currentShelfScheme);
}

async function renderOrgShelfBrowse(scheme = 'DDC') {
  currentShelfScheme = scheme;
  const itemsContainer = document.getElementById('org-shelf-items');
  const schemesContainer = document.getElementById('org-shelf-schemes');
  if (!itemsContainer || !currentOrg) return;

  itemsContainer.innerHTML = '<div class="shelf-card-empty"><p>Memuatkan rak koleksi tersusun...</p></div>';

  if (schemesContainer) {
    schemesContainer.innerHTML = `
      <button type="button" class="shelf-scheme-btn ${scheme === 'DDC' ? 'active' : ''}" data-scheme="DDC">Dewey (DDC)</button>
      <button type="button" class="shelf-scheme-btn ${scheme === 'LCC' ? 'active' : ''}" data-scheme="LCC">Library of Congress (LCC)</button>
    `;

    if (!schemesContainer._listenerAttached) {
      schemesContainer._listenerAttached = true;
      schemesContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.shelf-scheme-btn');
        if (!btn) return;
        const newScheme = btn.getAttribute('data-scheme');
        renderOrgShelfBrowse(newScheme);
      });
    }
  }

  const cacheKey = `${currentOrg}_${scheme}`;
  let shelfItems = shelfBrowseDataCache[cacheKey];

  if (!shelfItems) {
    try {
      shelfItems = await PustakaDB.cachedFetchJson(
        `${BASE_URL}browse/${currentOrg}/${scheme}.json`,
        'orgs',
        `shelf:${currentOrg}:${scheme}`,
        86400000
      );
      if (shelfItems) {
        shelfBrowseDataCache[cacheKey] = shelfItems;
      }
    } catch (e) {
      console.warn('Shelf browse fetch error:', e);
    }
  }

  if (!shelfItems || shelfItems.length === 0) {
    const orgIndex = Object.values(orgHoldingsMap);
    if (orgIndex.length > 0) {
      shelfItems = orgIndex.slice(0, 30).map(x => ({
        id: x.id,
        title: x.title,
        callNumber: x.call_number || '---'
      }));
    }
  }

  if (!shelfItems || shelfItems.length === 0) {
    itemsContainer.innerHTML = `
      <div class="shelf-card-empty">
        <p>${escapeHTML(i18n['org_shelf_empty'] || 'Tiada rekod klasifikasi rak untuk skim ini.')}</p>
      </div>
    `;
    return;
  }

  itemsContainer.innerHTML = '';
  // Show up to 40 shelf items
  shelfItems.slice(0, 40).forEach(item => {
    const a = document.createElement('a');
    a.href = `${BASE_URL}book/?id=${encodeURIComponent(item.id)}`;
    a.className = 'shelf-card-item';
    a.title = `${item.title} (${item.callNumber || ''})`;
    a.innerHTML = `
      <span class="shelf-card-spine">${escapeHTML(item.callNumber || 'DDC')}</span>
      <span class="shelf-card-title">${escapeHTML(item.title || 'Untitled')}</span>
      <span class="shelf-card-link">Lihat Rekod &rarr;</span>
    `;
    itemsContainer.appendChild(a);
  });
}

/* Active Filter Chips */
function renderActiveFilters() {
  const container = document.getElementById('active-filters-chips');
  const chipsList = document.getElementById('filter-chips-list');
  if (!container || !chipsList) return;

  chipsList.innerHTML = '';
  let count = 0;

  if (currentOrg) {
    count++;
    const orgName = orgsData[currentOrg]?.name || currentOrg;
    const orgCount = orgFilterCounts[currentOrg] ? ` (${orgFilterCounts[currentOrg].toLocaleString()} rekod)` : '';
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = `${escapeHTML(i18n['organization'] || 'Org')}: ${escapeHTML(orgName)}${escapeHTML(orgCount)} <button class="filter-chip-remove" aria-label="Remove filter">&times;</button>`;
    chip.querySelector('.filter-chip-remove').onclick = () => {
      const select = document.getElementById('org-filter');
      if (select) select.value = '';
      const url = new URL(window.location);
      url.searchParams.delete('org');
      window.history.pushState({}, '', url);
      onOrgChange('');
    };
    chipsList.appendChild(chip);
  }

  if (currentDdc) {
    count++;
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = `DDC: ${escapeHTML(currentDdc)}00s <button class="filter-chip-remove" aria-label="Remove filter">&times;</button>`;
    chip.querySelector('.filter-chip-remove').onclick = () => {
      setDdcFilter('');
    };
    chipsList.appendChild(chip);
  }

  if (currentSearchField && currentSearchField !== 'all') {
    count++;
    const fieldLabel = i18n[`search_field_${currentSearchField}`] || currentSearchField;
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = `Medan: ${escapeHTML(fieldLabel)} <button class="filter-chip-remove" aria-label="Remove filter">&times;</button>`;
    chip.querySelector('.filter-chip-remove').onclick = () => {
      currentSearchField = 'all';
      const select = document.getElementById('search-field');
      if (select) select.value = 'all';
      renderActiveFilters();
      const customInput = document.getElementById('search-input');
      const resultsContainer = document.getElementById('search-results');
      performSearch(customInput ? customInput.value : '', resultsContainer, false);
    };
    chipsList.appendChild(chip);
  }

  if (currentSort && currentSort !== 'relevance') {
    count++;
    const sortLabel = i18n[`sort_${currentSort.replace('-', '_')}`] || currentSort;
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = `Susun: ${escapeHTML(sortLabel)} <button class="filter-chip-remove" aria-label="Remove filter">&times;</button>`;
    chip.querySelector('.filter-chip-remove').onclick = () => {
      currentSort = 'relevance';
      const select = document.getElementById('sort-filter');
      if (select) select.value = 'relevance';
      renderActiveFilters();
      const customInput = document.getElementById('search-input');
      const resultsContainer = document.getElementById('search-results');
      performSearch(customInput ? customInput.value : '', resultsContainer, false);
    };
    chipsList.appendChild(chip);
  }

  container.style.display = count > 0 ? 'flex' : 'none';

  const clearBtn = document.getElementById('clear-all-filters-btn');
  if (clearBtn && !clearBtn._attached) {
    clearBtn._attached = true;
    clearBtn.onclick = () => {
      const orgSelect = document.getElementById('org-filter');
      if (orgSelect) orgSelect.value = '';
      const fieldSelect = document.getElementById('search-field');
      if (fieldSelect) fieldSelect.value = 'all';
      const sortSelect = document.getElementById('sort-filter');
      if (sortSelect) sortSelect.value = 'relevance';
      const input = document.getElementById('search-input');
      if (input) input.value = '';
      const clearSearchBtn = document.getElementById('search-clear-btn');
      if (clearSearchBtn) clearSearchBtn.style.display = 'none';

      const url = new URL(window.location);
      url.searchParams.delete('org');
      window.history.pushState({}, '', url);

      currentOrg = null;
      currentDdc = '';
      currentSearchField = 'all';
      currentSort = 'relevance';
      currentQuery = '';
      orgHoldingsMap = {};
      updateOrgComboboxUI('');
      const banner = document.getElementById('org-profile-banner');
      if (banner) banner.style.display = 'none';
      const shelfDrawer = document.getElementById('org-shelf-drawer');
      if (shelfDrawer) shelfDrawer.style.display = 'none';
      updateDdcPills();
      renderActiveFilters();
      const resultsContainer = document.getElementById('search-results');
      performSearch('', resultsContainer, false);
    };
  }
}

/* DDC 000-900 Pills Filter */
function initDdcPills() {
  const pillsContainer = document.getElementById('ddc-pills');
  if (!pillsContainer) return;

  pillsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.ddc-pill');
    if (!btn) return;
    const ddcCode = btn.getAttribute('data-ddc') || '';
    setDdcFilter(ddcCode);
  });
}

function setDdcFilter(ddcCode) {
  currentDdc = ddcCode;
  updateDdcPills();
  renderActiveFilters();

  const customInput = document.getElementById('search-input');
  const resultsContainer = document.getElementById('search-results');
  if (resultsContainer) {
    performSearch(customInput ? customInput.value : '', resultsContainer, false);
  }
}

function updateDdcPills() {
  document.querySelectorAll('.ddc-pill').forEach(btn => {
    const code = btn.getAttribute('data-ddc') || '';
    if (code === currentDdc) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function getRecordIdFromUrl(url) {
  if (!url) return null;
  const idMatch = url.match(/[?&]id=([^&#]+)/);
  if (idMatch) return idMatch[1];
  const match = url.match(/(?:\/|^)book\/([^\/\?\#]+)\/?/);
  return match ? match[1] : null;
}

/* Basket Management */
function toggleBasket(recordId) {
  if (basket.has(recordId)) {
    basket.delete(recordId);
  } else {
    basket.add(recordId);
  }
  saveBasket();
  renderBasket();
  updateResultButtonStates();
}

function saveBasket() {
  localStorage.setItem('pustaka-basket', JSON.stringify(Array.from(basket)));
}

function loadBasket() {
  try {
    const saved = localStorage.getItem('pustaka-basket');
    if (saved) {
      basket = new Set(JSON.parse(saved));
    }
  } catch (e) {}
}

function renderBasket() {
  const ul = document.getElementById('basket-items');
  const emptyMsg = document.getElementById('basket-empty');
  const btn = document.getElementById('download-basket-btn');
  const printBtn = document.getElementById('print-basket-slips-btn');
  const countBadge = document.getElementById('basket-count-badge');
  const mobileCountBadge = document.getElementById('mobile-basket-count');
  
  if (countBadge) countBadge.textContent = basket.size;
  if (mobileCountBadge) mobileCountBadge.textContent = basket.size;

  if (!ul) return;
  ul.innerHTML = '';

  if (basket.size === 0) {
    if (emptyMsg) emptyMsg.style.display = 'block';
    if (btn) btn.disabled = true;
    if (printBtn) printBtn.disabled = true;
  } else {
    if (emptyMsg) emptyMsg.style.display = 'none';
    if (btn) btn.disabled = false;
    if (printBtn) printBtn.disabled = false;
    
    basket.forEach(id => {
      const li = document.createElement('li');
      li.textContent = id;
      
      const removeBtn = document.createElement('button');
      removeBtn.textContent = i18n['remove_from_basket'] || 'Remove';
      removeBtn.onclick = () => toggleBasket(id);
      
      li.appendChild(removeBtn);
      ul.appendChild(li);
    });
  }
}

function updateResultButtonStates() {
  document.querySelectorAll('.basket-btn').forEach(btn => {
    const recId = btn.getAttribute('data-id');
    if (recId) {
      const inBasket = basket.has(recId);
      btn.textContent = inBasket ? (i18n['remove_from_basket'] || 'Remove') : (i18n['add_to_basket'] || '+ Add to Basket');
      if (inBasket) {
        btn.classList.add('in-basket');
      } else {
        btn.classList.remove('in-basket');
      }
    }
  });
}

async function downloadBasket() {
  if (basket.size === 0) return;
  
  let xmls = [];
  for (const id of basket) {
    try {
      let res = await fetch(`${BASE_URL}id/${id}.xml`);
      if (!res.ok) {
        const shard = id.substring(0, 2).toLowerCase();
        res = await fetch(`https://raw.githubusercontent.com/pustaka-terbuka/pnm/main/data/bib/${shard}/${id}.xml`);
      }
      if (res.ok) {
        const text = await res.text();
        const matches = text.match(/<record[^>]*>[\s\S]*?<\/record>/gi);
        if (matches) {
          xmls.push(...matches);
        }
      }
    } catch (e) {
      console.error(`Failed to fetch ${id}`, e);
    }
  }
  
  if (xmls.length > 0) {
    const collection = `<?xml version="1.0" encoding="UTF-8"?>\n<collection xmlns="http://www.loc.gov/MARC21/slim">\n${xmls.join('\n')}\n</collection>`;
    const blob = new Blob([collection], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pustaka-basket.xml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/* Shelf Slip Printing */
function printBasketSlips() {
  if (basket.size === 0) return;
  const slipsContainer = document.getElementById('print-slips-container');
  if (!slipsContainer) return;

  slipsContainer.innerHTML = '';
  basket.forEach(recId => {
    const slip = document.createElement('div');
    slip.className = 'shelf-slip';
    const holding = orgHoldingsMap[recId];
    const callNum = holding?.call_number || '---';
    slip.innerHTML = `
      <div class="shelf-slip-title">PustakaTerbuka Shelf Slip</div>
      <div class="shelf-slip-id">Record ID: <strong>${escapeHTML(recId)}</strong></div>
      <div class="shelf-slip-call">${escapeHTML(callNum)}</div>
      <div class="shelf-slip-org">Organization: ${escapeHTML(currentOrg || 'National Union Catalog')}</div>
      <div class="shelf-slip-date">Date: ${new Date().toLocaleDateString()}</div>
    `;
    slipsContainer.appendChild(slip);
  });

  window.print();
}

/* MARC21 Inspector Modal Logic */
async function openMarcModal(recordId) {
  const modal = document.getElementById('marc-modal');
  const titleRecId = document.getElementById('marc-modal-record-id');
  const tableContainer = document.getElementById('marc-modal-table-container');
  const loader = document.getElementById('marc-modal-loader');
  const downloadLink = document.getElementById('modal-download-link');

  if (!modal) return;
  if (titleRecId) titleRecId.textContent = recordId;
  if (downloadLink) {
    downloadLink.href = `${BASE_URL}id/${recordId}.xml`;
    downloadLink.download = `${recordId}.xml`;
  }

  if (tableContainer) tableContainer.innerHTML = '';
  if (loader) loader.style.display = 'block';

  if (modal.showModal) {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }

  let xmlText = '';
  try {
    xmlText = await PustakaDB.cachedFetchText(`${BASE_URL}id/${recordId}.xml`, 'records', `xml:${recordId}`, 7 * 86400000);
    if (!xmlText) {
      const shard = recordId.substring(0, 2).toLowerCase();
      xmlText = await PustakaDB.cachedFetchText(
        `https://raw.githubusercontent.com/pustaka-terbuka/pnm/main/data/bib/${shard}/${recordId}.xml`,
        'records',
        `xml:${recordId}`,
        7 * 86400000
      );
    }
    if (!xmlText) throw new Error('Record XML not accessible.');
  } catch (err) {
    if (loader) loader.style.display = 'none';
    if (tableContainer) {
      tableContainer.innerHTML = `<p style="color:#dc3545;">Error loading MARCXML: ${escapeHTML(err.message)}</p>`;
    }
    return;
  }

  if (loader) loader.style.display = 'none';

  // Parse MARCXML to display table
  renderMarcTable(xmlText, tableContainer, recordId);

  // Setup Toolbar Copy Buttons
  setupModalCopyButtons(xmlText, recordId);
}

function renderMarcTable(xmlText, container, recordId) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

  let rows = [];

  // Leader
  const leader = xmlDoc.querySelector('leader');
  if (leader) {
    rows.push(`
      <tr>
        <td><span class="marc-tag-badge">LDR</span></td>
        <td>_</td><td>_</td>
        <td>${escapeHTML(leader.textContent)}</td>
      </tr>
    `);
  }

  // Controlfields
  xmlDoc.querySelectorAll('controlfield').forEach(cf => {
    const tag = cf.getAttribute('tag');
    rows.push(`
      <tr>
        <td><span class="marc-tag-badge">${escapeHTML(tag)}</span></td>
        <td>_</td><td>_</td>
        <td>${escapeHTML(cf.textContent)}</td>
      </tr>
    `);
  });

  // Datafields
  xmlDoc.querySelectorAll('datafield').forEach(df => {
    const tag = df.getAttribute('tag');
    const ind1 = df.getAttribute('ind1') || ' ';
    const ind2 = df.getAttribute('ind2') || ' ';

    let subfieldsHtml = [];
    df.querySelectorAll('subfield').forEach(sf => {
      const code = sf.getAttribute('code');
      subfieldsHtml.push(`<span class="marc-subfield-code">$${escapeHTML(code)}</span>${escapeHTML(sf.textContent)}`);
    });

    rows.push(`
      <tr>
        <td><span class="marc-tag-badge">${escapeHTML(tag)}</span></td>
        <td>${escapeHTML(ind1)}</td>
        <td>${escapeHTML(ind2)}</td>
        <td>${subfieldsHtml.join(' ')}</td>
      </tr>
    `);
  });

  container.innerHTML = `
    <table class="marc-table">
      <thead>
        <tr>
          <th style="width: 70px;">${escapeHTML(i18n['field_tag'] || 'Tag')}</th>
          <th style="width: 40px;">I1</th>
          <th style="width: 40px;">I2</th>
          <th>${escapeHTML(i18n['field_data'] || 'Subfield Data')}</th>
        </tr>
      </thead>
      <tbody>
        ${rows.join('')}
      </tbody>
    </table>
  `;
}

function setupModalCopyButtons(xmlText, recordId) {
  const copyXmlBtn = document.getElementById('modal-copy-marcxml-btn');
  const copyTxtBtn = document.getElementById('modal-copy-text-btn');
  const copyCsBtn = document.getElementById('modal-copy-csharp-btn');
  const toast = document.getElementById('modal-toast');

  function showToast() {
    if (toast) {
      toast.style.display = 'inline-block';
      setTimeout(() => { toast.style.display = 'none'; }, 2200);
    }
  }

  if (copyXmlBtn) {
    copyXmlBtn.onclick = () => {
      navigator.clipboard.writeText(xmlText).then(showToast);
    };
  }

  if (copyTxtBtn) {
    copyTxtBtn.onclick = () => {
      // Build plain text representation
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      let text = '';
      doc.querySelectorAll('controlfield, datafield').forEach(f => {
        const tag = f.getAttribute('tag');
        if (f.tagName === 'controlfield') {
          text += `${tag}    ${f.textContent}\n`;
        } else {
          const ind1 = f.getAttribute('ind1') || ' ';
          const ind2 = f.getAttribute('ind2') || ' ';
          let subs = [];
          f.querySelectorAll('subfield').forEach(sf => {
            subs.push(`$${sf.getAttribute('code')} ${sf.textContent}`);
          });
          text += `${tag} ${ind1}${ind2} ${subs.join(' ')}\n`;
        }
      });
      navigator.clipboard.writeText(text).then(showToast);
    };
  }

  if (copyCsBtn) {
    copyCsBtn.onclick = () => {
      const csSnippet = `// PustakaTerbuka C# Copy Cataloging Recipe
using System.Net.Http;
using System.Xml.Linq;

using var client = new HttpClient();
string xml = await client.GetStringAsync("https://pustaka-terbuka.github.io/opac/id/${recordId}.xml");
XDocument doc = XDocument.Parse(xml);
XNamespace ns = "http://www.loc.gov/MARC21/slim";
var title = doc.Descendants(ns + "datafield")
               .FirstOrDefault(d => (string)d.Attribute("tag") == "245")
               ?.Elements(ns + "subfield")
               .FirstOrDefault(s => (string)s.Attribute("code") == "a")?.Value;`;
      navigator.clipboard.writeText(csSnippet).then(showToast);
    };
  }
}

function initMarcModalListeners() {
  const modal = document.getElementById('marc-modal');
  const closeBtn = document.getElementById('marc-modal-close-btn');
  const footerCloseBtn = document.getElementById('modal-footer-close-btn');

  function closeModal() {
    if (modal) {
      if (modal.close) modal.close();
      else modal.removeAttribute('open');
    }
  }

  if (closeBtn) closeBtn.onclick = closeModal;
  if (footerCloseBtn) footerCloseBtn.onclick = closeModal;
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }
}

/* Search UI Construction & Execution */
function buildCustomSearchUI() {
  const container = document.getElementById('search-ui');
  if (!container) return;

  container.innerHTML = `
    <form id="search-form">
      <div class="search-input-group">
        <select id="search-field" class="search-field-select" aria-label="Search Field">
          <option value="all" data-i18n="search_field_all">${escapeHTML(i18n['search_field_all'] || 'All Fields')}</option>
          <option value="title" data-i18n="search_field_title">${escapeHTML(i18n['search_field_title'] || 'Title')}</option>
          <option value="author" data-i18n="search_field_author">${escapeHTML(i18n['search_field_author'] || 'Author')}</option>
          <option value="subject" data-i18n="search_field_subject">${escapeHTML(i18n['search_field_subject'] || 'Subject')}</option>
          <option value="isbn" data-i18n="search_field_isbn">${escapeHTML(i18n['search_field_isbn'] || 'ISBN / ISSN')}</option>
          <option value="call" data-i18n="search_field_call">${escapeHTML(i18n['search_field_call'] || 'Call Number')}</option>
        </select>
        <div class="search-input-wrapper">
          <input type="text" id="search-input" autocomplete="off" spellcheck="false" placeholder="${escapeHTML(i18n['search_placeholder'] || 'Search by title, author, ISBN, or subject...')}" />
          <button type="button" id="search-clear-btn" class="search-clear-btn" aria-label="Clear Search" style="display: none;">&times;</button>
          <span class="search-kbd-hint" title="Press / to focus search">/</span>
        </div>
        <button type="submit" id="search-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <span>${escapeHTML(i18n['search_button'] || 'Search')}</span>
        </button>
      </div>
    </form>
  `;

  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const fieldSelect = document.getElementById('search-field');
  const sortSelect = document.getElementById('sort-filter');
  const resultsContainer = document.getElementById('search-results');

  function toggleClearButton() {
    if (clearBtn) {
      clearBtn.style.display = input.value.trim().length > 0 ? 'flex' : 'none';
    }
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      currentQuery = '';
      toggleClearButton();
      input.focus();
      currentPage = 1;
      performSearch('', resultsContainer, false);
    });
  }

  // Instant Search-as-you-type with debouncing (220ms)
  input.addEventListener('input', () => {
    toggleClearButton();
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
      currentQuery = input.value;
      currentPage = 1;
      await performSearch(currentQuery, resultsContainer, false);
    }, 220);
  });

  // Instant submit (Enter or button click) cancels debounce and fires immediately
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTimeout(searchDebounceTimer);
    currentQuery = input.value;
    currentPage = 1;
    await performSearch(currentQuery, resultsContainer, false);
  });

  // Field selector binding
  if (fieldSelect) {
    fieldSelect.addEventListener('change', async (e) => {
      currentSearchField = e.target.value;
      renderActiveFilters();
      currentPage = 1;
      await performSearch(input.value, resultsContainer, false);
    });
  }

  // Sort selector binding
  if (sortSelect) {
    sortSelect.addEventListener('change', async (e) => {
      currentSort = e.target.value;
      renderActiveFilters();
      currentPage = 1;
      await performSearch(input.value, resultsContainer, false);
    });
  }

  // Keyboard shortcut (/ to focus search, Escape to clear/blur)
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !['input', 'textarea', 'select'].includes((document.activeElement?.tagName || '').toLowerCase())) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && document.activeElement === input) {
      if (input.value) {
        input.value = '';
        currentQuery = '';
        toggleClearButton();
        performSearch('', resultsContainer, false);
      } else {
        input.blur();
      }
    }
  });

  performSearch('', resultsContainer, true);
}

window.retryLastSearch = function() {
  const customInput = document.getElementById('search-input');
  const resultsContainer = document.getElementById('search-results');
  if (resultsContainer) {
    performSearch(customInput ? customInput.value : '', resultsContainer, false);
  }
};

function updateSearchStats(count, timeMs) {
  const statsEl = document.getElementById('search-stats');
  if (!statsEl) return;
  if (count === 0 && timeMs === 0) {
    statsEl.style.display = 'none';
    return;
  }
  statsEl.style.display = 'flex';
  let msg = i18n['results_count'] || '{0} results found.';
  msg = msg.replace('{0}', count);
  if (currentOrg) {
    const orgName = orgsData[currentOrg]?.name || currentOrg;
    msg += ` (${orgName})`;
  }
  const timeStr = (i18n['search_time'] || 'in {0}ms').replace('{0}', timeMs);
  statsEl.innerHTML = `
    <span>${escapeHTML(msg)}</span>
    <span class="search-stats-time">⚡ ${escapeHTML(timeStr)}</span>
  `;
}

async function performSearch(query, resultsContainer, isInitial = false) {
  if (!pagefind) {
    resultsContainer.innerHTML = `
      <div class="search-alert-card">
        <h4>${escapeHTML(i18n['index_unavailable'] || 'Indeks Carian Tidak Tersedia / Search Index Unavailable')}</h4>
        <p>PustakaTerbuka search index is not yet initialized. Please reload the page.</p>
      </div>
    `;
    return;
  }

  const currentToken = ++searchSequenceToken;

  resultsContainer.innerHTML = `
    <div class="search-loading-container" role="status" aria-live="polite">
      <div class="search-spinner"></div>
      <div class="search-progress-bar">
        <div class="search-progress-bar-fill"></div>
      </div>
      <p class="search-loading-text">${escapeHTML(i18n['searching'] || 'Mencari rekod katalog... / Searching catalog...')}</p>
      <p class="search-loading-subtext">${escapeHTML(currentOrg ? `Menapis mengikut organisasi: ${orgsData[currentOrg]?.name || currentOrg}` : 'Mencari di seluruh katalog terbuka kebangsaan...')}</p>
    </div>
  `;

  try {
    const searchOpts = {};
    const filters = {};

    if (currentOrg) {
      filters.organization = [currentOrg];
    }
    if (currentDdc) {
      filters.ddc_class = [currentDdc];
    }
    if (Object.keys(filters).length > 0) {
      searchOpts.filters = filters;
    }

    // Sort option
    if (currentSort === 'year-desc') {
      searchOpts.sort = { year: 'desc' };
    } else if (currentSort === 'year-asc') {
      searchOpts.sort = { year: 'asc' };
    } else if (currentSort === 'title-asc') {
      searchOpts.sort = { title: 'asc' };
    }

    let rawTerm = (query && query.trim()) ? query.trim() : null;
    let searchTerm = rawTerm;

    // ISBN Auto-normalization
    if (searchTerm) {
      const isbnCandidate = extractSearchIsbn(searchTerm);
      if (isbnCandidate && currentSearchField === 'isbn') {
        searchTerm = isbnCandidate;
      }
    }

    // High performance search: if empty query, use filter-only browse (searchTerm = null)
    if (!searchTerm) {
      if (currentOrg || currentDdc || isInitial) {
        searchTerm = null; // Filter-only browse mode: instant, no heavy chunk parsing
      } else {
        updateSearchStats(0, 0);
        resultsContainer.innerHTML = `<p class="search-empty-note">${escapeHTML(i18n['no_results'] || 'No records found.')}</p>`;
        hidePagination();
        return;
      }
    }

    const tStart = performance.now();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Search request timed out after 16 seconds. Please check your network connection or try again.')), 16000);
    });

    const search = await Promise.race([
      pagefind.search(searchTerm, searchOpts),
      timeoutPromise
    ]);

    const tDuration = Math.round(performance.now() - tStart);
    lastSearchTimeMs = tDuration;

    // Guard against race conditions from previous in-flight requests
    if (currentToken !== searchSequenceToken) {
      return;
    }

    if (!search || !search.results || search.results.length === 0) {
      updateSearchStats(0, tDuration);
      resultsContainer.innerHTML = `
        <div class="search-empty-card">
          <p class="search-empty-note">${escapeHTML(i18n['no_results'] || 'Tiada rekod dijumpai / No records found.')}</p>
          <div class="search-empty-suggestions">
            <p>💡 <strong>Cadangan Carian:</strong></p>
            <ul>
              <li>Pastikan ejaan perkataan adalah tepat / Check your spelling.</li>
              <li>Gunakan kata kunci yang lebih umum / Try broader keywords.</li>
              ${currentOrg ? `<li>Cuba keluarkan tapisan organisasi (<strong>${orgsData[currentOrg]?.name || currentOrg}</strong>).</li>` : ''}
              ${currentDdc ? `<li>Keluarkan tapisan kelas Dewey (DDC).</li>` : ''}
              ${currentSearchField !== 'all' ? `<li>Tukar medan carian ke "Semua Medan" / Switch to All Fields.</li>` : ''}
            </ul>
          </div>
        </div>
      `;
      hidePagination();
      return;
    }

    let results = search.results;

    // Field-specific targeting if field is explicitly selected
    if (rawTerm && currentSearchField !== 'all') {
      const termLower = rawTerm.toLowerCase();
      const candidateLimit = Math.min(results.length, 25);
      const topCandidates = await Promise.all(
        results.slice(0, candidateLimit).map(async r => ({
          res: r,
          data: await getResultData(r)
        }))
      );

      const matched = [];
      const remainder = [];

      for (const item of topCandidates) {
        const meta = item.data?.meta || {};
        let matches = false;
        if (currentSearchField === 'title') {
          matches = meta.title && meta.title.toLowerCase().includes(termLower);
        } else if (currentSearchField === 'author') {
          matches = meta.author && meta.author.toLowerCase().includes(termLower);
        } else if (currentSearchField === 'subject') {
          const subjects = item.data?.filters?.subject || [];
          matches = subjects.some(s => s.toLowerCase().includes(termLower));
        } else if (currentSearchField === 'isbn') {
          const isbn = (meta.isbn || '').replace(/[-\s]/g, '');
          matches = isbn.includes(termLower.replace(/[-\s]/g, ''));
        } else if (currentSearchField === 'call') {
          const call = `${meta.call_number || ''} ${meta.ddc || ''} ${meta.lcc || ''}`.toLowerCase();
          matches = call.includes(termLower);
        }

        if (matches) {
          matched.push(item.res);
        } else {
          remainder.push(item.res);
        }
      }

      if (matched.length > 0) {
        results = matched;
      } else {
        results = [];
      }
    }

    currentSearchResults = results;
    currentPage = 1;
    updateSearchStats(currentSearchResults.length, tDuration);
    if (rawTerm && currentSearchResults.length > 0) {
      PustakaDB.set('queries', rawTerm.toLowerCase(), { query: rawTerm, count: currentSearchResults.length }, 30 * 86400000).catch(() => {});
    }
    await renderCurrentPage(resultsContainer, isInitial);
  } catch (err) {
    if (currentToken !== searchSequenceToken) return;
    console.error('Search failed:', err);
    hidePagination();
    updateSearchStats(0, 0);
    resultsContainer.innerHTML = `
      <div class="search-alert-card" role="alert">
        <h4>⚠️ Ralat Semasa Carian / Search Error</h4>
        <p>${escapeHTML(err.message || 'Carian mengambil masa terlalu lama atau gagal dimuatkan.')}</p>
        <button type="button" class="btn-retry-search" onclick="retryLastSearch()">Cuba Semula / Retry</button>
      </div>
    `;
  }
}

async function renderCurrentPage(resultsContainer, isInitial = false) {
  resultsContainer.innerHTML = '';

  const totalResults = currentSearchResults.length;
  const totalPages = Math.ceil(totalResults / PAGE_SIZE);

  if (isInitial && !currentOrg && !currentDdc && !currentQuery) {
    resultsContainer.innerHTML = `<p style="color:var(--text-muted); margin-bottom:1rem;">📚 <strong>Sorotan Katalog Kebangsaan:</strong> Memaparkan judul terkini. Gunakan kotak carian di atas atau butang DDC untuk menapis.</p>`;
  }

  const list = document.createElement('div');
  list.className = 'results-list';

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, totalResults);
  const pageSlice = currentSearchResults.slice(startIndex, endIndex);

  // Parallel hydration for high-speed rendering
  const itemsData = await Promise.all(
    pageSlice.map(async (res) => {
      try {
        const data = await getResultData(res);
        return { res, data };
      } catch (itemErr) {
        console.warn('Failed to load search result item:', itemErr);
        return null;
      }
    })
  );

  for (const item of itemsData) {
    if (!item || !item.data) continue;
    const { res, data } = item;
    const node = document.createElement('div');
    node.className = 'result-item';

    const url = data.url;
    const recordId = getRecordIdFromUrl(url) || 'unknown';
    const bookUrl = (recordId !== 'unknown') ? `${BASE_URL}book/?id=${recordId}` : url;

    const isbn = data.meta?.isbn || '';
    let thumbHtml = '';
    if (isbn) {
      thumbHtml = `<div class="result-thumb-wrapper">
        <img src="https://covers.openlibrary.org/b/isbn/${escapeHTML(isbn)}-M.jpg?default=false" 
             alt="Cover for ${escapeHTML(data.meta.title || '')}" 
             class="result-thumb-img" 
             loading="lazy" 
             onerror="this.onerror=null; this.src='https://books.google.com/books/content?vid=isbn${escapeHTML(isbn)}&printsec=frontcover&img=1&zoom=1'; this.onerror=()=>this.parentElement.style.display='none';" />
      </div>`;
    }

    const titleHtml = `<h3><a href="${escapeHTML(bookUrl)}">${escapeHTML(data.meta.title || 'Untitled')}</a></h3>`;
    const authorHtml = data.meta.author ? `<p class="result-author"><strong>${escapeHTML(data.meta.author)}</strong></p>` : '';
    const publisherHtml = data.meta.publisher ? `<p class="result-publisher">${escapeHTML(data.meta.publisher)}</p>` : '';
    const excerptHtml = (currentQuery && data.excerpt) ? `<div class="result-excerpt">${data.excerpt}</div>` : '';

    // Holding call number badge if specific org is selected and found in holdings map
    let holdingBadgeHtml = '';
    if (currentOrg && orgHoldingsMap[recordId]) {
      const holding = orgHoldingsMap[recordId];
      if (holding.call_number) {
        holdingBadgeHtml = `
          <div class="result-org-holding-badge">
            <span>📍 <strong>${escapeHTML(currentOrg)}</strong> ${escapeHTML(i18n['call_number'] || 'No. Panggilan:')}</span>
            <code>${escapeHTML(holding.call_number)}</code>
          </div>
        `;
      }
    }

    // Union holdings comparison badge if held by multiple libraries
    let unionHoldingsHtml = '';
    const orgsList = Array.isArray(data.filters?.organization) ? data.filters.organization : [];
    if (orgsList.length > 0) {
      const orgBadges = orgsList.slice(0, 5).map(c => {
        const oName = orgsData[c]?.name || c;
        return `<span class="badge-union-org" title="${escapeHTML(oName)}">🏛️ ${escapeHTML(c)}</span>`;
      }).join(' ');
      const moreText = orgsList.length > 5 ? `<span style="font-size:0.75rem; color:var(--text-muted);">+${orgsList.length - 5}</span>` : '';
      unionHoldingsHtml = `
        <div class="result-union-holdings">
          <span class="union-label">🏛️ ${escapeHTML(i18n['held_by'] || 'Pegangan:')}</span>
          ${orgBadges} ${moreText}
        </div>
      `;
    }

    // Meta badges (Format, Call number, Year, DDC, LCC, ISBN)
    let badgesHtml = '<div class="result-meta-badges">';
    if (data.meta?.format) {
      badgesHtml += `<span class="badge badge-format">${escapeHTML(data.meta.format)}</span>`;
    }
    if (data.meta?.ddc) {
      badgesHtml += `<span class="badge badge-ddc">DDC ${escapeHTML(data.meta.ddc)}</span>`;
    }
    if (data.meta?.lcc) {
      badgesHtml += `<span class="badge badge-lcc">LCC ${escapeHTML(data.meta.lcc)}</span>`;
    }
    if (data.meta?.year) {
      badgesHtml += `<span class="badge badge-year">${escapeHTML(data.meta.year)}</span>`;
    }
    if (isbn) {
      badgesHtml += `<span class="badge badge-isbn">ISBN ${escapeHTML(isbn)}</span>`;
    }
    badgesHtml += '</div>';

    node.innerHTML = `
      <div class="result-card-inner">
        ${thumbHtml}
        <div class="result-body">
          <div class="result-title-row">
            ${titleHtml}
          </div>
          ${authorHtml}
          ${publisherHtml}
          ${holdingBadgeHtml}
          ${unionHoldingsHtml}
          ${badgesHtml}
          ${excerptHtml}
        </div>
      </div>`;

    // Predictive hover prefetching: prefetch MARCXML on mouseenter or focus
    if (recordId && recordId !== 'unknown') {
      const triggerPrefetch = () => {
        PustakaDB.cachedFetchText(`${BASE_URL}id/${recordId}.xml`, 'records', `xml:${recordId}`).catch(() => {});
      };
      node.addEventListener('pointerenter', triggerPrefetch, { once: true });
      node.addEventListener('focusin', triggerPrefetch, { once: true });
    }

    // Actions
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'actions';

    const inBasket = basket.has(recordId);
    const btn = document.createElement('button');
    btn.className = 'basket-btn' + (inBasket ? ' in-basket' : '');
    btn.setAttribute('data-id', recordId);
    btn.textContent = inBasket ? (i18n['remove_from_basket'] || 'Remove') : (i18n['add_to_basket'] || '+ Add to Basket');
    btn.onclick = (e) => {
      e.preventDefault();
      toggleBasket(recordId);
    };

    const marcBtn = document.createElement('button');
    marcBtn.className = 'marc-btn';
    marcBtn.textContent = i18n['marc_preview'] || '👁️ MARC Tags';
    marcBtn.onclick = (e) => {
      e.preventDefault();
      openMarcModal(recordId);
    };

    const dlBtn = document.createElement('a');
    dlBtn.href = `${BASE_URL}id/${recordId}.xml`;
    dlBtn.download = `${recordId}.xml`;
    dlBtn.className = 'download-btn';
    dlBtn.textContent = i18n['download_record'] || '⬇ MARCXML';

    const viewBtn = document.createElement('a');
    viewBtn.href = bookUrl;
    viewBtn.className = 'opac-link-btn';
    viewBtn.textContent = i18n['view_details'] || 'View Record →';

    actionsDiv.appendChild(btn);
    actionsDiv.appendChild(marcBtn);
    actionsDiv.appendChild(dlBtn);
    actionsDiv.appendChild(viewBtn);

    if (currentOrg && orgHoldingsMap[recordId]) {
      const callNum = orgHoldingsMap[recordId].call_number;
      const holdingsDiv = document.createElement('div');
      holdingsDiv.className = 'holdings-info';
      holdingsDiv.innerHTML = `<strong>${escapeHTML(i18n['held_by'] || 'Held by: ')}${escapeHTML(currentOrg)}</strong><br>
        Call Number: <span class="badge badge-call">${escapeHTML(callNum)}</span>
        <div class="availability-note">${escapeHTML(i18n['availability_note'] || 'Please check availability in the organization catalog.')}</div>`;
      node.appendChild(holdingsDiv);
    }

    node.appendChild(actionsDiv);
    list.appendChild(node);
  }

  resultsContainer.appendChild(list);
  renderPaginationControls(resultsContainer, totalPages);
}

/* Pagination UI */
function hidePagination() {
  const nav = document.getElementById('pagination-controls');
  if (nav) nav.style.display = 'none';
}

function renderPaginationControls(resultsContainer, totalPages) {
  const nav = document.getElementById('pagination-controls');
  if (!nav) return;

  if (totalPages <= 1) {
    nav.style.display = 'none';
    return;
  }

  nav.style.display = 'flex';
  nav.innerHTML = '';

  // Prev Button
  const prevBtn = document.createElement('button');
  prevBtn.className = 'pagination-btn';
  prevBtn.textContent = i18n['pagination_prev'] || '← Previous';
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = async () => {
    if (currentPage > 1) {
      currentPage--;
      await renderCurrentPage(resultsContainer);
      resultsContainer.scrollIntoView({ behavior: 'smooth' });
    }
  };
  nav.appendChild(prevBtn);

  // Page Numbers
  const maxButtons = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  if (endPage - startPage + 1 < maxButtons) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }

  for (let p = startPage; p <= endPage; p++) {
    const pageBtn = document.createElement('button');
    pageBtn.className = 'pagination-btn' + (p === currentPage ? ' active' : '');
    pageBtn.textContent = p;
    pageBtn.onclick = async () => {
      currentPage = p;
      await renderCurrentPage(resultsContainer);
      resultsContainer.scrollIntoView({ behavior: 'smooth' });
    };
    nav.appendChild(pageBtn);
  }

  // Next Button
  const nextBtn = document.createElement('button');
  nextBtn.className = 'pagination-btn';
  nextBtn.textContent = i18n['pagination_next'] || 'Next →';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = async () => {
    if (currentPage < totalPages) {
      currentPage++;
      await renderCurrentPage(resultsContainer);
      resultsContainer.scrollIntoView({ behavior: 'smooth' });
    }
  };
  nav.appendChild(nextBtn);
}

/* Mobile Sidebar Drawer */
function initMobileDrawer() {
  const toggleBtn = document.getElementById('mobile-basket-toggle');
  const sidebar = document.getElementById('catalog-sidebar');
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('mobile-open');
    });
  }
}

/* Initialization */
async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  currentLang = urlParams.get('lang') || 'en';
  document.documentElement.lang = currentLang;
  
  initTheme();
  updateLangSelect();
  await loadI18n(currentLang);
  
  loadBasket();
  renderBasket();
  initDdcPills();
  initMarcModalListeners();
  initMobileDrawer();
  
  await loadOrgs();

  window.addEventListener('pageshow', () => {
    loadBasket();
    renderBasket();
  });
  window.addEventListener('focus', () => {
    loadBasket();
    renderBasket();
  });
  
  const dlBasketBtn = document.getElementById('download-basket-btn');
  if (dlBasketBtn) dlBasketBtn.addEventListener('click', downloadBasket);

  const printSlipsBtn = document.getElementById('print-basket-slips-btn');
  if (printSlipsBtn) printSlipsBtn.addEventListener('click', printBasketSlips);
  
  try {
    pagefind = await import(`${BASE_URL}pagefind/pagefind.js`);
    await pagefind.init();
    
    buildCustomSearchUI();
    await loadOrgs();
  } catch (err) {
    console.error('Pagefind not found or failed to load. Are you running a built site?', err);
    const searchUi = document.getElementById('search-ui');
    if (searchUi) searchUi.textContent = 'Search index not available.';
  }

  // Hydrate offline storage status indicator
  await updateStorageStatusUI();

  // Register Service Worker for PWA offline capabilities
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.debug('[SW] Registration note:', err.message);
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
