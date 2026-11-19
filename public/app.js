(() => {
  'use strict';

  const MAX_HISTORY = 900;
  const CATEGORY_COLORS = {
    photos: '#d97e38',
    videos: '#4c8cd6',
    audio: '#3ca374',
    backups: '#349696',
    other: '#808690'
  };
  const DISK_PALETTE = ['#d97e38', '#4c8cd6', '#3ca374', '#349696', '#c46445', '#808690'];
  const VIEW_TITLES = {
    overview: 'Systemübersicht',
    files: 'Dateimanager & Papierkorb',
    storage: 'Festplatten & Blockgeräte',
    smb: 'Freigaben (SMB / Samba)',
    host: 'Host-Prozesse, Ports & Netzwerk',
    docker: 'Docker-Container',
    portainer: 'Portainer & Compose Stacks',
    appstore: 'Homeserver App Store',
    analyzer: 'Speicher-Analyse & Duplikate',
    automation: 'Automation, Watchdog & Wake-on-LAN',
    settings: 'System- & Design-Einstellungen'
  };
  const THEMES = ['studio-dark', 'studio-light', 'oled', 'slate', 'indigo'];
  const THEME_CANVAS_COLORS = {
    'studio-dark': '#141518',
    'studio-light': '#f5f5f7',
    oled: '#000000',
    slate: '#12171e',
    indigo: '#0f1120'
  };
  const THEME_LABELS = {
    dark: 'Studio Dark',
    'studio-dark': 'Studio Dark',
    light: 'Studio Light',
    'studio-light': 'Studio Light',
    oled: 'OLED Black',
    slate: 'Nordic Slate',
    indigo: 'Midnight Indigo'
  };
  const DEFAULT_OVERVIEW_WIDGETS = [
    { id: 'kpis', label: 'System-KPIs (CPU, RAM, Netz, Pool)', visible: true },
    { id: 'telemetry', label: 'Echtzeit-Telemetrie (Verlauf)', visible: true },
    { id: 'media', label: 'Medien-Verteilung', visible: true },
    { id: 'disks', label: 'Festplatten-Kurzstatus', visible: true },
    { id: 'services', label: 'Homeserver-Apps (Schnellzugriff)', visible: true },
    { id: 'docker', label: 'Container-Kurzstatus', visible: true }
  ];

  const state = {
    paused: false,
    activeView: 'overview',
    chartMode: 'compute',
    chartRangeSec: 60,
    dockerFilter: 'all',
    snapshot: null,
    history: [],
    historyLoaded: false,
    eventSource: null,
    pollTimer: null,
    watchdogTimer: null,
    hostPollTimer: null,
    lastSnapshotAt: 0,
    transport: 'connecting', // 'connecting' | 'sse' | 'polling'
    activeLogContainerId: null,
    uiSyncedFromServer: false,
    overviewWidgets: DEFAULT_OVERVIEW_WIDGETS.map((w) => ({ ...w })),
    // Files
    filesPath: '/',
    filesViewMode: 'list', // 'list' | 'grid'
    filesListing: null,
    filesSearchScope: 'folder', // 'folder' | 'global'
    filesGlobalResults: null,
    filesGlobalSearchTimer: null,
    selectedFiles: new Set(),
    activeEditorPath: null,
    activeEditorExt: '',
    activeEditorMarkdownPreview: false,
    activePreview: null,
    filesTrashMode: false,
    trashListing: null,
    selectedTrashKeys: new Set(),
    sharesList: [],
    copyMoveSources: [],
    copyMoveBrowserPath: '/',
    // Host & Network
    hostData: null,
    // Notifications & Security
    notificationsState: null,
    auditEvents: [],
    deferredInstallPrompt: null,
    // Global Search
    globalFileSearchResults: [],
    globalSearchTimer: null,
    // Smart Features
    analyzerData: null,
    analyzerPollTimer: null,
    analyzerTab: 'duplicates',
    analyzerSelectedRoots: null,
    automationData: null,
    // App Store & Compose
    appCatalog: [],
    composeTemplates: [],
    deployedStacks: [],
    appCategory: 'all',
    activeInstallApp: null,
    // Terminal
    termSocket: null,
    // SMB
    smbData: null
  };

  // ==================== HELPERS ====================
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHref(rawUrl) {
    const val = String(rawUrl || '').trim();
    if (!val) return '#';
    if (val.startsWith('/')) return val;
    try {
      const parsed = new URL(val);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      return '#';
    }
    return '#';
  }

  function getDefaultDiskMount(fallback = '/mnt/daten') {
    const disks = state.snapshot?.storage?.disks || [];
    const preferred = disks.find((d) => d.mountpoint && d.mountpoint !== '/') || disks[0];
    return preferred?.mountpoint || fallback;
  }

  function formatBytesDecimal(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let idx = 0;
    let val = bytes;
    while (val >= 1000 && idx < units.length - 1) {
      val /= 1000;
      idx += 1;
    }
    return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
  }

  function formatBytesBinary(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx += 1;
    }
    return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
  }

  function formatRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
    const mb = bytesPerSec / (1024 * 1024);
    if (mb >= 0.1) return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`;
    const kb = bytesPerSec / 1024;
    if (kb >= 1) return `${kb.toFixed(0)} KB/s`;
    return `${Math.round(bytesPerSec)} B/s`;
  }

  function formatUptime(totalSec) {
    if (!Number.isFinite(totalSec) || totalSec <= 0) return '—';
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  function formatNumber(n) {
    return new Intl.NumberFormat('de-DE').format(Math.round(n || 0));
  }

  function formatTimeShort(tsOrIso) {
    if (!tsOrIso) return '—';
    const d = new Date(tsOrIso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatDateTimeShort(tsOrIso) {
    if (!tsOrIso) return '—';
    const d = new Date(tsOrIso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function getProgressColorClass(percent) {
    if (percent >= 90) return 'fill-red';
    if (percent >= 78) return 'fill-amber';
    return 'fill-emerald';
  }

  function getCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ==================== AUTH ====================
  async function checkAuthAndStart() {
    try {
      const res = await fetch('/api/auth/status');
      const status = await res.json();
      document.getElementById('btn-logout').classList.toggle('hidden', !status.authEnabled);
      const totpGroup = document.getElementById('login-totp-group');
      if (totpGroup) totpGroup.classList.toggle('hidden', !status.totpEnabled);
      if (status.authEnabled && !status.authenticated) {
        document.getElementById('auth-overlay').classList.remove('hidden');
        return false;
      }
      document.getElementById('auth-overlay').classList.add('hidden');
      return true;
    } catch {
      return true;
    }
  }

  // ==================== THEMES & ACCENTS ====================
  function normalizeThemeName(raw) {
    if (raw === 'dark') return 'studio-dark';
    if (raw === 'light') return 'studio-light';
    return THEMES.includes(raw) ? raw : 'studio-dark';
  }

  function initTheme() {
    const savedTheme = normalizeThemeName(localStorage.getItem('hs_theme') || 'studio-dark');
    const savedAccent = localStorage.getItem('hs_accent') || 'blue';
    applyTheme(savedTheme, false);
    applyAccent(savedAccent, false);

    document.getElementById('btn-theme').addEventListener('click', () => {
      const current = normalizeThemeName(document.documentElement.getAttribute('data-theme'));
      const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
      applyTheme(next, true);
    });
  }

  function updateMetaThemeColor(rawTheme) {
    const theme = normalizeThemeName(rawTheme || document.documentElement.getAttribute('data-theme'));
    const meta = document.getElementById('meta-theme-color');
    if (meta) {
      meta.setAttribute('content', THEME_CANVAS_COLORS[theme] || '#141518');
    }
  }

  function applyTheme(rawTheme, persistServer = false) {
    const theme = normalizeThemeName(rawTheme);
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hs_theme', theme);
    updateMetaThemeColor(theme);

    const isLight = theme === 'studio-light';
    document.getElementById('icon-sun').classList.toggle('hidden', !isLight);
    document.getElementById('icon-moon').classList.toggle('hidden', isLight);

    const labelEl = document.getElementById('topbar-theme-name');
    if (labelEl) labelEl.textContent = THEME_LABELS[theme] || theme;

    document.querySelectorAll('[data-pick-theme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pickTheme === theme);
    });

    if (state.snapshot) {
      drawTelemetryChart();
      drawMediaDonut();
    }

    if (persistServer && state.snapshot) {
      saveConfigPatch({ ui: { theme } }).catch(() => {});
    }
  }

  function applyAccent(accent, persistServer = false) {
    const valid = ['blue', 'amber', 'emerald', 'purple', 'red'];
    const safeAccent = valid.includes(accent) ? accent : 'blue';
    document.documentElement.setAttribute('data-accent', safeAccent);
    localStorage.setItem('hs_accent', safeAccent);

    document.querySelectorAll('[data-pick-accent]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pickAccent === safeAccent);
    });

    if (persistServer && state.snapshot) {
      saveConfigPatch({ ui: { accent: safeAccent } }).catch(() => {});
    }
  }

  function initPwa() {
    const banner = document.getElementById('pwa-status-banner');
    const bannerText = document.getElementById('pwa-banner-text');
    const reloadBtn = document.getElementById('btn-pwa-update-reload');
    const statusEl = document.getElementById('pwa-status-text');
    const installBtn = document.getElementById('btn-pwa-install');
    const mobileInstallBtn = document.getElementById('btn-mobile-pwa-install');
    const mobileHint = document.getElementById('mobile-pwa-hint');

    let waitingWorker = null;

    function syncOnlineBanner() {
      if (!banner || !bannerText) return;
      if (!navigator.onLine) {
        bannerText.textContent = 'Offline — zeige zwischengespeicherte App-Oberfläche.';
        reloadBtn?.classList.add('hidden');
        banner.classList.remove('hidden');
      } else if (!waitingWorker) {
        banner.classList.add('hidden');
      }
    }

    window.addEventListener('online', syncOnlineBanner);
    window.addEventListener('offline', syncOnlineBanner);

    if ('serviceWorker' in navigator) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });

      navigator.serviceWorker.register('/sw.js').then((reg) => {
        const showUpdate = (worker) => {
          waitingWorker = worker;
          if (banner && bannerText) {
            bannerText.textContent = 'Neue Dashboard-Version verfügbar.';
            reloadBtn?.classList.remove('hidden');
            banner.classList.remove('hidden');
          }
        };
        if (reg.waiting) showUpdate(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdate(nw);
            }
          });
        });
      }).catch(() => {});
    }

    reloadBtn?.addEventListener('click', () => {
      if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    });

    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isStandalone) {
      if (statusEl) statusEl.textContent = 'Dashboard läuft bereits als installierte Web-App.';
      if (mobileHint) mobileHint.textContent = 'Installiert — läuft als eigenständige App.';
    } else if (isIos && mobileHint) {
      mobileHint.textContent = 'iOS: Teilen-Symbol → „Zum Home-Bildschirm“ antippen.';
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      installBtn?.classList.remove('hidden');
      mobileInstallBtn?.classList.remove('hidden');
      if (statusEl) statusEl.textContent = 'Bereit zur Installation als eigenständige App auf diesem Gerät.';
      if (mobileHint) mobileHint.textContent = 'Als eigenständige App auf dem Startbildschirm installieren.';
    });

    window.addEventListener('appinstalled', () => {
      state.deferredInstallPrompt = null;
      installBtn?.classList.add('hidden');
      mobileInstallBtn?.classList.add('hidden');
      if (statusEl) statusEl.textContent = 'App erfolgreich installiert.';
      if (mobileHint) mobileHint.textContent = 'App erfolgreich installiert.';
    });

    async function triggerInstall() {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice.catch(() => {});
      state.deferredInstallPrompt = null;
      installBtn?.classList.add('hidden');
      mobileInstallBtn?.classList.add('hidden');
    }

    installBtn?.addEventListener('click', triggerInstall);
    mobileInstallBtn?.addEventListener('click', triggerInstall);
  }

  // ==================== OVERVIEW WIDGETS ====================
  function applyOverviewWidgets(widgets) {
    const list = Array.isArray(widgets) && widgets.length > 0 ? widgets : DEFAULT_OVERVIEW_WIDGETS;
    state.overviewWidgets = list.map((w) => ({ ...w }));

    const container = document.getElementById('overview-widgets-container');
    if (container) {
      const byId = new Map();
      container.querySelectorAll('[data-widget-id]').forEach((el) => {
        byId.set(el.dataset.widgetId, el);
      });

      const visibleSet = new Set();
      state.overviewWidgets.forEach((w) => {
        const el = byId.get(w.id);
        if (!el) return;
        el.classList.toggle('hidden', !w.visible);
        if (w.visible) visibleSet.add(w.id);
        container.appendChild(el);
      });

      const telemetryEl = byId.get('telemetry');
      const mediaEl = byId.get('media');
      if (telemetryEl) telemetryEl.classList.toggle('widget-wide', visibleSet.has('telemetry') && !visibleSet.has('media'));
      if (mediaEl) mediaEl.classList.toggle('widget-wide', visibleSet.has('media') && !visibleSet.has('telemetry'));

      const svcEl = byId.get('services');
      const dockerEl = byId.get('docker');
      if (svcEl) svcEl.classList.toggle('widget-wide', visibleSet.has('services') && !visibleSet.has('docker'));
      if (dockerEl) dockerEl.classList.toggle('widget-wide', visibleSet.has('docker') && !visibleSet.has('services'));
    }

    renderWidgetCustomizer();
  }

  function renderWidgetCustomizer() {
    const listEl = document.getElementById('overview-widget-config-list');
    if (!listEl) return;
    listEl.innerHTML = state.overviewWidgets
      .map((w, idx) => `
        <div class="widget-config-row">
          <label class="widget-config-label">
            <input type="checkbox" data-toggle-widget="${escapeHtml(w.id)}" ${w.visible ? 'checked' : ''} />
            <span>${escapeHtml(w.label)}</span>
          </label>
          <div style="display:flex;gap:4px;">
            <button type="button" class="btn-secondary btn-xs" data-move-widget="${escapeHtml(w.id)}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} title="Nach oben">↑</button>
            <button type="button" class="btn-secondary btn-xs" data-move-widget="${escapeHtml(w.id)}" data-dir="1" ${idx === state.overviewWidgets.length - 1 ? 'disabled' : ''} title="Nach unten">↓</button>
          </div>
        </div>
      `)
      .join('');
  }

  function stopHostPolling() {
    if (state.hostPollTimer) {
      clearInterval(state.hostPollTimer);
      state.hostPollTimer = null;
    }
  }

  function closeMobileMoreSheet() {
    document.getElementById('mobile-more-sheet')?.classList.add('hidden');
    document.getElementById('mobile-more-backdrop')?.classList.add('hidden');
    document.getElementById('btn-mobile-more')?.setAttribute('aria-expanded', 'false');
  }

  function initMobileNav() {
    const moreBtn = document.getElementById('btn-mobile-more');
    const closeBtn = document.getElementById('btn-mobile-more-close');
    const backdrop = document.getElementById('mobile-more-backdrop');
    const sheet = document.getElementById('mobile-more-sheet');

    moreBtn?.addEventListener('click', () => {
      const isOpen = sheet && !sheet.classList.contains('hidden');
      if (isOpen) {
        closeMobileMoreSheet();
      } else {
        const hostSub = document.getElementById('host-subtitle')?.textContent;
        const specEl = document.getElementById('mobile-sheet-host-spec');
        if (specEl && hostSub) specEl.textContent = hostSub;
        sheet?.classList.remove('hidden');
        backdrop?.classList.remove('hidden');
        moreBtn.setAttribute('aria-expanded', 'true');
      }
    });

    closeBtn?.addEventListener('click', closeMobileMoreSheet);
    backdrop?.addEventListener('click', closeMobileMoreSheet);

    document.querySelectorAll('.mobile-nav-btn[data-view], .mobile-sheet-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.view;
        if (target) {
          switchView(target);
          closeMobileMoreSheet();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    });
  }

  function activateSubTab(group, target) {
    document.querySelectorAll(`.view-subtab[data-subtab-group="${group}"]`).forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.subtabTarget === target);
    });
    document.querySelectorAll(`.subtab-panel[data-subtab-group="${group}"]`).forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.subtabPanel === target);
    });
    try {
      localStorage.setItem(`hs_subtab_${group}`, target);
    } catch {}
  }

  function initSubTabs() {
    document.querySelectorAll('.view-subtab[data-subtab-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activateSubTab(btn.dataset.subtabGroup, btn.dataset.subtabTarget);
      });
    });
    document.querySelectorAll('[data-subtab-bar]').forEach((bar) => {
      const group = bar.dataset.subtabBar;
      let saved = null;
      try { saved = localStorage.getItem(`hs_subtab_${group}`); } catch {}
      if (saved && bar.querySelector(`[data-subtab-target="${saved}"]`)) {
        activateSubTab(group, saved);
      }
    });
  }

  // ==================== NAVIGATION & MODALS ====================
  function switchView(viewName) {
    state.activeView = viewName;
    const titleEl = document.getElementById('active-view-title');
    if (titleEl) titleEl.textContent = VIEW_TITLES[viewName] || 'Systemübersicht';
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    const primaryMobileViews = new Set(['overview', 'files', 'docker', 'host']);
    document.querySelectorAll('.mobile-nav-btn[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    document.getElementById('btn-mobile-more')?.classList.toggle('active', !primaryMobileViews.has(viewName));
    document.querySelectorAll('.mobile-sheet-item[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    closeMobileMoreSheet();
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });
    if (viewName !== 'host') stopHostPolling();
    if (viewName === 'overview') {
      requestAnimationFrame(() => {
        drawTelemetryChart();
        drawMediaDonut();
      });
    } else if (viewName === 'files') {
      if (state.filesTrashMode) loadTrashView();
      else loadFilesDirectory(state.filesPath);
      refreshTrashBadge();
      refreshSharesBadge();
    } else if (viewName === 'storage') {
      loadStorageHistory();
    } else if (viewName === 'smb') {
      loadSmbStatus();
    } else if (viewName === 'host') {
      loadHostStatus();
      stopHostPolling();
      state.hostPollTimer = setInterval(() => {
        if (!state.paused && state.activeView === 'host') {
          loadHostStatus();
        }
      }, 8000);
    } else if (viewName === 'portainer') {
      loadDeployedStacks();
    } else if (viewName === 'appstore') {
      loadAppCatalog();
    } else if (viewName === 'analyzer') {
      loadAnalyzerStatus();
    } else if (viewName === 'automation') {
      loadAutomationState();
      loadNotificationsState();
    } else if (viewName === 'settings') {
      loadAuthMeta();
      loadAuditLog();
    }
  }

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
    if (id === 'modal-preview') {
      document.getElementById('media-preview-stage').innerHTML = '';
      document.getElementById('preview-video-controls')?.classList.add('hidden');
      state.activePreview = null;
    }
    if (id === 'modal-terminal' && state.termSocket) {
      state.termSocket.close();
      state.termSocket = null;
    }
  }

  // ==================== STREAMING & SNAPSHOTS ====================
  async function loadTelemetryHistory(rangeSec = 0) {
    try {
      const rSec = Number(rangeSec) || 0;
      const query = rSec > 900 ? `/api/telemetry/history?rangeSec=${rSec}&limit=2500` : '/api/telemetry/history?limit=900';
      const res = await fetch(query, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const loaded = Array.isArray(data.points) ? data.points : [];
      if (rSec > 900) {
        state.longHistory = loaded;
        drawTelemetryChart();
        return;
      }
      if (loaded.length > 0) {
        const merged = [...loaded, ...state.history];
        merged.sort((a, b) => a.ts - b.ts);
        const dedup = [];
        for (const p of merged) {
          const last = dedup[dedup.length - 1];
          if (!last || p.ts - last.ts >= 500) {
            dedup.push(p);
          }
        }
        state.history = dedup.slice(-MAX_HISTORY);
        state.historyLoaded = true;
        drawTelemetryChart();
        renderNetActivityBars();
      }
    } catch {
      // ignore transient error
    }
  }

  function updateLiveIndicator() {
    const dot = document.getElementById('live-dot');
    const txt = document.getElementById('live-status-text');
    if (!dot || !txt) return;

    if (state.paused) {
      dot.classList.add('paused');
      txt.textContent = 'Pausiert';
      return;
    }

    if (!state.snapshot) {
      dot.classList.add('paused');
      txt.textContent = 'Verbinde…';
      return;
    }

    dot.classList.remove('paused');
    txt.textContent = state.transport === 'polling' ? 'Echtzeit (Sync)' : 'Echtzeit';
  }

  async function fetchSnapshotOnce() {
    if (state.paused) return false;
    try {
      const res = await fetch(`/api/snapshot`, { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      if (!state.paused) {
        if (state.transport === 'connecting') state.transport = 'polling';
        handleSnapshot(data);
      }
      return true;
    } catch {
      return false;
    }
  }

  function stopPollingFallback() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPollingFallback() {
    if (state.pollTimer) return;
    if (state.transport !== 'sse') state.transport = 'polling';
    updateLiveIndicator();
    state.pollTimer = setInterval(() => {
      if (!state.paused && Date.now() - state.lastSnapshotAt >= 900) {
        fetchSnapshotOnce();
      }
    }, 1100);
  }

  function connectStream() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
    stopPollingFallback();

    state.transport = 'connecting';
    updateLiveIndicator();

    // Load persisted timestamped history + instant snapshot immediately
    loadTelemetryHistory();
    fetchSnapshotOnce();

    const es = new EventSource(`/api/stream`);
    state.eventSource = es;

    es.onmessage = (event) => {
      if (state.paused) return;
      try {
        const parsed = JSON.parse(event.data);
        state.transport = 'sse';
        stopPollingFallback();
        handleSnapshot(parsed);
      } catch {
        // ignore malformed chunk
      }
    };

    es.onerror = () => {
      if (!state.paused) {
        state.transport = 'polling';
        startPollingFallback();
      }
      updateLiveIndicator();
    };

    // Fallback watchdog: if reverse proxy buffers SSE for >3s, run live HTTP polling transparently
    state.watchdogTimer = setInterval(() => {
      if (state.paused) return;
      if (Date.now() - state.lastSnapshotAt > 3200) {
        startPollingFallback();
      }
    }, 2000);
  }

  function handleSnapshot(data) {
    if (!data || !data.system) return;
    state.snapshot = data;
    state.lastSnapshotAt = Date.now();

    if (!state.uiSyncedFromServer && data.config?.ui) {
      state.uiSyncedFromServer = true;
      if (data.config.ui.theme) applyTheme(data.config.ui.theme, false);
      if (data.config.ui.accent) applyAccent(data.config.ui.accent, false);
      if (Array.isArray(data.config.ui.overviewWidgets)) {
        applyOverviewWidgets(data.config.ui.overviewWidgets);
      }
    }

    updateLiveIndicator();

    const ts = data.meta?.generatedAt ? new Date(data.meta.generatedAt).getTime() : Date.now();
    const pointNow = {
      ts: Number.isFinite(ts) ? ts : Date.now(),
      cpu: Number(data.system?.cpu?.usagePercent) || 0,
      ram: Number(data.system?.memory?.usedPercent) || 0,
      netRxMB: (Number(data.system?.network?.rxBytesPerSec) || 0) / (1024 * 1024),
      netTxMB: (Number(data.system?.network?.txBytesPerSec) || 0) / (1024 * 1024),
      diskReadMB: (Number(data.storage?.totals?.readBytesPerSec) || 0) / (1024 * 1024),
      diskWriteMB: (Number(data.storage?.totals?.writeBytesPerSec) || 0) / (1024 * 1024)
    };

    const prev = state.history[state.history.length - 1];
    if (!prev || pointNow.ts - prev.ts >= 500) {
      state.history.push(pointNow);
      if (state.history.length > MAX_HISTORY) state.history.shift();
    }

    renderAll();
  }

  // ==================== ALERTS & GLOBAL SEARCH ====================
  function computeAlerts(data) {
    const alerts = [];
    if (!data) return alerts;

    if (data.system.cpu.temperatureCelsius !== null && data.system.cpu.temperatureCelsius >= 78) {
      alerts.push({
        level: 'crit',
        title: `Hohe CPU-Temperatur (${data.system.cpu.temperatureCelsius.toFixed(1)} °C)`,
        actionView: 'overview'
      });
    }

    (data.storage.disks || []).forEach((d) => {
      if (d.usedPercent >= 90) {
        alerts.push({
          level: 'crit',
          title: `Festplatte "${d.label}" fast voll (${d.usedPercent.toFixed(1)}%)`,
          actionView: 'storage'
        });
      } else if (d.usedPercent >= 82) {
        alerts.push({
          level: 'warn',
          title: `Festplatte "${d.label}" zu ${d.usedPercent.toFixed(1)}% belegt`,
          actionView: 'storage'
        });
      }
      if (d.temperatureCelsius !== null && d.temperatureCelsius >= 52) {
        alerts.push({
          level: 'warn',
          title: `Festplatte "${d.label}" warm (${d.temperatureCelsius} °C)`,
          actionView: 'storage'
        });
      }
      if (!d.healthy) {
        alerts.push({
          level: 'crit',
          title: `SMART-Warnung auf "${d.label}" (${d.device})`,
          actionView: 'storage'
        });
      }
    });

    (data.docker.containers || []).forEach((c) => {
      if (c.health === 'unhealthy') {
        alerts.push({
          level: 'crit',
          title: `Container "${c.name}" meldet Unhealthy`,
          actionView: 'docker'
        });
      } else if (c.state !== 'running') {
        alerts.push({
          level: 'warn',
          title: `Container "${c.name}" ist gestoppt (${c.state})`,
          actionView: 'docker'
        });
      }
    });

    return alerts;
  }

  function renderAlertsBadge(data) {
    const alerts = computeAlerts(data);
    const badge = document.getElementById('alerts-count');
    badge.textContent = String(alerts.length);
    badge.classList.toggle('hidden', alerts.length === 0);

    const listEl = document.getElementById('alerts-list');
    if (alerts.length === 0) {
      listEl.innerHTML = `<p class="muted-text">Keine Warnungen. Alle Festplatten, Temperaturen und Container sind im grünen Bereich.</p>`;
    } else {
      listEl.innerHTML = alerts
        .map((a) => `
          <div class="alert-item">
            <div>
              <span class="tag ${a.level === 'crit' ? 'tag-crit' : 'tag-warn'}" style="margin-right:6px;">${a.level === 'crit' ? 'Kritisch' : 'Hinweis'}</span>
              <span>${escapeHtml(a.title)}</span>
            </div>
            <button class="btn-secondary btn-sm" data-alert-goto="${escapeHtml(a.actionView)}">Öffnen</button>
          </div>
        `)
        .join('');
    }
  }

  function scheduleGlobalFileSearch(rawQuery) {
    if (state.globalSearchTimer) {
      clearTimeout(state.globalSearchTimer);
      state.globalSearchTimer = null;
    }
    const trimmed = String(rawQuery || '').trim();
    if (trimmed.length < 2) {
      state.globalFileSearchResults = [];
      return;
    }
    state.globalSearchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/files/search?q=${encodeURIComponent(trimmed)}&limit=12`, { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        const curQ = (document.getElementById('global-search-input')?.value || '').trim();
        if (curQ !== trimmed) return;
        state.globalFileSearchResults = payload.items || [];
        renderGlobalSearchResults(true);
      } catch {
        // ignore search errors
      }
    }, 200);
  }

  function renderGlobalSearchResults(skipFileFetch = false) {
    const raw = (document.getElementById('global-search-input').value || '').trim();
    const q = raw.toLowerCase();
    const results = [];
    const data = state.snapshot;

    if (!skipFileFetch) {
      scheduleGlobalFileSearch(raw);
    }

    if (data) {
      (data.config?.services || []).forEach((s) => {
        if (!q || s.name.toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q)) {
          const targetUrl = safeHref(resolveServiceUrl(s.url));
          results.push({
            type: 'App',
            label: s.name,
            sub: s.url,
            action: () => {
              if (targetUrl !== '#') window.open(targetUrl, '_blank', 'noopener,noreferrer');
            }
          });
        }
      });
      (data.docker?.containers || []).forEach((c) => {
        if (!q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q)) {
          results.push({
            type: 'Container',
            label: c.name,
            sub: `${c.state} · ${c.image}`,
            action: () => { switchView('docker'); closeModal('modal-search'); }
          });
        }
      });
      (data.storage?.disks || []).forEach((d) => {
        if (!q || d.label.toLowerCase().includes(q) || d.mountpoint.toLowerCase().includes(q)) {
          results.push({
            type: 'Festplatte',
            label: d.label,
            sub: `${d.mountpoint} · ${formatBytesDecimal(d.usedBytes)} / ${formatBytesDecimal(d.totalBytes)}`,
            action: () => { state.filesTrashMode = false; switchView('files'); loadFilesDirectory(d.mountpoint); closeModal('modal-search'); }
          });
        }
      });
    }

    if (q.length >= 2 && Array.isArray(state.globalFileSearchResults)) {
      state.globalFileSearchResults.forEach((f) => {
        results.push({
          type: f.isDirectory ? 'Ordner' : 'Datei',
          label: f.name,
          sub: f.path,
          action: () => {
            closeModal('modal-search');
            state.filesTrashMode = false;
            if (f.isDirectory) {
              switchView('files');
              loadFilesDirectory(f.path);
            } else if (f.kind === 'text') {
              switchView('files');
              if (f.parentDir) loadFilesDirectory(f.parentDir);
              openTextEditor(f.path);
            } else if (['image', 'video', 'audio', 'pdf'].includes(f.kind)) {
              switchView('files');
              if (f.parentDir) loadFilesDirectory(f.parentDir);
              openMediaPreview(f.path, f.kind, f.name);
            } else {
              switchView('files');
              loadFilesDirectory(f.parentDir || '/');
            }
          }
        });
      });
    }

    const navTargets = [
      { label: 'Übersicht & Cockpit', view: 'overview' },
      { label: 'Dateimanager & Papierkorb', view: 'files' },
      { label: 'Festplatten & Blockgeräte', view: 'storage' },
      { label: 'Freigaben (SMB / Samba)', view: 'smb' },
      { label: 'Host-Prozesse, Ports & Netzwerk / VPN', view: 'host' },
      { label: 'Docker-Container verwalten', view: 'docker' },
      { label: 'Portainer & Compose Stacks', view: 'portainer' },
      { label: 'Homeserver App Store', view: 'appstore' },
      { label: 'Speicher-Analyse & Duplikate', view: 'analyzer' },
      { label: 'Automation, Watchdog & Wake-on-LAN', view: 'automation' },
      { label: 'Design, Themes & Einstellungen', view: 'settings' }
    ];
    navTargets.forEach((n) => {
      if (!q || n.label.toLowerCase().includes(q)) {
        results.push({ type: 'Bereich', label: n.label, sub: 'Navigation', action: () => { switchView(n.view); closeModal('modal-search'); } });
      }
    });

    const container = document.getElementById('global-search-results');
    if (results.length === 0) {
      container.innerHTML = `<p class="muted-text">Keine Treffer gefunden.</p>`;
      return;
    }

    container.innerHTML = '';
    results.slice(0, 14).forEach((r) => {
      const btn = document.createElement('button');
      btn.className = 'search-result-item';
      btn.innerHTML = `
        <div>
          <div style="font-weight:600;font-size:13px;">${escapeHtml(r.label)}</div>
          <div class="mono" style="font-size:11px;color:var(--text-muted);">${escapeHtml(r.sub)}</div>
        </div>
        <span class="tag">${escapeHtml(r.type)}</span>
      `;
      btn.addEventListener('click', r.action);
      container.appendChild(btn);
    });
  }

  // ==================== RENDERING ====================
  function renderAll() {
    const data = state.snapshot;
    if (!data) return;

    renderTopbar(data);
    renderAlertsBadge(data);
    renderKpis(data);
    renderHealthScore(data);
    drawTelemetryChart();
    renderMediaOverview(data);
    renderDisksGrid('overview-disks-grid', data.storage);
    renderDisksGrid('storage-disks-grid', data.storage, true);
    renderUnmountedDisks(data.storage);
    renderStoragePoolBar(data.storage);
    renderServices(data);
    renderPortainerBridge(data);
    renderDockerTables(data.docker);
    if (state.activeView === 'appstore' && state.appCatalog.length > 0) {
      renderAppCatalog();
    }
    renderSettingsView(data);
  }

  function renderTopbar(data) {
    const sys = data.system;
    document.getElementById('server-title').textContent = sys.hostname;
    document.getElementById('host-ip').textContent = sys.ipAddress;
    document.getElementById('host-subtitle').textContent =
      `${sys.os} · Kernel ${sys.kernel} · Laufzeit ${formatUptime(sys.uptimeSeconds)}`;
  }

  function renderKpis(data) {
    const { system, storage, docker } = data;

    const cpuPct = system.cpu.usagePercent;
    document.getElementById('kpi-cpu-val').textContent = `${cpuPct.toFixed(1)}%`;
    document.getElementById('kpi-cpu-load').textContent = `Load ${system.cpu.loadAvg[0].toFixed(2)}`;
    document.getElementById('kpi-cpu-temp').textContent =
      system.cpu.temperatureCelsius !== null ? `${system.cpu.temperatureCelsius.toFixed(1)} °C` : `${system.cpu.coresCount} Kerne`;
    const cpuBar = document.getElementById('kpi-cpu-bar');
    cpuBar.style.width = `${Math.min(100, cpuPct)}%`;
    cpuBar.className = `progress-fill ${cpuPct >= 85 ? 'fill-red' : cpuPct >= 65 ? 'fill-amber' : 'fill-blue'}`;
    document.getElementById('kpi-cpu-model').textContent = `${system.cpu.model} (${system.cpu.coresCount} Threads)`;
    const powerEl = document.getElementById('kpi-power-info');
    if (powerEl && system.power) {
      const p = system.power;
      const srcLabel = p.source === 'rapl' ? 'RAPL' : 'geschätzt';
      powerEl.textContent = `Strom: ~${p.watts.toFixed(1)} W · ~${p.monthlyCostEur.toFixed(2)} €/Monat (${srcLabel})`;
    }

    const mem = system.memory;
    document.getElementById('kpi-ram-pct').textContent = `${mem.usedPercent.toFixed(1)}%`;
    document.getElementById('kpi-ram-val').textContent = formatBytesBinary(mem.usedBytes);
    document.getElementById('kpi-ram-total').textContent = `von ${formatBytesBinary(mem.totalBytes)}`;
    const ramBar = document.getElementById('kpi-ram-bar');
    ramBar.style.width = `${Math.min(100, mem.usedPercent)}%`;
    ramBar.className = `progress-fill ${mem.usedPercent >= 90 ? 'fill-red' : mem.usedPercent >= 78 ? 'fill-amber' : 'fill-emerald'}`;
    const swapInfo = mem.swapTotalBytes > 0
      ? `Swap: ${formatBytesBinary(mem.swapUsedBytes)} / ${formatBytesBinary(mem.swapTotalBytes)}`
      : 'Kein Swap';
    document.getElementById('kpi-ram-cache').textContent = `Cache: ${formatBytesBinary(mem.cachedBytes)} · ${swapInfo}`;

    const net = system.network;
    const primaryIf = net.interfaces[0];
    document.getElementById('kpi-net-iface').textContent = primaryIf ? primaryIf.name : 'Netzwerk';
    document.getElementById('kpi-net-rx').textContent = formatRate(net.rxBytesPerSec);
    document.getElementById('kpi-net-tx').textContent = formatRate(net.txBytesPerSec);
    const totalRx = net.interfaces.reduce((s, i) => s + (i.totalRxBytes || 0), 0);
    const totalTx = net.interfaces.reduce((s, i) => s + (i.totalTxBytes || 0), 0);
    document.getElementById('kpi-net-total').textContent =
      `Gesamt: ↓ ${formatBytesDecimal(totalRx)} · ↑ ${formatBytesDecimal(totalTx)}`;
    renderNetActivityBars();

    const totals = storage.totals;
    document.getElementById('kpi-pool-used').textContent = formatBytesDecimal(totals.usedBytes);
    document.getElementById('kpi-pool-total').textContent = `von ${formatBytesDecimal(totals.totalBytes)}`;
    const poolBar = document.getElementById('kpi-pool-bar');
    poolBar.style.width = `${Math.min(100, totals.usedPercent)}%`;
    poolBar.className = `progress-fill ${totals.usedPercent >= 90 ? 'fill-red' : 'fill-amber'}`;
    const healthBadge = document.getElementById('kpi-pool-health');
    if (storage.warningCount > 0) {
      healthBadge.textContent = `${storage.warningCount} Warnung`;
      healthBadge.className = 'kpi-badge status-warn';
    } else {
      healthBadge.textContent = 'Alle OK';
      healthBadge.className = 'kpi-badge status-ok';
    }
    const dockerPart = docker.available
      ? `${docker.summary.running}/${docker.summary.total} Container aktiv`
      : 'Docker Socket nicht gemountet';
    document.getElementById('kpi-pool-foot').textContent = `${storage.diskCount} Festplatten · ${dockerPart}`;
  }

  function renderNetActivityBars() {
    const container = document.getElementById('net-activity-bars');
    const slice = state.history.slice(-16);
    const maxVal = Math.max(0.05, ...slice.map((p) => p.netRxMB + p.netTxMB));
    const cells = [];
    for (let i = 0; i < 16; i += 1) {
      const point = slice[slice.length - 16 + i];
      const h = point ? Math.max(10, Math.min(100, Math.round(((point.netRxMB + point.netTxMB) / maxVal) * 100))) : 8;
      cells.push(`<div class="mini-bar-cell"><div class="mini-bar-inner" style="height:${h}%"></div></div>`);
    }
    container.innerHTML = cells.join('');
  }

  function drawTelemetryChart() {
    const canvas = document.getElementById('telemetry-canvas');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 12, right: 12, bottom: 22, left: 46 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    const gridColor = getCssVar('--grid-line');
    const textColor = getCssVar('--text-muted');
    const blue = getCssVar('--accent-blue');
    const emerald = getCssVar('--accent-emerald');
    const amber = getCssVar('--accent-amber');

    const rangeSec = Number(state.chartRangeSec) || 60;
    const rangeMs = rangeSec * 1000;
    const lastHistoryPoint = state.history.length > 0 ? state.history[state.history.length - 1] : null;
    const endTs = lastHistoryPoint && Number.isFinite(lastHistoryPoint.ts) ? lastHistoryPoint.ts : Date.now();
    const startTs = endTs - rangeMs;
    const visiblePoints = state.history.filter(
      (p) => p && Number.isFinite(p.ts) && p.ts >= startTs && p.ts <= endTs
    );

    let seriesA = [];
    let seriesB = [];
    let labelA = '';
    let labelB = '';
    let colorA = blue;
    let colorB = emerald;
    let unit = '%';
    let maxY = 100;

    if (state.chartMode === 'compute') {
      seriesA = visiblePoints.map((p) => Number(p.cpu) || 0);
      seriesB = visiblePoints.map((p) => Number(p.ram) || 0);
      labelA = 'CPU-Auslastung';
      labelB = 'RAM-Belegung';
      colorA = blue;
      colorB = emerald;
      unit = '%';
      maxY = 100;
    } else {
      const rawA = state.chartMode === 'network'
        ? visiblePoints.map((p) => Number(p.netRxMB) || 0)
        : visiblePoints.map((p) => Number(p.diskReadMB) || 0);
      const rawB = state.chartMode === 'network'
        ? visiblePoints.map((p) => Number(p.netTxMB) || 0)
        : visiblePoints.map((p) => Number(p.diskWriteMB) || 0);

      labelA = state.chartMode === 'network' ? 'Empfangen (↓)' : 'Festplatten Lesen';
      labelB = state.chartMode === 'network' ? 'Senden (↑)' : 'Festplatten Schreiben';
      colorA = state.chartMode === 'network' ? blue : emerald;
      colorB = amber;

      const peakMB = Math.max(...rawA, ...rawB, 0);
      if (peakMB < 0.9) {
        seriesA = rawA.map((v) => v * 1024);
        seriesB = rawB.map((v) => v * 1024);
        unit = 'KB/s';
        const peakKB = peakMB * 1024 * 1.25;
        if (peakKB <= 100) maxY = 100;
        else if (peakKB <= 200) maxY = 200;
        else if (peakKB <= 400) maxY = 400;
        else if (peakKB <= 800) maxY = 800;
        else maxY = 1000;
      } else {
        seriesA = rawA;
        seriesB = rawB;
        unit = 'MB/s';
        maxY = Math.max(4, Math.ceil((peakMB * 1.25) / 4) * 4);
      }
    }

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = '10.5px "IBM Plex Mono", monospace';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 4;
    for (let i = 0; i <= steps; i += 1) {
      const y = pad.top + (plotH * i) / steps;
      const val = Math.round(maxY * (1 - i / steps));
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillText(`${val}`, pad.left - 7, y);
    }

    const fmtAxisTs = (ts) => (rangeSec > 900 ? formatDateTimeShort(ts) : formatTimeShort(ts));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(fmtAxisTs(startTs), pad.left, h - 16);
    if (plotW >= 240) {
      ctx.textAlign = 'center';
      ctx.fillText(fmtAxisTs(startTs + rangeMs / 2), pad.left + plotW / 2, h - 16);
    }
    ctx.textAlign = 'right';
    ctx.fillText(`${fmtAxisTs(endTs)} (${unit})`, w - pad.right, h - 16);

    function pointX(ts) {
      const ratio = rangeMs > 0 ? (ts - startTs) / rangeMs : 1;
      return pad.left + Math.max(0, Math.min(1, ratio)) * plotW;
    }

    function drawSeries(values, color, fillAlpha) {
      if (values.length === 0) return;

      if (values.length === 1) {
        const clamped = Math.max(0, Math.min(maxY, values[0]));
        const x = pointX(visiblePoints[0].ts);
        const y = pad.top + plotH - (clamped / maxY) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        return;
      }

      let firstX = pad.left;
      let lastX = pad.left;
      let lastY = pad.top + plotH;

      ctx.beginPath();
      values.forEach((v, idx) => {
        const x = pointX(visiblePoints[idx].ts);
        const clamped = Math.max(0, Math.min(maxY, v));
        const y = pad.top + plotH - (clamped / maxY) * plotH;
        if (idx === 0) {
          firstX = x;
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
        lastY = y;
      });

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.85;
      ctx.lineJoin = 'round';
      ctx.stroke();

      ctx.lineTo(lastX, pad.top + plotH);
      ctx.lineTo(firstX, pad.top + plotH);
      ctx.closePath();
      ctx.save();
      const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'transparent');
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    drawSeries(seriesA, colorA, 0.14);
    drawSeries(seriesB, colorB, 0.11);

    const lastA = seriesA[seriesA.length - 1] ?? 0;
    const lastB = seriesB[seriesB.length - 1] ?? 0;
    const fmt = (v) => {
      if (unit === '%') return `${v.toFixed(1)}%`;
      if (unit === 'KB/s') return `${v >= 100 ? Math.round(v) : v.toFixed(1)} KB/s`;
      return `${v.toFixed(1)} MB/s`;
    };

    const latestVisible = visiblePoints[visiblePoints.length - 1] || lastHistoryPoint;
    const standStr = latestVisible ? formatTimeShort(latestVisible.ts) : '—';
    const subEl = document.getElementById('telemetry-subtitle');
    if (subEl) {
      subEl.textContent = `${visiblePoints.length} Messpunkte (${Math.round(rangeSec / 60)} Min.) · Gespeichert · Stand: ${standStr}`;
    }

    const legendEl = document.getElementById('telemetry-legend');
    if (legendEl) {
      legendEl.innerHTML = `
        <span class="legend-item"><span class="legend-swatch" style="background:${colorA}"></span>${escapeHtml(labelA)}: <strong class="mono">${fmt(lastA)}</strong></span>
        <span class="legend-item"><span class="legend-swatch" style="background:${colorB}"></span>${escapeHtml(labelB)}: <strong class="mono">${fmt(lastB)}</strong></span>
        <span class="legend-item muted-text mono">Stand: ${escapeHtml(standStr)}</span>
      `;
    }
  }

  function renderMediaOverview(data) {
    const media = data.media;
    const subtitle = document.getElementById('media-summary-subtitle');
    if (!media.configured) {
      subtitle.textContent = 'Keine Medien-Ordner konfiguriert (Einstellungen → Speicherpfade)';
    } else if (media.scanning && (!media.totalFiles || media.totalFiles === 0)) {
      subtitle.textContent = `Scanne ${media.scannedPaths.length} Medien-Ordner im Hintergrund…`;
    } else {
      const standStr = media.scannedAt ? ` · Stand: ${formatDateTimeShort(media.scannedAt)}` : '';
      subtitle.textContent = `${media.scannedPaths.length} Ordner gescannt${media.truncated ? ' (Teil-Scan)' : ''}${standStr}${media.scanning ? ' · scannt weiter…' : ''}`;
    }

    document.getElementById('donut-total-size').textContent = formatBytesDecimal(media.totalBytes);
    document.getElementById('donut-total-files').textContent = `${formatNumber(media.totalFiles)} Dateien`;

    document.getElementById('overview-media-categories').innerHTML = media.categories
      .map((cat) => {
        const color = CATEGORY_COLORS[cat.id] || CATEGORY_COLORS.other;
        const topExts = Array.isArray(cat.topExtensions) && cat.topExtensions.length > 0
          ? ` · ${cat.topExtensions.slice(0, 3).map((e) => `${e.ext} (${formatBytesDecimal(e.bytes)})`).join(', ')}`
          : '';
        return `
          <div class="media-cat-row">
            <span class="media-cat-dot" style="background:${color}"></span>
            <div class="media-cat-info">
              <div class="media-cat-name">${escapeHtml(cat.label)}</div>
              <div class="media-cat-count mono">${formatNumber(cat.count)} Dateien · ${cat.percent.toFixed(1)}%${escapeHtml(topExts)}</div>
            </div>
            <div class="media-cat-size mono">${formatBytesDecimal(cat.bytes)}</div>
          </div>
        `;
      })
      .join('');

    drawMediaDonut();
  }

  function drawMediaDonut() {
    const canvas = document.getElementById('media-donut-canvas');
    if (!canvas || !state.snapshot) return;
    const dpr = window.devicePixelRatio || 1;
    const size = 160;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const categories = state.snapshot.media.categories || [];
    const total = categories.reduce((s, c) => s + c.bytes, 0);
    const cx = size / 2;
    const cy = size / 2;
    const radius = 64;
    const thickness = 16;

    if (total <= 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = getCssVar('--bg-elevated');
      ctx.lineWidth = thickness;
      ctx.stroke();
      return;
    }

    let startAngle = -Math.PI / 2;
    const gap = 0.03;
    categories.forEach((cat) => {
      if (cat.bytes <= 0) return;
      const sliceAngle = (cat.bytes / total) * Math.PI * 2;
      const drawAngle = Math.max(0.02, sliceAngle - gap);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, startAngle + drawAngle);
      ctx.strokeStyle = CATEGORY_COLORS[cat.id] || CATEGORY_COLORS.other;
      ctx.lineWidth = thickness;
      ctx.stroke();
      startAngle += sliceAngle;
    });
  }

  // ==================== DISKS & STORAGE ADMIN ====================
  function renderDisksGrid(containerId, storage, showActions = false) {
    const grid = document.getElementById(containerId);
    if (!grid) return;

    document.getElementById('total-disk-io').textContent =
      `Lesen ${formatRate(storage.totals.readBytesPerSec)} · Schreiben ${formatRate(storage.totals.writeBytesPerSec)}`;

    const standTime = storage.collectedAt ? formatTimeShort(storage.collectedAt) : '—';
    const smartTime = storage.smartCheckedAt ? formatTimeShort(storage.smartCheckedAt) : '';

    if (containerId === 'overview-disks-grid') {
      const ovSub = document.getElementById('overview-disks-subtitle');
      if (ovSub) {
        ovSub.textContent = `${storage.diskCount || 0} Laufwerke · Stand: ${standTime}${smartTime ? ` · SMART: ${smartTime}` : ''}`;
      }
    }

    if (!storage.disks || storage.disks.length === 0) {
      grid.innerHTML = `<div class="card disk-card"><p class="muted-text">Keine Festplatten erkannt.</p></div>`;
      return;
    }

    grid.innerHTML = storage.disks
      .map((disk) => {
        const pct = disk.usedPercent;
        const barClass = getProgressColorClass(pct);
        const healthTagClass = !disk.healthy ? 'tag-crit' : pct >= 90 ? 'tag-warn' : 'tag-ok';
        const tempDisplay = disk.temperatureCelsius !== null ? `${disk.temperatureCelsius} °C` : '—';
        const pohDisplay = disk.powerOnHours !== null ? `${formatNumber(disk.powerOnHours)} Std.` : disk.fsType;
        const unmountBtn = showActions && storage.allowAdmin && disk.mountpoint !== '/'
          ? `<button class="btn-secondary btn-sm" data-unmount-disk="${escapeHtml(disk.mountpoint)}">Aushängen</button>`
          : '';

        return `
          <article class="card disk-card">
            <div class="disk-top">
              <div class="disk-title-wrap">
                <div class="disk-label-row">
                  <h3 class="disk-label">${escapeHtml(disk.label)}</h3>
                  <button class="disk-edit-btn" data-edit-disk="${escapeHtml(disk.id)}" title="Laufwerk umbenennen">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                  </button>
                </div>
                <div class="disk-path mono">${escapeHtml(disk.mountpoint)} · ${escapeHtml(disk.device)}</div>
                ${showActions && disk.model ? `<div class="disk-path">${escapeHtml(disk.model)}</div>` : ''}
              </div>
              <div class="disk-badges">
                <span class="tag">${escapeHtml(disk.diskType)}</span>
                <span class="tag ${healthTagClass}">${escapeHtml(disk.smartStatus)}</span>
                ${disk.powerState === 'standby' ? '<span class="tag">Standby 💤</span>' : disk.powerState === 'active' ? '<span class="tag tag-ok">Aktiv</span>' : ''}
              </div>
            </div>

            <div>
              <div class="disk-capacity-row">
                <span class="mono"><strong>${formatBytesDecimal(disk.usedBytes)}</strong> / ${formatBytesDecimal(disk.totalBytes)}</span>
                <span class="mono">${pct.toFixed(1)}% · ${formatBytesDecimal(disk.availableBytes)} frei</span>
              </div>
              <div class="progress-track" style="margin-top:6px;">
                <div class="progress-fill ${barClass}" style="width:${Math.min(100, pct)}%"></div>
              </div>
            </div>

            <div class="disk-stats-footer mono">
              <div class="disk-stat-cell">
                <span class="disk-stat-k">I/O Durchsatz</span>
                <span class="disk-stat-v">↓${formatRate(disk.readBytesPerSec)} ↑${formatRate(disk.writeBytesPerSec)}</span>
              </div>
              <div class="disk-stat-cell">
                <span class="disk-stat-k">Temperatur</span>
                <span class="disk-stat-v">${escapeHtml(tempDisplay)}</span>
              </div>
              <div class="disk-stat-cell">
                <span class="disk-stat-k">${disk.powerOnHours !== null ? 'Laufzeit' : 'Dateisystem'}</span>
                <span class="disk-stat-v">${escapeHtml(pohDisplay)}</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span class="mono" style="font-size:10.5px;color:var(--text-muted);">Stand: ${escapeHtml(standTime)}${smartTime ? ` · SMART: ${escapeHtml(smartTime)}` : ''}</span>
              ${unmountBtn}
            </div>
          </article>
        `;
      })
      .join('');
  }

  function renderUnmountedDisks(storage) {
    const missingBanner = document.getElementById('storage-missing-mounts-banner');
    const missingList = document.getElementById('storage-missing-mounts-list');
    const missing = storage.missingHostMounts || [];
    if (missingBanner && missingList) {
      missingBanner.classList.toggle('hidden', missing.length === 0);
      if (missing.length > 0) {
        missingList.textContent = missing.join(' · ');
      }
    }

    const sec = document.getElementById('unmounted-section');
    const grid = document.getElementById('unmounted-disks-grid');
    const unmounted = storage.unmountedDevices || [];
    sec.classList.toggle('hidden', unmounted.length === 0);
    if (unmounted.length === 0) return;

    grid.innerHTML = unmounted
      .map((d) => `
        <article class="card disk-card">
          <div class="disk-top">
            <div>
              <h3 class="disk-label">${escapeHtml(d.model)}</h3>
              <div class="disk-path mono">${escapeHtml(d.devPath)} · ${escapeHtml(d.tran.toUpperCase())}</div>
            </div>
            <span class="tag tag-warn">Nicht gemountet</span>
          </div>
          <div class="disk-capacity-row">
            <span class="mono">Kapazität: <strong>${formatBytesDecimal(d.sizeBytes)}</strong></span>
            <span class="tag">${escapeHtml(d.diskType)}</span>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
            <button class="btn-secondary btn-sm" data-format-dev="${escapeHtml(d.devPath)}">Formatieren (ext4)</button>
            <button class="btn-primary btn-sm" data-mount-dev="${escapeHtml(d.devPath)}">Mounten</button>
          </div>
        </article>
      `)
      .join('');
  }

  function renderStoragePoolBar(storage) {
    const barEl = document.getElementById('storage-segmented-bar');
    const legendEl = document.getElementById('storage-segmented-legend');
    const totalCap = storage.totals.totalBytes || 1;

    const lastUpdatedEl = document.getElementById('storage-last-updated');
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = `Stand: ${storage.collectedAt ? formatDateTimeShort(storage.collectedAt) : '—'}`;
    }
    const storageSubEl = document.getElementById('storage-subtitle');
    if (storageSubEl) {
      const smartInfo = storage.smartCheckedAt
        ? ` · Letzter SMART-Check: ${formatDateTimeShort(storage.smartCheckedAt)}`
        : '';
      storageSubEl.textContent = `${storage.diskCount || 0} gemountete Laufwerke · Kapazitäten, SMART & I/O${smartInfo}`;
    }

    document.getElementById('storage-total-badge').textContent =
      `${formatBytesDecimal(storage.totals.usedBytes)} / ${formatBytesDecimal(storage.totals.totalBytes)}`;
    document.getElementById('storage-pool-pct-label').textContent =
      `${storage.totals.usedPercent.toFixed(1)}% gesamt belegt`;

    barEl.innerHTML = storage.disks
      .map((disk, idx) => {
        const sharePct = (disk.usedBytes / totalCap) * 100;
        const color = DISK_PALETTE[idx % DISK_PALETTE.length];
        return `<div class="pool-segment" style="width:${sharePct.toFixed(2)}%;background:${color}" title="${escapeHtml(disk.label)}: ${formatBytesDecimal(disk.usedBytes)}"></div>`;
      })
      .join('');

    legendEl.innerHTML = storage.disks
      .map((disk, idx) => {
        const color = DISK_PALETTE[idx % DISK_PALETTE.length];
        return `
          <span class="legend-item">
            <span class="legend-swatch" style="background:${color}"></span>
            ${escapeHtml(disk.label)} <strong class="mono">${formatBytesDecimal(disk.usedBytes)}</strong>
          </span>
        `;
      })
      .join('');
  }

  async function loadStorageHistory() {
    try {
      const res = await fetch('/api/storage/history?limit=40', { cache: 'no-store' });
      if (!res.ok) return;
      renderStorageHistory(await res.json());
    } catch {
      // ignore transient error
    }
  }

  function renderStorageHistory(historyData) {
    const tbody = document.getElementById('storage-history-tbody');
    const meta = document.getElementById('storage-history-meta');
    if (!tbody) return;
    const entries = historyData?.entries || [];
    if (meta) {
      meta.textContent = historyData?.lastRecordedAt
        ? `${entries.length} gespeicherte Messpunkte · Letzter Stand: ${new Date(historyData.lastRecordedAt).toLocaleString('de-DE')}`
        : 'Noch keine Messpunkte gespeichert';
    }
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted-text">Noch keine gespeicherten Snapshots vorhanden.</td></tr>`;
      return;
    }
    tbody.innerHTML = entries
      .slice(0, 25)
      .map((entry) => {
        const tsStr = entry.ts ? new Date(entry.ts).toLocaleString('de-DE') : '—';
        const diskSummary = (entry.disks || [])
          .map((d) => `${escapeHtml(d.label || d.mountpoint)}: ${formatBytesDecimal(d.usedBytes)} / ${formatBytesDecimal(d.totalBytes)} (${Number(d.usedPercent || 0).toFixed(1)}%)`)
          .join(' · ');
        return `
          <tr>
            <td class="mono" style="white-space:nowrap;">${escapeHtml(tsStr)}</td>
            <td class="num mono">${formatBytesDecimal(entry.usedBytes)} / ${formatBytesDecimal(entry.totalBytes)} (${Number(entry.usedPercent || 0).toFixed(1)}%)</td>
            <td style="font-size:12px;color:var(--text-secondary);">${diskSummary || '—'}</td>
          </tr>
        `;
      })
      .join('');
  }

  // ==================== SMB SHARES ====================
  async function loadSmbStatus() {
    const res = await fetch(`/api/smb/status`);
    if (!res.ok) return;
    state.smbData = await res.json();
    renderSmbPanel();
  }

  function renderSmbPanel() {
    if (!state.smbData) return;
    const badge = document.getElementById('smb-running-badge');
    badge.textContent = state.smbData.running ? 'Samba aktiv' : 'Nicht aktiv';
    badge.className = `tag ${state.smbData.running ? 'tag-ok' : ''}`;

    document.getElementById('smb-username').value = state.smbData.config.username || 'homeserver';
    const ip = state.snapshot?.system?.ipAddress || window.location.hostname || 'server';

    const tbody = document.getElementById('smb-shares-tbody');
    const shares = state.smbData.config.shares || [];
    if (shares.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted-text">Keine SMB-Freigaben definiert. Klicke auf "+ Freigabe".</td></tr>`;
      return;
    }

    tbody.innerHTML = shares
      .map((s, idx) => `
        <tr>
          <td><input type="text" class="input-sm smb-name-input" data-smb-idx="${idx}" value="${escapeHtml(s.name)}" style="min-width:120px;" /></td>
          <td><input type="text" class="input-sm mono smb-path-input" data-smb-idx="${idx}" value="${escapeHtml(s.path)}" style="min-width:160px;" /></td>
          <td class="mono" style="font-size:11.5px;color:var(--text-secondary);">\\\\${escapeHtml(ip)}\\${escapeHtml(s.name)}<br/>smb://${escapeHtml(ip)}/${escapeHtml(s.name)}</td>
          <td>
            <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;">
              <input type="checkbox" class="smb-ro-input" data-smb-idx="${idx}" ${s.readOnly ? 'checked' : ''} />
              Nur Lesen
            </label>
          </td>
          <td class="num">
            <button class="btn-danger-ghost btn-sm" data-del-smb="${idx}">Entfernen</button>
          </td>
        </tr>
      `)
      .join('');
  }

  // ==================== SERVICES & DOCKER ====================
  function resolveServiceUrl(rawUrl) {
    if (!rawUrl) return '#';
    if (rawUrl.includes('localhost') && window.location.hostname && window.location.hostname !== 'localhost') {
      return rawUrl.replace('localhost', window.location.hostname);
    }
    return rawUrl;
  }

  function renderServices(data) {
    const services = data.config?.services || [];
    const containers = data.docker?.containers || [];
    const grid = document.getElementById('overview-services-grid');

    if (services.length === 0) {
      grid.innerHTML = `<p class="muted-text">Noch keine Dienste hinterlegt.</p>`;
      return;
    }

    grid.innerHTML = services
      .map((svc) => {
        let statusClass = '';
        if (svc.containerMatch && containers.length > 0) {
          const match = containers.find((c) => c.name.toLowerCase().includes(svc.containerMatch.toLowerCase()));
          if (match) statusClass = match.state === 'running' ? 'up' : 'down';
        }
        const href = safeHref(resolveServiceUrl(svc.url));
        return `
          <a class="service-tile" href="${escapeHtml(href)}" ${href !== '#' ? 'target="_blank" rel="noopener noreferrer"' : ''}>
            <div>
              <div class="service-top">
                <div class="service-name-wrap">
                  <span class="status-dot ${statusClass}"></span>
                  <span class="service-name">${escapeHtml(svc.name)}</span>
                </div>
                <span class="service-cat">${escapeHtml(svc.category || '')}</span>
              </div>
              ${svc.description ? `<p class="service-desc" style="margin-top:6px;">${escapeHtml(svc.description)}</p>` : ''}
            </div>
            <div class="service-url mono">${escapeHtml(href)} ↗</div>
          </a>
        `;
      })
      .join('');
  }

  function getPortainerBaseUrl() {
    const p = state.snapshot?.portainer;
    const raw = p?.url || p?.detectedUrl || '';
    return raw ? safeHref(resolveServiceUrl(raw)).replace(/\/+$/, '') : '';
  }

  function renderPortainerBridge(data) {
    const p = data.portainer || {};
    const badge = document.getElementById('portainer-status-badge');
    const subtitle = document.getElementById('portainer-bridge-subtitle');
    const openBtn = document.getElementById('btn-open-portainer');
    const grid = document.getElementById('portainer-stacks-grid');
    if (!badge || !grid) return;

    const baseUrl = getPortainerBaseUrl();
    if (baseUrl && baseUrl !== '#') {
      openBtn.href = baseUrl;
      openBtn.classList.remove('hidden');
    } else {
      openBtn.classList.add('hidden');
    }

    if (p.connected) {
      badge.textContent = `Verbunden · ${p.endpointName || 'local'}`;
      badge.className = 'tag tag-ok';
      subtitle.textContent = `${p.stacks?.length || 0} Portainer-Stacks über Portainer API verwaltet (Single Source of Truth)`;
    } else if (p.error) {
      badge.textContent = 'Hinweis';
      badge.className = 'tag tag-warn';
      subtitle.textContent = p.error;
    } else if (p.configured && data.config?.hasPortainerApiKey) {
      badge.textContent = 'Verbinde…';
      badge.className = 'tag';
      subtitle.textContent = 'Prüfe Verbindung zur Portainer API…';
    } else if (baseUrl && baseUrl !== '#') {
      badge.textContent = 'Erkannt (ohne Token)';
      badge.className = 'tag';
      subtitle.textContent = 'Portainer läuft. Hinterlege optional ein API-Token unter Einstellungen, um Stacks direkt hier zu steuern.';
    } else {
      badge.textContent = 'Nicht konfiguriert';
      badge.className = 'tag';
      subtitle.textContent = 'Hinterlege deine Portainer-URL unter Einstellungen für Stack-Übersicht und direkte Deep-Links.';
    }

    const stacks = p.stacks || [];
    if (stacks.length === 0) {
      const grouped = new Set((data.docker?.containers || []).map((c) => c.stackName).filter(Boolean));
      if (grouped.size > 0) {
        grid.innerHTML = [...grouped]
          .map((name) => `
            <article class="stack-inset-item">
              <div class="disk-top">
                <div>
                  <h3 class="disk-label">${escapeHtml(name)}</h3>
                  <div class="disk-path mono">Compose / Portainer Stack</div>
                </div>
                <span class="tag">Erkannt</span>
              </div>
              <div style="display:flex;justify-content:flex-end;">
                ${baseUrl && baseUrl !== '#' ? `<a class="btn-secondary btn-sm" href="${escapeHtml(baseUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">In Portainer öffnen ↗</a>` : `<button class="btn-secondary btn-sm" data-goto="settings">Token hinterlegen</button>`}
              </div>
            </article>
          `)
          .join('');
      } else {
        grid.innerHTML = `<div class="stack-inset-item"><p class="muted-text">Keine Portainer-Stacks gefunden oder API-Token nicht gesetzt.</p></div>`;
      }
      return;
    }

    grid.innerHTML = stacks
      .map((s) => {
        const isActive = s.status === 1;
        const deepLink = baseUrl && baseUrl !== '#' && s.deepLink ? safeHref(resolveServiceUrl(s.deepLink)) : '';
        return `
          <article class="stack-inset-item">
            <div class="disk-top">
              <div>
                <h3 class="disk-label">${escapeHtml(s.name)}</h3>
                <div class="disk-path mono">${escapeHtml(s.type || 'Compose')} · ${s.runningCount}/${s.containerCount} Container</div>
              </div>
              <span class="tag ${isActive ? 'tag-ok' : 'tag-crit'}">${escapeHtml(s.statusLabel || (isActive ? 'Aktiv' : 'Inaktiv'))}</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
              ${isActive
                ? `<button class="btn-secondary btn-sm" data-portainer-stack-action="stop" data-pstack-id="${escapeHtml(s.id)}">Stop</button>`
                : `<button class="btn-secondary btn-sm" data-portainer-stack-action="start" data-pstack-id="${escapeHtml(s.id)}">Start</button>`}
              ${deepLink && deepLink !== '#' ? `<a class="btn-primary btn-sm" href="${escapeHtml(deepLink)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">In Portainer ↗</a>` : ''}
            </div>
          </article>
        `;
      })
      .join('');
  }

  function renderDockerTables(docker) {
    const overviewSubtitle = document.getElementById('docker-overview-subtitle');
    const fullSubtitle = document.getElementById('docker-full-subtitle');

    if (!docker.available) {
      const msg = docker.reason || 'Docker API nicht verfügbar';
      overviewSubtitle.textContent = msg;
      fullSubtitle.textContent = msg;
      const emptyRow = `<tr><td colspan="7" class="muted-text">${escapeHtml(msg)}</td></tr>`;
      document.getElementById('overview-docker-tbody').innerHTML = emptyRow;
      document.getElementById('docker-full-tbody').innerHTML = emptyRow;
      return;
    }

    const summaryText = `${docker.summary.running} aktiv · ${docker.summary.stopped} gestoppt`;
    const standOverview = docker.collectedAt ? ` · Stand: ${formatTimeShort(docker.collectedAt)}` : '';
    const standFull = docker.collectedAt ? ` · Stand: ${formatDateTimeShort(docker.collectedAt)}` : '';
    const updCheckStr = docker.lastUpdateCheckAt
      ? ` · Letzter Update-Check: ${formatDateTimeShort(docker.lastUpdateCheckAt)}`
      : ' · Update-Check: ausstehend';
    overviewSubtitle.textContent = `${summaryText}${standOverview}`;
    fullSubtitle.textContent = `${summaryText}${docker.allowControl ? ' · Portainer & Vollsteuerung aktiv' : ' · Nur-Lese-Modus'}${standFull}${updCheckStr}`;

    const searchOverview = (document.getElementById('overview-docker-search').value || '').toLowerCase();
    const overviewContainers = docker.containers
      .filter((c) => !searchOverview || c.name.toLowerCase().includes(searchOverview) || c.image.toLowerCase().includes(searchOverview))
      .slice(0, 8);

    const renderPortBadges = (ports) => {
      if (!ports || ports.length === 0) return '<span class="muted-text">—</span>';
      return ports
        .slice(0, 2)
        .map((p) => {
          const host = window.location.hostname || 'localhost';
          const href = `http://${host}:${p.publicPort}`;
          return `<a class="port-link mono" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.label)}</a>`;
        })
        .join('');
    };

    const renderStateBadge = (c) => {
      const cls = c.state === 'running' ? (c.health === 'unhealthy' ? 'tag-warn' : 'tag-ok') : 'tag-crit';
      const label = c.state === 'running' ? (c.health === 'healthy' ? 'Healthy' : c.health === 'unhealthy' ? 'Unhealthy' : 'Aktiv') : c.state;
      return `<span class="tag ${cls}">${escapeHtml(label)}</span>`;
    };

    document.getElementById('overview-docker-tbody').innerHTML = overviewContainers
      .map((c) => `
        <tr>
          <td>
            <div class="container-name">
              ${escapeHtml(c.name)}
              ${c.stackName ? `<span class="tag" style="margin-left:5px;font-size:10px;">Stack: ${escapeHtml(c.stackName)}</span>` : ''}
            </div>
            <div class="container-sub mono">${escapeHtml(c.image)}</div>
          </td>
          <td>${renderStateBadge(c)}</td>
          <td class="num mono">${c.state === 'running' ? `${c.cpuPercent.toFixed(1)}%` : '—'}</td>
          <td class="num mono">${c.state === 'running' ? formatBytesBinary(c.memoryBytes) : '—'}</td>
          <td>${renderPortBadges(c.ports)}</td>
          <td class="num">
            <button class="btn-secondary btn-sm" data-view-logs="${escapeHtml(c.id)}" data-container-name="${escapeHtml(c.name)}">Logs</button>
          </td>
        </tr>
      `)
      .join('');

    const fullSearch = (document.getElementById('docker-full-search').value || '').toLowerCase();
    const filteredFull = docker.containers.filter((c) => {
      if (state.dockerFilter === 'running' && c.state !== 'running') return false;
      if (state.dockerFilter === 'stopped' && c.state === 'running') return false;
      if (fullSearch && !c.name.toLowerCase().includes(fullSearch) && !c.image.toLowerCase().includes(fullSearch) && !(c.stackName || '').toLowerCase().includes(fullSearch)) return false;
      return true;
    });

    const portainerBase = getPortainerBaseUrl();
    const endpointId = state.snapshot?.portainer?.endpointId || 1;

    const policies = docker.autoUpdate?.policies || {};
    document.getElementById('docker-full-tbody').innerHTML = filteredFull
      .map((c) => {
        const controlBtns = docker.allowControl
          ? c.state === 'running'
            ? `<button class="btn-secondary btn-sm" data-open-term="${escapeHtml(c.id)}" data-cname="${escapeHtml(c.name)}" title="Shell-Terminal öffnen">&gt;_</button>
               <button class="btn-secondary btn-sm" data-docker-action="restart" data-cid="${escapeHtml(c.id)}">Neustart</button>
               <button class="btn-secondary btn-sm" data-docker-action="stop" data-cid="${escapeHtml(c.id)}">Stop</button>`
            : `<button class="btn-secondary btn-sm" data-docker-action="start" data-cid="${escapeHtml(c.id)}">Start</button>
               <button class="btn-danger-ghost btn-sm" data-docker-action="remove" data-cid="${escapeHtml(c.id)}" data-cname="${escapeHtml(c.name)}">Löschen</button>`
          : '';
        const editUpdateBtns = docker.allowControl
          ? `<button class="btn-secondary btn-sm" data-edit-container="${escapeHtml(c.id)}" title="Ports/Volumes bearbeiten">Bearbeiten</button>
             <button class="btn-secondary btn-sm" data-update-container="${escapeHtml(c.id)}" data-cname="${escapeHtml(c.name)}" title="Neuestes Image ziehen & neu starten">Update</button>`
          : '';
        const portainerLink = portainerBase && portainerBase !== '#' && c.fullId
          ? `<a class="btn-secondary btn-sm" href="${escapeHtml(safeHref(`${portainerBase}/#!/${endpointId}/docker/containers/${c.fullId}`))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;" title="In Portainer öffnen">Portainer ↗</a>`
          : '';
        const updTitle = c.updateCheckedAt
          ? `Neueres Image in der Registry verfügbar (geprüft: ${formatDateTimeShort(c.updateCheckedAt)}) — klicken zum Updaten`
          : 'Neueres Image in der Registry verfügbar — klicken zum Updaten';
        const policy = policies[c.name] || 'off';
        const memLimitText = c.configuredMemoryLimitBytes
          ? `Limit ${formatBytesBinary(c.configuredMemoryLimitBytes)}`
          : (c.state === 'running' ? '<span class="tag tag-warn" style="font-size:10px;">Kein RAM-Limit</span>' : '');
        const oomBadge = c.oomKilled
          ? '<span class="tag tag-crit" style="margin-left:5px;font-size:10px;">OOMKilled</span>'
          : '';
        return `
          <tr>
            <td>
              <div class="container-name">
                ${escapeHtml(c.name)}
                ${c.stackName ? `<span class="tag" style="margin-left:5px;font-size:10px;">Stack: ${escapeHtml(c.stackName)}</span>` : ''}
                ${oomBadge}
                ${c.updateAvailable ? `<button type="button" class="tag tag-warn" data-open-update-details="available" title="${escapeHtml(updTitle)} — Klicken für Details &amp; Update" style="margin-left:5px;font-size:10px;cursor:pointer;">Update verfügbar</button>` : ''}
              </div>
              <div class="container-sub mono">${escapeHtml(c.statusText)}${c.restartCount > 0 ? ` · ${c.restartCount} Restarts` : ''}</div>
            </td>
            <td class="mono docker-img-cell" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</td>
            <td>${renderStateBadge(c)}</td>
            <td class="num mono">${c.state === 'running' ? `${c.cpuPercent.toFixed(1)}%` : '—'}</td>
            <td class="num mono">
              <div>${c.state === 'running' ? formatBytesBinary(c.memoryBytes) : '—'}</div>
              ${memLimitText ? `<div style="font-size:10.5px;color:var(--text-muted);">${memLimitText}</div>` : ''}
            </td>
            <td>${renderPortBadges(c.ports)}</td>
            <td>
              <select class="input-sm" data-autoupdate-policy="${escapeHtml(c.name)}" style="min-width:96px;padding:3px 6px;font-size:11.5px;">
                <option value="off"${policy === 'off' ? ' selected' : ''}>Aus</option>
                <option value="notify"${policy === 'notify' ? ' selected' : ''}>Melden</option>
                <option value="auto"${policy === 'auto' ? ' selected' : ''}>Auto</option>
              </select>
            </td>
            <td class="num">
              <div class="table-actions-row">
                ${controlBtns}
                ${editUpdateBtns}
                <button class="btn-secondary btn-sm" data-view-logs="${escapeHtml(c.id)}" data-container-name="${escapeHtml(c.name)}">Logs</button>
                ${portainerLink}
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    const oomSummaryEl = document.getElementById('docker-oom-summary');
    const oomTbody = document.getElementById('docker-oom-tbody');
    if (oomSummaryEl && oomTbody) {
      const noLimitCount = docker.containers.filter((c) => c.state === 'running' && !c.configuredMemoryLimitBytes).length;
      const oomList = Array.isArray(docker.oomHistory) ? docker.oomHistory : [];
      oomSummaryEl.textContent = `${noLimitCount} laufende Container ohne Memory-Limit · ${oomList.length} erkannte OOMKilled-Ereignisse`;
      if (oomList.length === 0) {
        oomTbody.innerHTML = '<tr><td colspan="5" class="muted-text">Bisher keine Out-of-Memory (OOMKilled) Neustarts erkannt.</td></tr>';
      } else {
        oomTbody.innerHTML = oomList
          .slice(0, 30)
          .map((ev) => `
            <tr>
              <td class="mono">${escapeHtml(formatDateTimeShort(ev.ts))}</td>
              <td><strong>${escapeHtml(ev.name)}</strong></td>
              <td class="mono">${escapeHtml(ev.image || '—')}</td>
              <td class="mono">${ev.memoryLimitBytes ? formatBytesBinary(ev.memoryLimitBytes) : 'Kein Limit'} · ${ev.restartCount || 0} Restarts</td>
              <td><span class="tag tag-crit">OOMKilled</span></td>
            </tr>
          `)
          .join('');
      }
    }
  }

  // ==================== FILES MANAGER, SHARES & TRASH ====================
  async function refreshTrashBadge() {
    try {
      const res = await fetch('/api/files/trash');
      if (!res.ok) return;
      const data = await res.json();
      const badge = document.getElementById('trash-count-badge');
      if (badge) badge.textContent = String((data.items || []).length);
    } catch {
      // ignore
    }
  }

  async function refreshSharesBadge() {
    try {
      const res = await fetch('/api/shares', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      state.sharesList = data.shares || [];
      const badge = document.getElementById('shares-count-badge');
      if (badge) badge.textContent = String(state.sharesList.length);
    } catch {
      // ignore
    }
  }

  function openShareModal(targetPath, targetName) {
    document.getElementById('share-target-path').value = targetPath;
    document.getElementById('share-target-name').textContent = targetName || targetPath;
    document.getElementById('share-ttl').value = '168';
    document.getElementById('share-password').value = '';
    document.getElementById('share-result-url').value = '';
    document.getElementById('share-result-box').classList.add('hidden');
    openModal('modal-share');
  }

  async function openSharesListModal() {
    await refreshSharesBadge();
    renderSharesListModal();
    openModal('modal-shares-list');
  }

  function renderSharesListModal() {
    const tbody = document.getElementById('shares-list-tbody');
    if (!tbody) return;
    const shares = state.sharesList || [];
    if (shares.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted-text">Keine aktiven Freigabe-Links vorhanden.</td></tr>`;
      return;
    }
    tbody.innerHTML = shares
      .map((s) => {
        const shareUrl = `${window.location.origin}/s/${s.token}`;
        const expText = s.expiresAt ? new Date(s.expiresAt).toLocaleString('de-DE') : 'Unbegrenzt';
        return `
          <tr>
            <td>
              <div style="font-weight:600;">${s.isDirectory ? '📁' : '📄'} ${escapeHtml(s.name)}</div>
              <div class="mono" style="font-size:11px;color:var(--text-muted);">${escapeHtml(s.targetPath)}</div>
            </td>
            <td><span class="tag ${s.hasPassword ? 'tag-ok' : ''}">${s.hasPassword ? 'Passwort' : 'Öffentlich'}</span></td>
            <td class="mono" style="font-size:11.5px;">${escapeHtml(expText)}</td>
            <td class="num mono">${Number(s.downloads) || 0}</td>
            <td class="num">
              <div class="table-actions-row">
                <button type="button" class="btn-secondary btn-sm" data-copy-share-link="${escapeHtml(shareUrl)}">Link kopieren</button>
                <a class="btn-secondary btn-sm" href="${escapeHtml(safeHref(shareUrl))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Öffnen ↗</a>
                <button type="button" class="btn-danger-ghost btn-sm" data-revoke-share="${escapeHtml(s.id)}">Widerrufen</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  async function runGlobalFilesSearch(queryText) {
    const q = String(queryText || '').trim();
    if (!q) {
      state.filesGlobalResults = null;
      renderFilesView();
      return;
    }
    try {
      const res = await fetch(`/api/files/search?q=${encodeURIComponent(q)}&limit=100`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Globale Suche fehlgeschlagen');
      const data = await res.json();
      if ((document.getElementById('files-search')?.value || '').trim() !== q) return;
      state.filesGlobalResults = data;
      renderFilesView();
    } catch {
      state.filesGlobalResults = null;
      renderFilesView();
    }
  }

  async function loadFilesDirectory(targetPath) {
    state.filesTrashMode = false;
    state.filesPath = targetPath || '/';
    state.selectedFiles.clear();
    updateBulkBar();
    document.getElementById('btn-files-trash')?.classList.remove('active');
    document.getElementById('files-trash-bar')?.classList.add('hidden');
    document.getElementById('files-trash-container')?.classList.add('hidden');
    document.getElementById('files-header-actions')?.classList.remove('hidden');

    startGlobalProgress();
    setInlineProgress('files-load-progress', { active: true, label: `Lade ${state.filesPath}…` });
    try {
      const res = await fetch(`/api/files/list?path=${encodeURIComponent(state.filesPath)}`);
      if (!res.ok) throw new Error('Ordner konnte nicht geladen werden');
      state.filesListing = await res.json();
      renderFilesView();
    } catch (err) {
      document.getElementById('files-tbody').innerHTML = `<tr><td colspan="6" class="form-error">${escapeHtml(err.message)}</td></tr>`;
    } finally {
      setInlineProgress('files-load-progress', { active: false });
      endGlobalProgress();
    }
  }

  async function loadTrashView() {
    state.filesTrashMode = true;
    state.selectedTrashKeys.clear();
    document.getElementById('btn-files-trash')?.classList.add('active');
    document.querySelectorAll('#files-roots-list .file-root-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('files-bulk-bar')?.classList.add('hidden');
    document.getElementById('files-list-container')?.classList.add('hidden');
    document.getElementById('files-grid-container')?.classList.add('hidden');
    document.getElementById('files-trash-bar')?.classList.remove('hidden');
    document.getElementById('files-trash-container')?.classList.remove('hidden');
    document.getElementById('files-breadcrumbs').innerHTML = `<button class="crumb-btn" data-open-dir="/">Laufwerke</button><span class="crumb-sep">/</span><span class="tag">Papierkorb</span>`;

    try {
      const res = await fetch('/api/files/trash');
      if (!res.ok) throw new Error('Papierkorb konnte nicht geladen werden');
      state.trashListing = await res.json();
      renderTrashView();
    } catch (err) {
      document.getElementById('files-trash-tbody').innerHTML = `<tr><td colspan="6" class="form-error">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function updateTrashBulkBar() {
    const count = state.selectedTrashKeys.size;
    document.getElementById('btn-trash-restore-sel')?.classList.toggle('hidden', count === 0);
    document.getElementById('btn-trash-delete-sel')?.classList.toggle('hidden', count === 0);
  }

  function renderTrashView() {
    const data = state.trashListing || { items: [] };
    const items = data.items || [];
    const badge = document.getElementById('trash-count-badge');
    if (badge) badge.textContent = String(items.length);

    const search = (document.getElementById('files-search').value || '').toLowerCase();
    const filtered = items.filter((i) => !search || i.name.toLowerCase().includes(search) || (i.originalPath || '').toLowerCase().includes(search));

    const tbody = document.getElementById('files-trash-tbody');
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted-text">Der Papierkorb ist leer.</td></tr>`;
      updateTrashBulkBar();
      return;
    }

    tbody.innerHTML = filtered
      .map((item) => {
        const checked = state.selectedTrashKeys.has(item.trashKey) ? 'checked' : '';
        const delStr = item.deletedAt ? new Date(item.deletedAt).toLocaleString('de-DE') : '—';
        return `
          <tr>
            <td><input type="checkbox" class="trash-select-cb" data-trash-key="${escapeHtml(item.trashKey)}" ${checked} /></td>
            <td>
              <span style="display:inline-flex;align-items:center;gap:6px;font-weight:500;">
                <span>${item.isDirectory ? '📁' : '📄'}</span>
                <span>${escapeHtml(item.name)}</span>
              </span>
            </td>
            <td class="mono" style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(item.originalPath)}</td>
            <td class="num mono">${item.isDirectory ? 'Ordner' : formatBytesDecimal(item.sizeBytes)}</td>
            <td class="mono" style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(delStr)}</td>
            <td class="num">
              <div class="table-actions-row">
                <button class="btn-secondary btn-sm" data-trash-restore="${escapeHtml(item.trashKey)}">Wiederherstellen</button>
                <button class="btn-danger-ghost btn-sm" data-trash-delete="${escapeHtml(item.trashKey)}" data-trash-name="${escapeHtml(item.name)}">Endgültig löschen</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
    updateTrashBulkBar();
  }

  function updateBulkBar() {
    const bar = document.getElementById('files-bulk-bar');
    const count = state.selectedFiles.size;
    bar.classList.toggle('hidden', state.filesTrashMode || count === 0);
    document.getElementById('files-bulk-count').textContent = `${count} ausgewählt`;
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'folder': return 'Ordner';
      case 'image': return 'Foto / Bild';
      case 'video': return 'Video';
      case 'audio': return 'Audio';
      case 'pdf': return 'PDF-Dokument';
      case 'text': return 'Text / Config';
      case 'archive': return 'Archiv / Backup';
      case 'document': return 'Dokument';
      default: return 'Datei';
    }
  }

  function fileIconEmoji(item) {
    if (item.isDirectory) return '📁';
    if (item.kind === 'image') return '🖼️';
    if (item.kind === 'video') return '🎬';
    if (item.kind === 'audio') return '🎵';
    if (item.kind === 'pdf') return '📕';
    if (item.kind === 'text') return '📝';
    if (item.kind === 'archive') return '📦';
    return '📄';
  }

  function renderFilesView() {
    if (state.filesTrashMode) {
      renderTrashView();
      return;
    }
    const listing = state.filesListing;
    if (!listing) return;

    const rootsList = document.getElementById('files-roots-list');
    rootsList.innerHTML = [
      `<button class="file-root-btn ${listing.currentPath === '/' ? 'active' : ''}" data-open-dir="/"><span>Alle Laufwerke</span></button>`,
      ...listing.roots.map((r) => `
        <button class="file-root-btn ${listing.currentPath === r.path || listing.currentPath.startsWith(r.path + '/') ? 'active' : ''}" data-open-dir="${escapeHtml(r.path)}" data-drop-dir="${escapeHtml(r.path)}">
          <span>${escapeHtml(r.name)}</span>
        </button>
      `)
    ].join('');

    const rawSearch = (document.getElementById('files-search').value || '').trim();
    const isGlobalMode = state.filesSearchScope === 'global' && rawSearch.length > 0 && state.filesGlobalResults;

    const crumbsEl = document.getElementById('files-breadcrumbs');
    if (isGlobalMode) {
      crumbsEl.innerHTML = `<button class="crumb-btn" data-open-dir="/">Laufwerke</button><span class="crumb-sep">/</span><span class="tag">Globale Suche: „${escapeHtml(rawSearch)}“ (${state.filesGlobalResults.items.length}${state.filesGlobalResults.truncated ? '+' : ''})</span>`;
    } else if (listing.currentPath === '/') {
      crumbsEl.innerHTML = `<button class="crumb-btn" data-open-dir="/">/ Laufwerke</button>`;
    } else {
      const parts = listing.currentPath.split('/').filter(Boolean);
      let acc = '';
      const crumbHtml = [`<button class="crumb-btn" data-open-dir="/">Laufwerke</button>`];
      parts.forEach((part) => {
        acc += `/${part}`;
        crumbHtml.push(`<span class="crumb-sep">/</span><button class="crumb-btn" data-open-dir="${escapeHtml(acc)}" data-drop-dir="${escapeHtml(acc)}">${escapeHtml(part)}</button>`);
      });
      crumbsEl.innerHTML = crumbHtml.join('');
    }

    const canWrite = isGlobalMode ? state.filesGlobalResults.allowWrite : listing.allowWrite && listing.currentPath !== '/';
    document.getElementById('btn-files-mkdir').disabled = !listing.allowWrite || listing.currentPath === '/' || isGlobalMode;
    document.getElementById('btn-files-upload').disabled = !listing.allowWrite || listing.currentPath === '/' || isGlobalMode;

    const search = rawSearch.toLowerCase();
    const filtered = isGlobalMode
      ? state.filesGlobalResults.items || []
      : (listing.items || []).filter((i) => !search || i.name.toLowerCase().includes(search));

    const listContainer = document.getElementById('files-list-container');
    const gridContainer = document.getElementById('files-grid-container');
    listContainer.classList.toggle('hidden', state.filesViewMode !== 'list');
    gridContainer.classList.toggle('hidden', state.filesViewMode !== 'grid');

    const tbody = document.getElementById('files-tbody');
    const rows = [];
    if (!isGlobalMode && listing.parentPath !== null) {
      const dropParentAttr = listing.parentPath !== '/' ? `data-drop-dir="${escapeHtml(listing.parentPath)}"` : '';
      rows.push(`<tr ${dropParentAttr}><td></td><td colspan="5"><button class="file-entry-btn mono" data-open-dir="${escapeHtml(listing.parentPath)}">.. (Ebene nach oben)</button></td></tr>`);
    }

    if (filtered.length === 0) {
      rows.push(`<tr><td colspan="6" class="muted-text">${isGlobalMode ? 'Keine passenden Dateien auf den Laufwerken gefunden.' : 'Dieser Ordner ist leer.'}</td></tr>`);
    } else {
      filtered.forEach((item) => {
        const isPreviewable = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio' || item.kind === 'pdf';
        const isText = item.kind === 'text';
        const isArchive = item.kind === 'archive' && (item.name.endsWith('.zip') || item.name.endsWith('.tar.gz') || item.name.endsWith('.tgz') || item.name.endsWith('.tar'));
        const modStr = item.modifiedAt ? new Date(item.modifiedAt).toLocaleString('de-DE') : '—';
        const dlUrl = item.isDirectory
          ? `/api/files/zip?path=${encodeURIComponent(item.path)}`
          : `/api/files/raw?path=${encodeURIComponent(item.path)}&download=1`;
        const checked = state.selectedFiles.has(item.path) ? 'checked' : '';
        const showCheckbox = isGlobalMode || listing.currentPath !== '/';
        const shareBtn = showCheckbox
          ? `<button class="btn-secondary btn-sm" data-share-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Teilen</button>`
          : '';

        const actionBtns = item.isDirectory
          ? `<button class="btn-secondary btn-sm" data-open-dir="${escapeHtml(item.path)}">Öffnen</button>
             <a class="btn-secondary btn-sm" href="${escapeHtml(dlUrl)}" download style="text-decoration:none;">ZIP laden</a>
             ${shareBtn}`
          : `${isPreviewable ? `<button class="btn-secondary btn-sm" data-preview-file="${escapeHtml(item.path)}" data-preview-kind="${escapeHtml(item.kind)}" data-preview-name="${escapeHtml(item.name)}">Ansehen</button>` : ''}
             ${isText ? `<button class="btn-secondary btn-sm" data-edit-text="${escapeHtml(item.path)}">Editor</button>` : ''}
             ${isArchive && canWrite ? `<button class="btn-secondary btn-sm" data-extract-file="${escapeHtml(item.path)}">Entpacken</button>` : ''}
             <a class="btn-secondary btn-sm" href="${escapeHtml(dlUrl)}" download style="text-decoration:none;">Download</a>
             ${shareBtn}`;

        const writeBtns = canWrite
          ? `<button class="btn-secondary btn-sm" data-move-single="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Verschieben</button>
             <button class="btn-secondary btn-sm" data-rename-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Umbenennen</button>
             <button class="btn-danger-ghost btn-sm" data-delete-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Papierkorb</button>`
          : '';

        const dragAttr = canWrite ? `draggable="true" data-drag-path="${escapeHtml(item.path)}"` : '';
        const dropAttr = item.isDirectory ? `data-drop-dir="${escapeHtml(item.path)}"` : '';

        rows.push(`
          <tr ${dragAttr} ${dropAttr}>
            <td>${showCheckbox ? `<input type="checkbox" class="file-select-cb" data-file-path="${escapeHtml(item.path)}" ${checked} />` : ''}</td>
            <td>
              <button class="file-entry-btn" ${item.isDirectory ? `data-open-dir="${escapeHtml(item.path)}"` : isText ? `data-edit-text="${escapeHtml(item.path)}"` : `data-preview-file="${escapeHtml(item.path)}" data-preview-kind="${escapeHtml(item.kind)}" data-preview-name="${escapeHtml(item.name)}"`}>
                <span>${fileIconEmoji(item)}</span>
                <span>${escapeHtml(item.name)}</span>
              </button>
              ${isGlobalMode && item.parentDir ? `<div class="mono" style="font-size:10.5px;color:var(--text-muted);padding-left:24px;">${escapeHtml(item.parentDir)}</div>` : ''}
            </td>
            <td><span class="tag">${escapeHtml(kindLabel(item.kind))}</span></td>
            <td class="num mono">${item.isDirectory ? '—' : formatBytesDecimal(item.sizeBytes)}</td>
            <td class="mono" style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(modStr)}</td>
            <td class="num">
              <div class="table-actions-row">
                ${actionBtns}
                ${writeBtns}
              </div>
            </td>
          </tr>
        `);
      });
    }
    tbody.innerHTML = rows.join('');

    // Grid View (with cached /api/files/thumb thumbnails, fallback handling & quick Share/Move/Download/Trash buttons)
    gridContainer.innerHTML = filtered
      .map((item) => {
        const rawUrl = `/api/files/raw?path=${encodeURIComponent(item.path)}`;
        const thumbUrl = `/api/files/thumb?path=${encodeURIComponent(item.path)}`;
        const dlUrl = item.isDirectory
          ? `/api/files/zip?path=${encodeURIComponent(item.path)}`
          : `/api/files/raw?path=${encodeURIComponent(item.path)}&download=1`;
        const checked = state.selectedFiles.has(item.path) ? 'checked' : '';
        const showCheckbox = isGlobalMode || listing.currentPath !== '/';
        const thumb = item.isDirectory
          ? '📁'
          : item.kind === 'image' || item.kind === 'video'
          ? `<img src="${escapeHtml(thumbUrl)}" data-thumb-kind="${escapeHtml(item.kind)}" data-fallback-src="${item.kind === 'image' ? escapeHtml(rawUrl) : ''}" loading="lazy" alt="${escapeHtml(item.name)}" />`
          : fileIconEmoji(item);
        const attr = item.isDirectory
          ? `data-open-dir="${escapeHtml(item.path)}"`
          : item.kind === 'text'
          ? `data-edit-text="${escapeHtml(item.path)}"`
          : `data-preview-file="${escapeHtml(item.path)}" data-preview-kind="${escapeHtml(item.kind)}" data-preview-name="${escapeHtml(item.name)}"`;
        const dragAttr = canWrite ? `draggable="true" data-drag-path="${escapeHtml(item.path)}"` : '';
        const dropAttr = item.isDirectory ? `data-drop-dir="${escapeHtml(item.path)}"` : '';

        return `
          <div class="file-grid-card" ${dragAttr} ${dropAttr}>
            <div class="file-grid-top">
              ${showCheckbox ? `<input type="checkbox" class="file-select-cb" data-file-path="${escapeHtml(item.path)}" ${checked} />` : '<span></span>'}
              <span class="mono" style="font-size:10.5px;color:var(--text-muted);">${item.isDirectory ? 'Ordner' : formatBytesDecimal(item.sizeBytes)}</span>
            </div>
            <div class="file-thumb-box" ${attr}>${thumb}</div>
            <div class="file-grid-name" ${attr} title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            <div class="file-grid-actions">
              <a class="btn-secondary btn-xs" href="${escapeHtml(dlUrl)}" download style="text-decoration:none;" title="${item.isDirectory ? 'Als ZIP herunterladen' : 'Herunterladen'}">${item.isDirectory ? 'ZIP' : 'Laden'}</a>
              ${showCheckbox ? `<button type="button" class="btn-secondary btn-xs" data-share-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}" title="Freigabe-Link erstellen">Teilen</button>` : ''}
              ${canWrite ? `<button type="button" class="btn-secondary btn-xs" data-move-single="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Verschieben</button>
              <button type="button" class="btn-danger-ghost btn-xs" data-delete-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">🗑️</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function loadCopyMoveDirs(targetPath) {
    const dest = targetPath || '/';
    state.copyMoveBrowserPath = dest;
    const listEl = document.getElementById('cm-dir-list');
    const crumbsEl = document.getElementById('cm-breadcrumbs');
    if (listEl) listEl.innerHTML = `<p class="muted-text" style="padding:8px;">Lade Ordner…</p>`;
    try {
      const res = await fetch(`/api/files/dirs?path=${encodeURIComponent(dest)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ordner nicht lesbar');

      state.copyMoveBrowserPath = data.currentPath;
      if (data.currentPath !== '/') {
        document.getElementById('cm-dest-input').value = data.currentPath;
      }

      if (data.currentPath === '/') {
        crumbsEl.innerHTML = `<button type="button" class="crumb-btn" data-cm-browse="/">Laufwerke</button>`;
      } else {
        const parts = data.currentPath.split('/').filter(Boolean);
        let acc = '';
        const html = [`<button type="button" class="crumb-btn" data-cm-browse="/">Laufwerke</button>`];
        parts.forEach((p) => {
          acc += `/${p}`;
          html.push(`<span class="crumb-sep">/</span><button type="button" class="crumb-btn" data-cm-browse="${escapeHtml(acc)}">${escapeHtml(p)}</button>`);
        });
        crumbsEl.innerHTML = html.join('');
      }

      const mkdirBtn = document.getElementById('cm-btn-mkdir');
      if (mkdirBtn) mkdirBtn.disabled = data.currentPath === '/';

      const rows = [];
      if (data.parentPath !== null) {
        rows.push(`<button type="button" class="cm-dir-btn mono" data-cm-browse="${escapeHtml(data.parentPath)}">⬆️ .. (Ebene nach oben)</button>`);
      }
      if (!data.dirs || data.dirs.length === 0) {
        rows.push(`<p class="muted-text" style="padding:6px 10px;">Keine Unterordner vorhanden.</p>`);
      } else {
        data.dirs.forEach((d) => {
          rows.push(`<button type="button" class="cm-dir-btn" data-cm-browse="${escapeHtml(d.path)}">📁 ${escapeHtml(d.name)}</button>`);
        });
      }
      listEl.innerHTML = rows.join('');
    } catch (err) {
      if (listEl) listEl.innerHTML = `<p class="form-error" style="padding:8px;">${escapeHtml(err.message)}</p>`;
    }
  }

  function openCopyMoveModal(action, sourcesList) {
    state.copyMoveSources = Array.isArray(sourcesList) && sourcesList.length > 0 ? [...sourcesList] : [...state.selectedFiles];
    if (state.copyMoveSources.length === 0) return;

    document.getElementById('cm-action').value = action;
    document.getElementById('modal-cm-title').textContent = action === 'move' ? 'Verschieben nach…' : 'Kopieren nach…';
    document.getElementById('cm-submit-btn').textContent = action === 'move' ? 'Hierher verschieben' : 'Hierher kopieren';
    document.getElementById('cm-source-summary').textContent = `${state.copyMoveSources.length} Element(e) ausgewählt`;

    const startDir = state.filesPath && state.filesPath !== '/' ? state.filesPath : getDefaultDiskMount('/');
    document.getElementById('cm-dest-input').value = startDir !== '/' ? startDir : '';

    const roots = state.filesListing?.roots || [];
    document.getElementById('cm-quick-roots').innerHTML = roots
      .map((r) => `<button type="button" class="btn-secondary btn-sm" data-cm-browse="${escapeHtml(r.path)}">${escapeHtml(r.name)}</button>`)
      .join('');
    loadCopyMoveDirs(startDir);
    openModal('modal-copy-move');
  }

  function uploadFilesWithProgress(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0 || state.filesPath === '/') return;
    const wrap = document.getElementById('upload-progress-wrap');
    const bar = document.getElementById('upload-progress-bar');
    const pctEl = document.getElementById('upload-progress-pct');
    const labelEl = document.getElementById('upload-progress-label');
    wrap.classList.remove('hidden');
    startGlobalProgress(0);

    let idx = 0;
    const errors = [];
    const uploadNext = () => {
      if (idx >= files.length) {
        wrap.classList.add('hidden');
        bar.style.width = '0%';
        pctEl.textContent = '0%';
        endGlobalProgress();
        loadFilesDirectory(state.filesPath);
        if (errors.length > 0) {
          alert(`Upload teilweise fehlgeschlagen:\n${errors.join('\n')}`);
        }
        return;
      }
      const file = files[idx];
      idx += 1;
      labelEl.textContent = `Lade hoch (${idx}/${files.length}): ${file.name}`;
      bar.style.width = '0%';
      pctEl.textContent = '0%';
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/files/upload?dir=${encodeURIComponent(state.filesPath)}&name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          bar.style.width = `${pct}%`;
          pctEl.textContent = `${pct}%`;
          const overall = Math.round((((idx - 1) + ev.loaded / ev.total) / files.length) * 100);
          setGlobalProgress(overall);
        }
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          let msg = `HTTP ${xhr.status}`;
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed?.error) msg = parsed.error;
          } catch {
            // keep status text
          }
          errors.push(`${file.name}: ${msg}`);
        }
        uploadNext();
      };
      xhr.onerror = () => {
        errors.push(`${file.name}: Netzwerkfehler beim Hochladen`);
        uploadNext();
      };
      xhr.send(file);
    };
    uploadNext();
  }

  function renderVideoStage(filePath, mode = 'native', startSec = 0) {
    const stage = document.getElementById('media-preview-stage');
    const transcodeBtn = document.getElementById('btn-preview-transcode');
    const rawUrl = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
    const videoUrl = mode === 'transcode'
      ? `/api/files/video?path=${encodeURIComponent(filePath)}&start=${Math.max(0, Number(startSec) || 0)}`
      : rawUrl;

    if (transcodeBtn) {
      transcodeBtn.textContent = mode === 'transcode' ? 'Natives Streaming' : 'Transcode (ffmpeg)';
    }

    stage.innerHTML = '';
    const videoEl = document.createElement('video');
    videoEl.src = videoUrl;
    videoEl.controls = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.addEventListener('error', async () => {
      if (state.activePreview && state.activePreview.mode !== 'transcode') {
        state.activePreview.mode = 'transcode';
        renderVideoStage(filePath, 'transcode', state.activePreview.startSec || 0);
        return;
      }
      let errMsg = 'Video konnte im Browser nicht abgespielt werden. Bitte "Herunterladen" verwenden.';
      try {
        const probe = await fetch(videoUrl, { method: 'GET' });
        if (!probe.ok) {
          const payload = await probe.json().catch(() => null);
          if (payload?.error) errMsg = payload.error;
        }
      } catch {
        // ignore probe error
      }
      stage.innerHTML = `<p class="muted-text">${escapeHtml(errMsg)}</p>`;
    });
    stage.appendChild(videoEl);
  }

  function openMediaPreview(filePath, kind, name) {
    const rawUrl = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
    document.getElementById('modal-preview-title').textContent = name || 'Dateivorschau';
    document.getElementById('modal-preview-path').textContent = filePath;
    document.getElementById('btn-preview-download').href = `${rawUrl}&download=1`;

    const videoControls = document.getElementById('preview-video-controls');
    const exifBar = document.getElementById('preview-exif-bar');
    const stage = document.getElementById('media-preview-stage');
    videoControls?.classList.add('hidden');
    if (exifBar) {
      exifBar.classList.add('hidden');
      exifBar.innerHTML = '';
    }
    state.activePreview = { filePath, kind, name, mode: 'native', startSec: 0 };

    if (kind === 'image') {
      stage.innerHTML = `<img src="${escapeHtml(rawUrl)}" alt="${escapeHtml(name)}" />`;
      if (exifBar) {
        fetch(`/api/files/exif?path=${encodeURIComponent(filePath)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data || state.activePreview?.filePath !== filePath) return;
            const e = data.exif || {};
            const parts = [];
            if (e.width && e.height) parts.push(`${e.width}×${e.height} px`);
            if (e.make || e.model) parts.push([e.make, e.model].filter(Boolean).join(' '));
            if (e.focalLength) parts.push(e.focalLength);
            if (e.fNumber) parts.push(e.fNumber);
            if (e.exposureTime) parts.push(e.exposureTime);
            if (e.iso) parts.push(`ISO ${e.iso}`);
            if (e.dateTimeOriginal || e.dateTime) parts.push(e.dateTimeOriginal || e.dateTime);
            if (parts.length > 0) {
              exifBar.innerHTML = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('');
              exifBar.classList.remove('hidden');
            }
          })
          .catch(() => {});
      }
    } else if (kind === 'pdf') {
      stage.innerHTML = `<iframe class="pdf-preview-frame" title="PDF Vorschau" src="${escapeHtml(`${rawUrl}&inline=1`)}"></iframe>`;
    } else if (kind === 'video') {
      const lower = String(filePath || '').toLowerCase();
      const needsTranscode = lower.endsWith('.mkv') || lower.endsWith('.avi') || lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.wmv') || lower.endsWith('.flv');
      state.activePreview.mode = needsTranscode ? 'transcode' : 'native';
      document.getElementById('preview-video-start').value = '0';
      videoControls?.classList.remove('hidden');
      renderVideoStage(filePath, state.activePreview.mode, 0);
    } else if (kind === 'audio') {
      stage.innerHTML = `<audio src="${escapeHtml(rawUrl)}" controls autoplay style="width:100%;max-width:480px;"></audio>`;
    } else {
      stage.innerHTML = `<p class="muted-text">Keine direkte Browser-Vorschau für diesen Dateityp. Nutze "Herunterladen".</p>`;
    }
    openModal('modal-preview');
  }

  function updateEditorLineNumbers() {
    const area = document.getElementById('text-editor-area');
    const nums = document.getElementById('editor-line-numbers');
    if (!area || !nums) return;
    const count = Math.max(1, area.value.split('\n').length);
    let out = '';
    for (let i = 1; i <= count; i += 1) {
      out += (i === 1 ? '' : '\n') + i;
    }
    nums.textContent = out;
    nums.scrollTop = area.scrollTop;
  }

  function setEditorStatus(text = '', type = '') {
    const el = document.getElementById('editor-status-msg');
    if (!el) return;
    el.textContent = text;
    el.className = `editor-status-msg mono${type ? ` ${type}` : ''}`;
  }

  function validateEditorContent() {
    const area = document.getElementById('text-editor-area');
    if (!area) return true;
    const text = area.value;
    const ext = state.activeEditorExt;

    if (ext === '.json') {
      try {
        JSON.parse(text);
        setEditorStatus('JSON Syntax OK.', 'ok');
        return true;
      } catch (err) {
        setEditorStatus(`JSON Fehler: ${err.message}`, 'err');
        return false;
      }
    }

    if (ext === '.yml' || ext === '.yaml') {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim() || line.trim().startsWith('#')) continue;
        if (/^\t+/.test(line)) {
          setEditorStatus(`YAML Hinweis (Zeile ${i + 1}): Tabs zur Einrückung sind in YAML nicht erlaubt (Leerzeichen verwenden).`, 'err');
          return false;
        }
      }
      setEditorStatus('YAML Grundprüfung OK (keine Tab-Einrückungen).', 'ok');
      return true;
    }

    setEditorStatus(`${text.split('\n').length} Zeilen · ${text.length} Zeichen`, 'ok');
    return true;
  }

  function renderSafeMarkdown(md) {
    const renderInline = (str) => {
      let safe = escapeHtml(str);
      safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
      safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      safe = safe.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
        const href = safeHref(url);
        return `<a href="${escapeHtml(href)}" ${href !== '#' ? 'target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
      });
      return safe;
    };

    const lines = String(md || '').split('\n');
    const html = [];
    let inCode = false;
    let inList = false;

    const closeList = () => {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
    };

    for (const rawLine of lines) {
      if (rawLine.trim().startsWith('```')) {
        closeList();
        if (!inCode) {
          inCode = true;
          html.push('<pre><code>');
        } else {
          inCode = false;
          html.push('</code></pre>');
        }
        continue;
      }
      if (inCode) {
        html.push(`${escapeHtml(rawLine)}\n`);
        continue;
      }

      const trimmed = rawLine.trim();
      if (!trimmed) {
        closeList();
        continue;
      }
      if (/^#{1,3}\s+/.test(trimmed)) {
        closeList();
        const level = trimmed.match(/^#+/)[0].length;
        html.push(`<h${level}>${renderInline(trimmed.slice(level).trim())}</h${level}>`);
      } else if (/^[-*]\s+/.test(trimmed)) {
        if (!inList) {
          inList = true;
          html.push('<ul>');
        }
        html.push(`<li>${renderInline(trimmed.slice(2).trim())}</li>`);
      } else {
        closeList();
        html.push(`<p>${renderInline(trimmed)}</p>`);
      }
    }
    closeList();
    if (inCode) html.push('</code></pre>');
    return html.join('');
  }

  async function openTextEditor(filePath) {
    const res = await fetch(`/api/files/text?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Datei konnte nicht geöffnet werden');
    state.activeEditorPath = filePath;
    const dotIdx = (data.name || '').lastIndexOf('.');
    state.activeEditorExt = dotIdx >= 0 ? data.name.slice(dotIdx).toLowerCase() : '';
    state.activeEditorMarkdownPreview = false;

    document.getElementById('modal-editor-title').textContent = data.name;
    document.getElementById('modal-editor-path').textContent = filePath;
    document.getElementById('text-editor-area').value = data.content || '';
    document.getElementById('editor-save-msg').textContent = '';
    document.getElementById('editor-find-input').value = '';
    setEditorStatus(`${(data.content || '').split('\n').length} Zeilen`);

    const isMd = state.activeEditorExt === '.md' || state.activeEditorExt === '.markdown';
    const mdBtn = document.getElementById('btn-editor-md-toggle');
    if (mdBtn) {
      mdBtn.classList.toggle('hidden', !isMd);
      mdBtn.textContent = 'Markdown-Vorschau';
    }
    document.getElementById('editor-code-wrap')?.classList.remove('hidden');
    document.getElementById('editor-md-preview')?.classList.add('hidden');
    updateEditorLineNumbers();
    openModal('modal-text-editor');
  }

  // ==================== APP STORE & COMPOSE STACKS ====================
  async function loadAppCatalog() {
    if (state.appCatalog.length === 0) {
      const res = await fetch('/api/appstore/catalog');
      const data = await res.json();
      state.appCatalog = data.apps || [];
      state.composeTemplates = data.templates || [];
    }
    renderAppCatalog();
  }

  async function loadDeployedStacks() {
    const res = await fetch(`/api/compose/stacks`);
    if (!res.ok) return;
    const data = await res.json();
    state.deployedStacks = data.stacks || [];
    renderDeployedStacks();
  }

  function renderDeployedStacks() {
    const grid = document.getElementById('deployed-stacks-grid');
    if (state.deployedStacks.length === 0) {
      grid.innerHTML = `<div class="card disk-card"><p class="muted-text">Noch keine eigenen Compose-Stacks gespeichert. Wähle oben eine Stack-Vorlage oder klicke auf "Compose YAML einfügen".</p></div>`;
      return;
    }

    grid.innerHTML = state.deployedStacks
      .map((st) => `
        <article class="card disk-card">
          <div class="disk-top">
            <div>
              <h3 class="disk-label">${escapeHtml(st.name)}</h3>
              <div class="disk-path mono">${escapeHtml(st.path)}</div>
            </div>
            <span class="tag tag-ok">Compose Stack</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
            <button class="btn-secondary btn-sm" data-stack-edit="${escapeHtml(st.name)}">YAML bearbeiten</button>
            <button class="btn-secondary btn-sm" data-stack-action="pull" data-stack="${escapeHtml(st.name)}">Pull &amp; Update</button>
            <button class="btn-secondary btn-sm" data-stack-action="down" data-stack="${escapeHtml(st.name)}">Stoppen</button>
            <button class="btn-danger-ghost btn-sm" data-stack-action="delete" data-stack="${escapeHtml(st.name)}">Löschen</button>
          </div>
        </article>
      `)
      .join('');
  }

  function renderAppCatalog() {
    const search = (document.getElementById('appstore-search').value || '').toLowerCase();
    const containers = state.snapshot?.docker?.containers || [];
    const grid = document.getElementById('appstore-grid');

    if (state.appCategory === 'stacks') {
      const filtered = state.composeTemplates.filter((t) => !search || t.name.toLowerCase().includes(search) || t.description.toLowerCase().includes(search));
      grid.innerHTML = filtered
        .map((t) => `
          <article class="card app-card">
            <div>
              <div class="app-card-head">
                <h3 class="app-card-title">${escapeHtml(t.name)}</h3>
                <span class="tag tag-warn">Multi-Container</span>
              </div>
              <p class="app-card-tagline">${escapeHtml(t.description)}</p>
            </div>
            <div class="app-card-foot">
              <span class="mono" style="font-size:11.5px;color:var(--text-muted);">Port ${t.defaultPort}</span>
              <button class="btn-primary btn-sm" data-install-template="${escapeHtml(t.id)}">Stack konfigurieren</button>
            </div>
          </article>
        `)
        .join('');
      return;
    }

    const filtered = state.appCatalog.filter((app) => {
      if (state.appCategory !== 'all' && app.category !== state.appCategory) return false;
      if (search && !app.name.toLowerCase().includes(search) && !app.tagline.toLowerCase().includes(search)) return false;
      return true;
    });

    grid.innerHTML = filtered
      .map((app) => {
        const installed = containers.find((c) => c.name.toLowerCase().includes(app.id.toLowerCase()) || c.image.includes(app.image.split(':')[0]));
        const statusBadge = installed ? `<span class="tag tag-ok">Installiert</span>` : `<span class="tag">${escapeHtml(app.category)}</span>`;
        return `
          <article class="card app-card">
            <div>
              <div class="app-card-head">
                <h3 class="app-card-title">${escapeHtml(app.name)}</h3>
                ${statusBadge}
              </div>
              <p class="app-card-tagline">${escapeHtml(app.tagline)}</p>
            </div>
            <div class="app-card-foot">
              <span class="mono" style="font-size:11.5px;color:var(--text-muted);">Port ${app.defaultPort}</span>
              <button class="${installed ? 'btn-secondary' : 'btn-primary'} btn-sm" data-install-app="${escapeHtml(app.id)}">
                ${installed ? 'Erneut / Instanz' : 'Installieren'}
              </button>
            </div>
          </article>
        `;
      })
      .join('');
  }

  function addPortRow(hostPort = '', containerPort = '', protocol = 'tcp') {
    const row = document.createElement('div');
    row.className = 'dynamic-row-3';
    row.innerHTML = `
      <input type="number" class="input-full mono port-host" placeholder="Host-Port" value="${escapeHtml(hostPort)}" />
      <input type="number" class="input-full mono port-container" placeholder="Container-Port" value="${escapeHtml(containerPort)}" />
      <select class="input-full port-proto">
        <option value="tcp" ${protocol === 'tcp' ? 'selected' : ''}>TCP</option>
        <option value="udp" ${protocol === 'udp' ? 'selected' : ''}>UDP</option>
      </select>
      <button type="button" class="btn-danger-ghost btn-sm btn-remove-row">✕</button>
    `;
    row.querySelector('.btn-remove-row').addEventListener('click', () => row.remove());
    document.getElementById('inst-ports-list').appendChild(row);
  }

  function addVolumeRow(hostPath = '', containerPath = '', mode = '') {
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.dataset.volMode = mode || '';
    row.innerHTML = `
      <input type="text" class="input-full mono vol-host" placeholder="Host-Pfad z. B. /mnt/daten" value="${escapeHtml(hostPath)}" />
      <input type="text" class="input-full mono vol-container" placeholder="Container-Pfad z. B. /data" value="${escapeHtml(containerPath)}" />
      <button type="button" class="btn-danger-ghost btn-sm btn-remove-row">✕</button>
    `;
    row.querySelector('.btn-remove-row').addEventListener('click', () => row.remove());
    document.getElementById('inst-volumes-list').appendChild(row);
  }

  function addEnvRow(key = '', value = '') {
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <input type="text" class="input-full mono env-key" placeholder="KEY" value="${escapeHtml(key)}" />
      <input type="text" class="input-full mono env-val" placeholder="VALUE" value="${escapeHtml(value)}" />
      <button type="button" class="btn-danger-ghost btn-sm btn-remove-row">✕</button>
    `;
    row.querySelector('.btn-remove-row').addEventListener('click', () => row.remove());
    document.getElementById('inst-env-list').appendChild(row);
  }

  function openInstallModal(app = null, editConfig = null) {
    state.activeInstallApp = app;
    document.getElementById('inst-error').classList.add('hidden');
    document.getElementById('inst-ports-list').innerHTML = '';
    document.getElementById('inst-volumes-list').innerHTML = '';
    document.getElementById('inst-env-list').innerHTML = '';
    document.getElementById('inst-edit-cid').value = editConfig?.id || '';

    const disks = (state.snapshot?.storage?.disks || []).map((d) => d.mountpoint).join(', ');
    document.getElementById('inst-disk-hints').textContent = disks ? `Verfügbare Laufwerke: ${disks}` : '';

    if (editConfig) {
      document.getElementById('modal-install-title').textContent = `Container bearbeiten: ${editConfig.name}`;
      document.getElementById('modal-install-subtitle').textContent = 'Einstellungen anpassen und Container sauber neu erstellen';
      document.getElementById('btn-install-submit').textContent = 'Speichern & Container neu erstellen';
      document.getElementById('inst-name').value = editConfig.name;
      document.getElementById('inst-image').value = editConfig.image;
      document.getElementById('inst-network').value = editConfig.networkMode === 'host' ? 'host' : 'bridge';
      document.getElementById('inst-restart').value = editConfig.restartPolicy || 'unless-stopped';
      document.getElementById('inst-devices').value = (editConfig.devices || []).join(', ');
      document.getElementById('inst-privileged').checked = Boolean(editConfig.privileged);
      (editConfig.ports || []).forEach((p) => addPortRow(p.hostPort, p.containerPort, p.protocol));
      (editConfig.volumes || []).forEach((v) => addVolumeRow(v.hostPath, v.containerPath, v.mode || ''));
      (editConfig.env || []).forEach((e) => addEnvRow(e.key, e.value));
      document.getElementById('inst-note').classList.add('hidden');
    } else if (app) {
      document.getElementById('modal-install-title').textContent = `${app.name} installieren`;
      document.getElementById('modal-install-subtitle').textContent = app.tagline;
      document.getElementById('btn-install-submit').textContent = 'Image laden & Container starten';
      document.getElementById('inst-name').value = app.id;
      document.getElementById('inst-image').value = app.image;
      document.getElementById('inst-network').value = 'bridge';
      document.getElementById('inst-restart').value = app.restartPolicy || 'unless-stopped';
      document.getElementById('inst-devices').value = '';
      document.getElementById('inst-privileged').checked = false;
      if (app.defaultPort) addPortRow(app.defaultPort, app.containerPort || app.defaultPort, 'tcp');
      (app.volumes || []).forEach((v) => addVolumeRow(v.hostDefault, v.containerPath, v.mode || ''));
      (app.env || []).forEach((e) => addEnvRow(e.key, e.value));

      const noteEl = document.getElementById('inst-note');
      if (app.note) {
        noteEl.textContent = app.note;
        noteEl.classList.remove('hidden');
      } else {
        noteEl.classList.add('hidden');
      }
    } else {
      document.getElementById('modal-install-title').textContent = 'Eigenen Container erstellen';
      document.getElementById('modal-install-subtitle').textContent = 'Beliebiges Docker Image direkt starten';
      document.getElementById('btn-install-submit').textContent = 'Image laden & Container starten';
      document.getElementById('inst-name').value = '';
      document.getElementById('inst-image').value = '';
      document.getElementById('inst-network').value = 'bridge';
      document.getElementById('inst-restart').value = 'unless-stopped';
      document.getElementById('inst-devices').value = '';
      document.getElementById('inst-privileged').checked = false;
      document.getElementById('inst-note').classList.add('hidden');
      addPortRow('', '', 'tcp');
      addVolumeRow(getDefaultDiskMount('/mnt/daten'), '/data');
      addEnvRow('TZ', 'Europe/Berlin');
    }

    openModal('modal-install');
  }

  // ==================== BROWSER TERMINAL (WEBSOCKET) ====================
  function openTerminalModal(containerId, containerName) {
    if (state.termSocket) {
      state.termSocket.close();
      state.termSocket = null;
    }
    const screen = document.getElementById('terminal-screen');
    screen.textContent = `Verbinde mit ${containerName || containerId}…\n`;
    document.getElementById('modal-terminal-title').textContent = `Terminal: ${containerName || containerId}`;
    document.getElementById('modal-terminal-subtitle').textContent = `Container-ID: ${containerId}`;
    openModal('modal-terminal');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal?container=${encodeURIComponent(containerId)}`);
    state.termSocket = ws;

    ws.onopen = () => {
      screen.textContent = '';
      screen.focus();
    };

    ws.onmessage = (ev) => {
      let chunk = String(ev.data || '');
      // Handle basic clear screen sequence & strip non-printable ANSI color codes cleanly
      if (chunk.includes('\x1b[2J')) {
        screen.textContent = '';
        chunk = chunk.replace(/\x1b\[2J\x1b\[H/g, '');
      }
      // Basic backspace handling for tty echo
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk.slice(i, i + 3) === '\b \b') {
          screen.textContent = screen.textContent.slice(0, -1);
          i += 2;
          continue;
        }
        if (chunk[i] === '\x1b') {
          const rest = chunk.slice(i);
          const match = rest.match(/^\x1b\[[0-9;?]*[a-zA-Z]/);
          if (match) {
            i += match[0].length - 1;
            continue;
          }
        }
        if (chunk[i] !== '\r') {
          screen.textContent += chunk[i];
        }
      }
      screen.scrollTop = screen.scrollHeight;
    };

    ws.onclose = () => {
      screen.textContent += '\n[Verbindung getrennt]';
    };
  }

  // ==================== SMART STORAGE ANALYZER ====================
  function renderAnalyzerRoots() {
    const container = document.getElementById('analyzer-roots-list');
    if (!container) return;

    const rootMap = new Map();
    (state.filesListing?.roots || []).forEach((r) => {
      if (r?.path) rootMap.set(r.path, r.name || r.path);
    });
    if (rootMap.size === 0) {
      (state.snapshot?.storage?.disks || []).forEach((d) => {
        if (d?.mountpoint) rootMap.set(d.mountpoint, d.label ? `${d.label} (${d.mountpoint})` : d.mountpoint);
      });
      (state.snapshot?.config?.mediaPaths || []).forEach((p) => {
        if (p && !rootMap.has(p)) rootMap.set(p, p);
      });
    }

    const entries = [...rootMap.entries()];
    if (entries.length === 0) {
      container.innerHTML = `<span class="muted-text">Keine Speicherpfade konfiguriert.</span>`;
      return;
    }

    if (state.analyzerSelectedRoots === null) {
      state.analyzerSelectedRoots = new Set(entries.map(([p]) => p));
    }

    container.innerHTML = entries
      .map(([p, label]) => {
        const checked = state.analyzerSelectedRoots.has(p) ? 'checked' : '';
        return `
          <label class="accent-swatch-btn" style="cursor:pointer;">
            <input type="checkbox" class="analyzer-root-cb" value="${escapeHtml(p)}" ${checked} />
            <span>${escapeHtml(label)}</span>
          </label>
        `;
      })
      .join('');
  }

  async function loadAnalyzerStatus() {
    try {
      if (!state.filesListing) {
        const rootRes = await fetch('/api/files/list?path=%2F');
        if (rootRes.ok) state.filesListing = await rootRes.json();
      }
      renderAnalyzerRoots();

      const res = await fetch('/api/analyzer/status', { cache: 'no-store' });
      if (!res.ok) return;
      state.analyzerData = await res.json();
      renderAnalyzerView();

      if (state.analyzerPollTimer) {
        clearTimeout(state.analyzerPollTimer);
        state.analyzerPollTimer = null;
      }
      if (state.analyzerData.running && state.activeView === 'analyzer') {
        state.analyzerPollTimer = setTimeout(loadAnalyzerStatus, 900);
      }
    } catch {
      // ignore transient errors
    }
  }

  function renderAnalyzerView() {
    const data = state.analyzerData;
    const scanBtn = document.getElementById('btn-analyzer-scan');
    const subEl = document.getElementById('analyzer-status-subtitle');
    const progWrap = document.getElementById('analyzer-progress-wrap');
    const progLabel = document.getElementById('analyzer-progress-label');
    const progStats = document.getElementById('analyzer-progress-stats');

    document.querySelectorAll('[data-ana-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.anaTab === state.analyzerTab);
    });
    document.getElementById('analyzer-panel-duplicates')?.classList.toggle('hidden', state.analyzerTab !== 'duplicates');
    document.getElementById('analyzer-panel-dirs')?.classList.toggle('hidden', state.analyzerTab !== 'dirs');
    document.getElementById('analyzer-panel-files')?.classList.toggle('hidden', state.analyzerTab !== 'files');

    if (!data) return;

    if (scanBtn) {
      scanBtn.disabled = Boolean(data.running);
      scanBtn.textContent = data.running ? 'Analyse läuft…' : 'Analyse starten';
    }

    if (subEl) {
      if (data.running) {
        subEl.textContent = data.phase === 'hashing'
          ? 'Phase 2/2: Berechne bitgenaue SHA-256 Prüfsummen für mögliche Duplikate…'
          : 'Phase 1/2: Durchsuche Ordner und erfasse Dateigrößen…';
      } else if (data.phase === 'error') {
        subEl.textContent = `Fehler: ${data.error || 'Unbekannter Fehler'}`;
      } else if (data.phase === 'done' && data.finishedAt) {
        subEl.textContent = `Letzte Analyse abgeschlossen am ${new Date(data.finishedAt).toLocaleString('de-DE')}`;
      } else {
        subEl.textContent = 'Bereit — wähle alle oder bestimmte Laufwerke';
      }
    }

    if (progWrap) {
      progWrap.classList.toggle('hidden', !data.running);
      if (progLabel) {
        progLabel.textContent = data.phase === 'hashing' ? 'Vergleiche SHA-256 Prüfsummen…' : 'Scanne Dateisystem…';
      }
      if (progStats) {
        progStats.textContent = `${formatNumber(data.scannedFiles)} Dateien · ${formatBytesDecimal(data.scannedBytes)}${data.hashedFiles ? ` · ${formatNumber(data.hashedFiles)} SHA-256` : ''}`;
      }
    }

    const summary = data.summary || {};
    document.getElementById('ana-kpi-files').textContent = formatNumber(data.running ? data.scannedFiles : summary.totalFiles || data.scannedFiles);
    document.getElementById('ana-kpi-dirs').textContent = `${formatNumber(data.scannedDirs)} Ordner gescannt`;
    document.getElementById('ana-kpi-bytes').textContent = formatBytesDecimal(data.running ? data.scannedBytes : summary.totalBytes || data.scannedBytes);
    document.getElementById('ana-kpi-dups').textContent = formatNumber(summary.duplicateGroupCount || 0);
    document.getElementById('ana-kpi-extra').textContent = `${formatNumber(summary.duplicateExtraFiles || 0)} überzählige Kopien`;
    document.getElementById('ana-kpi-wasted').textContent = formatBytesDecimal(summary.wastedBytes || 0);

    // Duplicates list
    const dupList = document.getElementById('analyzer-duplicates-list');
    const groups = data.duplicateGroups || [];
    if (dupList) {
      if (groups.length === 0) {
        dupList.innerHTML = `<article class="card panel-card"><p class="muted-text">${
          data.phase === 'done'
            ? 'Keine Duplikate (≥ 1 KB) in den gewählten Pfaden gefunden — alles sauber!'
            : 'Starte oben eine Analyse, um identische Dateien über deine Laufwerke aufzuspüren.'
        }</p></article>`;
      } else {
        dupList.innerHTML = groups
          .map((g, idx) => `
            <article class="card dup-group-card">
              <div class="dup-group-head">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span class="tag tag-warn">${g.files.length}× identisch</span>
                  <strong>${escapeHtml(g.files[0]?.name || 'Datei')}</strong>
                  <span class="mono" style="font-size:12px;color:var(--text-secondary);">je ${formatBytesDecimal(g.sizeBytes)} · Einsparung: ${formatBytesDecimal(g.wastedBytes)}</span>
                  <span class="tag mono" title="${escapeHtml(g.fullHash || g.hash)}">SHA-256 ${escapeHtml(g.hash)}</span>
                </div>
                <button type="button" class="btn-danger-ghost btn-sm" data-trash-dup-group="${idx}">
                  ${g.files.length - 1} Kopie(n) in Papierkorb
                </button>
              </div>
              <div class="dup-file-list">
                ${g.files
                  .map((f, fIdx) => `
                    <div class="dup-file-row">
                      <div style="min-width:0;display:flex;align-items:center;gap:8px;overflow:hidden;">
                        ${fIdx === 0 ? `<span class="tag tag-ok">Original behalten</span>` : `<span class="tag">Kopie</span>`}
                        <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
                      </div>
                      <div style="display:flex;gap:6px;flex-shrink:0;">
                        <a class="btn-secondary btn-xs" href="/api/files/raw?path=${encodeURIComponent(f.path)}&download=1" download style="text-decoration:none;">Laden</a>
                        <button type="button" class="btn-danger-ghost btn-xs" data-trash-single-path="${escapeHtml(f.path)}" data-trash-name="${escapeHtml(f.name)}">Papierkorb</button>
                      </div>
                    </div>
                  `)
                  .join('')}
              </div>
            </article>
          `)
          .join('');
      }
    }

    // Largest directories
    const dirsTbody = document.getElementById('analyzer-dirs-tbody');
    const dirs = data.largestDirs || [];
    if (dirsTbody) {
      dirsTbody.innerHTML = dirs.length === 0
        ? `<tr><td colspan="5" class="muted-text">Noch keine Ordner-Statistiken vorhanden.</td></tr>`
        : dirs
            .map((d) => `
              <tr>
                <td><strong>📁 ${escapeHtml(d.name)}</strong></td>
                <td class="mono" style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(d.path)}</td>
                <td class="num mono">${formatNumber(d.fileCount)}</td>
                <td class="num mono"><strong>${formatBytesDecimal(d.totalBytes)}</strong></td>
                <td class="num"><button type="button" class="btn-secondary btn-sm" data-open-analyzer-dir="${escapeHtml(d.path)}">Im Dateimanager</button></td>
              </tr>
            `)
            .join('');
    }

    // Largest files
    const filesTbody = document.getElementById('analyzer-files-tbody');
    const topFiles = data.largestFiles || [];
    if (filesTbody) {
      filesTbody.innerHTML = topFiles.length === 0
        ? `<tr><td colspan="4" class="muted-text">Noch keine Datei-Statistiken vorhanden.</td></tr>`
        : topFiles
            .map((f) => `
              <tr>
                <td><strong>📄 ${escapeHtml(f.name)}</strong></td>
                <td class="mono" style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(f.path)}</td>
                <td class="num mono"><strong>${formatBytesDecimal(f.sizeBytes)}</strong></td>
                <td class="num">
                  <div class="table-actions-row">
                    <a class="btn-secondary btn-sm" href="/api/files/raw?path=${encodeURIComponent(f.path)}&download=1" download style="text-decoration:none;">Download</a>
                    <button type="button" class="btn-danger-ghost btn-sm" data-trash-single-path="${escapeHtml(f.path)}" data-trash-name="${escapeHtml(f.name)}">Papierkorb</button>
                  </div>
                </td>
              </tr>
            `)
            .join('');
    }
  }

  // ==================== HOST & NETWORK MONITOR ====================
  async function loadHostStatus(showBar = false) {
    const showProgress = showBar || !state.hostData;
    if (showProgress) {
      startGlobalProgress();
      setInlineProgress('host-load-progress', { active: true, label: 'Aktualisiere Host- & Netzwerkdaten…' });
    }
    if (!state.hostData) {
      try {
        const cacheRes = await fetch('/api/host/cache', { cache: 'no-store' });
        if (cacheRes.ok) {
          const cached = await cacheRes.json();
          if (cached && cached.collectedAt && !state.hostData) {
            state.hostData = cached;
            renderHostView();
          }
        }
      } catch {
        // ignore cache read error
      }
    }

    try {
      const res = await fetch('/api/host/status', { cache: 'no-store' });
      if (!res.ok) return;
      state.hostData = await res.json();
      renderHostView();
    } catch {
      // ignore transient errors
    } finally {
      if (showProgress) {
        setInlineProgress('host-load-progress', { active: false });
        endGlobalProgress();
      }
    }
  }

  function renderHostView() {
    const data = state.hostData;
    if (!data) return;

    const lastCheckedBadge = document.getElementById('host-last-checked');
    if (lastCheckedBadge) {
      lastCheckedBadge.textContent = `Stand: ${data.collectedAt ? formatDateTimeShort(data.collectedAt) : '—'}`;
    }

    const procBadge = document.getElementById('host-proc-source-badge');
    if (procBadge) procBadge.textContent = data.procSource || '/proc';

    const vpnSub = document.getElementById('host-vpn-subtitle');
    if (vpnSub) {
      const vpnTs = data.vpn?.checkedAt || data.collectedAt;
      vpnSub.textContent = `Erkennt Tailscale, WireGuard und Tunnel-Verbindungen automatisch${vpnTs ? ` · Stand: ${formatTimeShort(vpnTs)}` : ''}`;
    }

    const vpnGrid = document.getElementById('host-vpn-grid');
    if (vpnGrid) {
      const ifaces = data.vpn?.interfaces || [];
      const containers = data.vpn?.containers || [];
      if (ifaces.length === 0 && containers.length === 0) {
        vpnGrid.innerHTML = `<p class="muted-text">Keine aktiven Tailscale-, WireGuard- oder VPN-Tunnel-Interfaces erkannt.</p>`;
      } else {
        const ifaceCards = ifaces.map((iface) => `
          <div class="vpn-iface-card">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <strong class="mono">${escapeHtml(iface.interface)}</strong>
              <span class="tag ${iface.active ? 'tag-ok' : ''}">${escapeHtml(iface.provider)} · ${iface.active ? 'Aktiv' : 'Down'}</span>
            </div>
            <div class="mono" style="font-size:11.5px;color:var(--text-secondary);">
              ${(iface.addresses || []).length > 0 ? escapeHtml(iface.addresses.join(', ')) : 'Keine IP zugewiesen'}
            </div>
            <div class="mono" style="font-size:11px;color:var(--text-muted);">
              ↓ ${formatBytesDecimal(iface.rxBytes)} · ↑ ${formatBytesDecimal(iface.txBytes)}
            </div>
          </div>
        `);
        const containerCards = containers.map((c) => `
          <div class="vpn-iface-card">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <strong>🐳 ${escapeHtml(c.name)}</strong>
              <span class="tag tag-ok">VPN Container</span>
            </div>
            <div class="mono" style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(c.image)}</div>
            <div class="mono" style="font-size:11px;color:var(--text-muted);">${escapeHtml(c.statusText)}</div>
          </div>
        `);
        vpnGrid.innerHTML = [...ifaceCards, ...containerCards].join('');
      }
    }

    const targets = data.pingTargets || [];
    const pingSub = document.getElementById('host-ping-subtitle');
    if (pingSub) {
      const onlineCount = targets.filter((t) => t.online).length;
      const latestPingAt = targets.reduce((acc, t) => (!acc || (t.checkedAt && t.checkedAt > acc) ? t.checkedAt : acc), data.collectedAt || null);
      pingSub.textContent = targets.length > 0
        ? `${onlineCount}/${targets.length} online${latestPingAt ? ` · Stand: ${formatTimeShort(latestPingAt)}` : ''}`
        : `Überwacht Router, Pi-hole, Access Points oder NAS-Systeme${data.collectedAt ? ` · Stand: ${formatTimeShort(data.collectedAt)}` : ''}`;
    }

    const pingBody = document.getElementById('host-ping-tbody');
    if (pingBody) {
      pingBody.innerHTML = targets.length === 0
        ? `<tr><td colspan="6" class="muted-text">Noch keine Überwachungsziele eingetragen.</td></tr>`
        : targets
            .map((t) => `
              <tr>
                <td><strong>${escapeHtml(t.name)}</strong></td>
                <td class="mono" style="font-size:11.5px;">${escapeHtml(t.host)}${t.port ? `:${Number(t.port)}` : ''}</td>
                <td>
                  <span class="tag ${t.online ? 'tag-ok' : 'tag-crit'}">${t.online ? 'Online' : 'Offline'}</span>
                  ${t.error ? `<div class="mono" style="font-size:10.5px;color:var(--text-muted);">${escapeHtml(t.error)}</div>` : ''}
                </td>
                <td class="num mono">${t.latencyMs !== null && t.latencyMs !== undefined ? `${t.latencyMs} ms` : '—'}</td>
                <td class="mono" style="font-size:11px;white-space:nowrap;">
                  <div>${t.checkedAt ? escapeHtml(formatDateTimeShort(t.checkedAt)) : '—'}</div>
                  ${!t.online && t.lastOnlineAt ? `<div style="font-size:10px;color:var(--text-muted);">Zuletzt online: ${escapeHtml(formatDateTimeShort(t.lastOnlineAt))}</div>` : ''}
                </td>
                <td class="num">
                  <button type="button" class="btn-danger-ghost btn-xs" data-del-ping="${escapeHtml(t.id)}">Entfernen</button>
                </td>
              </tr>
            `)
            .join('');
    }

    const procsSub = document.getElementById('host-procs-subtitle');
    if (procsSub) {
      procsSub.textContent = `Direkt über Linux ${data.procSource || '/proc'} gelesen${data.collectedAt ? ` · Stand: ${formatTimeShort(data.collectedAt)}` : ''}`;
    }

    const procBody = document.getElementById('host-processes-tbody');
    if (procBody) {
      const procs = data.processes || [];
      procBody.innerHTML = procs.length === 0
        ? `<tr><td colspan="5" class="muted-text">Keine Host-Prozesse lesbar.</td></tr>`
        : procs
            .map((p) => `
              <tr>
                <td class="num mono">${Number(p.pid)}</td>
                <td>
                  <strong>${escapeHtml(p.name)}</strong>
                  ${p.command && p.command !== p.name ? `<div class="mono" style="font-size:11px;color:var(--text-muted);max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(p.command)}">${escapeHtml(p.command)}</div>` : ''}
                </td>
                <td><span class="tag mono">${escapeHtml(p.state || 'S')}</span></td>
                <td class="num mono">${Number(p.cpuPercent || 0).toFixed(1)}%</td>
                <td class="num mono">${formatBytesBinary(p.rssBytes)}</td>
              </tr>
            `)
            .join('');
    }

    const ports = data.ports || [];
    const portsSub = document.getElementById('host-ports-subtitle');
    if (portsSub) {
      portsSub.textContent = `${ports.length} aktive Listening-Sockets${data.collectedAt ? ` · Stand: ${formatTimeShort(data.collectedAt)}` : ''}`;
    }

    const portsBody = document.getElementById('host-ports-tbody');
    if (portsBody) {
      portsBody.innerHTML = ports.length === 0
        ? `<tr><td colspan="5" class="muted-text">Keine offenen TCP Listening-Ports erkannt.</td></tr>`
        : ports
            .map((p) => `
              <tr>
                <td class="num mono"><strong>${Number(p.port)}</strong></td>
                <td class="mono hide-sm">${escapeHtml(p.proto || 'tcp')}</td>
                <td class="mono port-addr-cell" style="font-size:11.5px;" title="${escapeHtml(p.address || '*')}">${escapeHtml(p.address || '*')}</td>
                <td><span class="tag">${escapeHtml(p.scope || 'LAN/Alle')}</span></td>
                <td class="mono" style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(p.service || '—')}</td>
              </tr>
            `)
            .join('');
    }

    // SSH & Fail2ban Monitor
    const sec = data.security || {};
    const secSrcEl = document.getElementById('host-security-source');
    if (secSrcEl) secSrcEl.textContent = sec.authLogAvailable ? 'auth.log' : 'Keine Logs';
    const sessCountEl = document.getElementById('host-ssh-sessions-count');
    const activeSessions = Array.isArray(sec.activeSessions) ? sec.activeSessions : [];
    if (sessCountEl) sessCountEl.textContent = `${activeSessions.length} aktive SSH-Sessions`;
    const banCountEl = document.getElementById('host-fail2ban-banned-count');
    const bannedList = Array.isArray(sec.bannedIps) ? sec.bannedIps : [];
    if (banCountEl) banCountEl.textContent = `${bannedList.length} blockierte IPs`;

    const secTbody = document.getElementById('host-security-tbody');
    if (secTbody) {
      const secRows = [];
      for (const b of bannedList) {
        secRows.push(`
          <tr>
            <td class="mono"><strong>${escapeHtml(b.ip)}</strong></td>
            <td><span class="tag tag-crit">Fail2ban (${escapeHtml(b.jail || 'sshd')})</span></td>
            <td class="mono" style="font-size:11px;">${escapeHtml(b.ts || 'Gesperrt')}</td>
          </tr>
        `);
      }
      for (const f of (sec.failedLogins || []).slice(0, 15)) {
        secRows.push(`
          <tr>
            <td class="mono">${escapeHtml(f.ip || '—')}</td>
            <td><span class="tag tag-warn">SSH-Fehler</span></td>
            <td class="mono" style="font-size:11px;">User: ${escapeHtml(f.user || '—')} · ${escapeHtml(f.ts || '')}</td>
          </tr>
        `);
      }
      secTbody.innerHTML = secRows.length === 0
        ? '<tr><td colspan="3" class="muted-text">Keine fehlgeschlagenen SSH-Logins oder Fail2ban-Sperren erkannt.</td></tr>'
        : secRows.join('');
    }

    // SSL Certificates
    const sslTbody = document.getElementById('host-ssl-tbody');
    if (sslTbody) {
      const sslTargets = data.sslTargets || [];
      sslTbody.innerHTML = sslTargets.length === 0
        ? '<tr><td colspan="5" class="muted-text">Noch keine SSL-Domains eingetragen.</td></tr>'
        : sslTargets
            .map((s) => {
              const days = s.daysRemaining;
              const statusBadge = !s.checkedAt
                ? '<span class="tag">Ausstehend</span>'
                : s.error
                ? `<span class="tag tag-crit">Fehler</span>`
                : !s.valid
                ? '<span class="tag tag-crit">Abgelaufen / Ungültig</span>'
                : days <= 14
                ? '<span class="tag tag-warn">Läuft bald ab</span>'
                : '<span class="tag tag-ok">Gültig</span>';
              const daysStr = Number.isFinite(days) ? `${days} Tage` : '—';
              return `
                <tr>
                  <td>
                    <strong>${escapeHtml(s.name)}</strong>
                    <div class="mono" style="font-size:11px;color:var(--text-muted);">${escapeHtml(s.host)}:${Number(s.port) || 443}${s.issuer ? ` · ${escapeHtml(s.issuer)}` : ''}</div>
                  </td>
                  <td>
                    ${statusBadge}
                    ${s.error ? `<div class="mono" style="font-size:10.5px;color:var(--text-muted);">${escapeHtml(s.error)}</div>` : ''}
                  </td>
                  <td class="num mono">${escapeHtml(daysStr)}</td>
                  <td class="mono" style="font-size:11px;">${s.checkedAt ? escapeHtml(formatDateTimeShort(s.checkedAt)) : '—'}</td>
                  <td class="num"><button type="button" class="btn-danger-ghost btn-xs" data-del-ssl="${escapeHtml(s.id)}">Entfernen</button></td>
                </tr>
              `;
            })
            .join('');
    }
  }

  // ==================== PUSH NOTIFICATIONS & SECURITY AUDIT ====================
  async function loadNotificationsState() {
    try {
      const res = await fetch('/api/notifications/state', { cache: 'no-store' });
      if (!res.ok) return;
      state.notificationsState = await res.json();
      renderNotificationsPanel();
    } catch {
      // ignore
    }
  }

  function renderNotificationsPanel() {
    const data = state.notificationsState;
    if (!data) return;

    const badge = document.getElementById('notif-status-badge');
    if (badge) {
      badge.textContent = data.enabled ? 'Aktiv' : 'Deaktiviert';
      badge.className = `tag ${data.enabled ? 'tag-ok' : ''}`;
    }

    document.getElementById('notif-enabled').checked = Boolean(data.enabled);
    document.getElementById('notif-cooldown').value = Number(data.cooldownMinutes) || 30;
    const trig = data.triggers || {};
    document.getElementById('notif-trig-smart').checked = trig.smart !== false;
    document.getElementById('notif-trig-diskfull').checked = trig.diskFull !== false;
    document.getElementById('notif-trig-cputemp').checked = trig.cpuTemp !== false;
    document.getElementById('notif-trig-disktemp').checked = trig.diskTemp !== false;
    document.getElementById('notif-trig-watchdog').checked = trig.watchdog !== false;

    const ch = data.channels || {};
    document.getElementById('notif-ntfy-enabled').checked = Boolean(ch.ntfy?.enabled);
    document.getElementById('notif-ntfy-url').value = ch.ntfy?.url || '';
    document.getElementById('notif-ntfy-topic').value = ch.ntfy?.topic || '';
    const ntfyTok = document.getElementById('notif-ntfy-token');
    if (ntfyTok) {
      ntfyTok.value = '';
      ntfyTok.placeholder = ch.ntfy?.hasToken ? 'Token gespeichert (leer lassen zum Behalten)' : 'Token (optional)';
    }

    document.getElementById('notif-discord-enabled').checked = Boolean(ch.discord?.enabled);
    const discordUrl = document.getElementById('notif-discord-url');
    const discordHint = document.getElementById('notif-discord-hint');
    if (discordUrl) {
      discordUrl.value = '';
      discordUrl.placeholder = ch.discord?.hasWebhookUrl ? 'Webhook-URL gespeichert (leer lassen zum Behalten)' : 'https://discord.com/api/webhooks/…';
    }
    if (discordHint) {
      discordHint.textContent = ch.discord?.hasWebhookUrl
        ? 'Discord Webhook-URL gespeichert. Leer lassen zum Behalten oder neue URL einfügen.'
        : 'Sendet farbige Embeds bei Server-Ereignissen.';
    }

    document.getElementById('notif-telegram-enabled').checked = Boolean(ch.telegram?.enabled);
    const tgTok = document.getElementById('notif-telegram-token');
    if (tgTok) {
      tgTok.value = '';
      tgTok.placeholder = ch.telegram?.hasBotToken ? 'Bot Token gespeichert (leer lassen zum Behalten)' : 'Bot Token (123456:ABC…)';
    }
    document.getElementById('notif-telegram-chatid').value = ch.telegram?.chatId || '';

    document.getElementById('notif-webhook-enabled').checked = Boolean(ch.webhook?.enabled);
    document.getElementById('notif-webhook-url').value = ch.webhook?.url || '';
    const whSec = document.getElementById('notif-webhook-secret');
    if (whSec) {
      whSec.value = '';
      whSec.placeholder = ch.webhook?.hasSecret ? 'Secret gespeichert (leer lassen zum Behalten)' : 'Bearer Secret (optional)';
    }

    const histEl = document.getElementById('notif-history-list');
    if (histEl) {
      const history = data.history || [];
      if (history.length === 0) {
        histEl.innerHTML = `<p class="muted-text">Noch keine Push-Benachrichtigungen gesendet.</p>`;
      } else {
        histEl.innerHTML = history
          .slice(0, 20)
          .map((h) => {
            const lvl = h.level === 'crit' || h.level === 'error' ? 'tag-crit' : h.level === 'warn' ? 'tag-warn' : 'tag-ok';
            const resultsStr = (h.results || []).map((r) => `${r.channel}: ${r.ok ? 'OK' : r.error || 'Fehler'}`).join(' · ');
            return `
              <div class="managed-service-row">
                <div style="min-width:0;">
                  <div style="font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span class="tag ${lvl}">${escapeHtml(h.source || 'push')}</span>
                    <span>${escapeHtml(h.title)}</span>
                  </div>
                  <div style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(h.message)}</div>
                  ${resultsStr ? `<div class="mono" style="font-size:10.5px;color:var(--text-muted);">${escapeHtml(resultsStr)}</div>` : ''}
                </div>
                <span class="mono" style="font-size:11px;color:var(--text-muted);flex-shrink:0;">${escapeHtml(new Date(h.ts).toLocaleString('de-DE'))}</span>
              </div>
            `;
          })
          .join('');
      }
    }
  }

  async function loadAuthMeta() {
    try {
      const res = await fetch('/api/auth/meta', { cache: 'no-store' });
      if (!res.ok) return;
      const meta = await res.json();
      const badge = document.getElementById('auth-mode-badge');
      if (badge) {
        if (meta.envOverrideActive) {
          badge.textContent = 'ENV-Passwort aktiv';
          badge.className = 'tag tag-warn';
        } else if (meta.authEnabled) {
          badge.textContent = 'Passwort aktiv';
          badge.className = 'tag tag-ok';
        } else {
          badge.textContent = 'Ohne Passwort';
          badge.className = 'tag';
        }
      }
      document.getElementById('btn-logout')?.classList.toggle('hidden', !meta.authEnabled);
      const totpBadge = document.getElementById('totp-status-badge');
      const totpStartWrap = document.getElementById('totp-setup-start-wrap');
      const totpDisableForm = document.getElementById('form-totp-disable');
      const totpSetupPanel = document.getElementById('totp-setup-panel');
      if (totpBadge) {
        totpBadge.textContent = meta.totpEnabled ? 'Aktiv' : 'Deaktiviert';
        totpBadge.className = `tag ${meta.totpEnabled ? 'tag-ok' : ''}`;
      }
      if (totpStartWrap) totpStartWrap.classList.toggle('hidden', Boolean(meta.totpEnabled));
      if (totpDisableForm) totpDisableForm.classList.toggle('hidden', !meta.totpEnabled);
      if (meta.totpEnabled && totpSetupPanel) totpSetupPanel.classList.add('hidden');
    } catch {
      // ignore
    }
  }

  async function loadAuditLog() {
    try {
      const res = await fetch('/api/audit?limit=100', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      state.auditEvents = data.events || [];
      const tbody = document.getElementById('audit-log-tbody');
      if (!tbody) return;
      if (state.auditEvents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="muted-text">Noch keine Sicherheits- oder Audit-Ereignisse protokolliert.</td></tr>`;
        return;
      }
      tbody.innerHTML = state.auditEvents
        .map((ev) => {
          const lvl = ev.level === 'error' ? 'tag-crit' : ev.level === 'warn' ? 'tag-warn' : 'tag-ok';
          return `
            <tr>
              <td class="mono" style="font-size:11px;white-space:nowrap;">${escapeHtml(new Date(ev.ts).toLocaleString('de-DE'))}</td>
              <td class="mono" style="font-size:11px;">${escapeHtml(ev.ip || '—')}</td>
              <td><span class="tag ${lvl} mono">${escapeHtml(ev.action)}</span></td>
              <td style="font-size:12px;">${escapeHtml(ev.detail || '')}</td>
            </tr>
          `;
        })
        .join('');
    } catch {
      // ignore
    }
  }

  // ==================== AUTOMATION, WATCHDOG & WAKE-ON-LAN ====================
  async function loadAutomationState() {
    try {
      const [res, auRes] = await Promise.all([
        fetch('/api/automation/state', { cache: 'no-store' }),
        fetch('/api/docker/autoupdate', { cache: 'no-store' })
      ]);
      if (!res.ok) return;
      state.automationData = await res.json();
      if (auRes.ok) {
        state.autoUpdateConfig = await auRes.json();
      }
      renderAutomationView();
    } catch {
      // ignore
    }
  }

  function renderWatchdogContainerPicker(selectedNames = []) {
    const mode = document.getElementById('wd-mode')?.value || 'all';
    const group = document.getElementById('wd-containers-group');
    const listEl = document.getElementById('wd-containers-list');
    if (!group || !listEl) return;

    group.classList.toggle('hidden', mode !== 'selected');
    const containers = (state.snapshot?.docker?.containers || []).filter((c) => c.name !== 'homeserver-dashboard');
    if (containers.length === 0) {
      listEl.innerHTML = `<span class="muted-text">Keine Container erkannt.</span>`;
      return;
    }
    const selSet = new Set(selectedNames);
    listEl.innerHTML = containers
      .map((c) => `
        <label class="accent-swatch-btn" style="cursor:pointer;">
          <input type="checkbox" class="wd-container-cb" value="${escapeHtml(c.name)}" ${selSet.has(c.name) ? 'checked' : ''} />
          <span>${escapeHtml(c.name)}</span>
        </label>
      `)
      .join('');
  }

  function renderAutomationView() {
    const data = state.automationData;
    if (!data) return;

    const wd = data.watchdog || {};
    const badge = document.getElementById('wd-status-badge');
    if (badge) {
      badge.textContent = wd.enabled ? 'Aktiv (30s)' : 'Deaktiviert';
      badge.className = `tag ${wd.enabled ? 'tag-ok' : ''}`;
    }
    document.getElementById('wd-enabled').checked = Boolean(wd.enabled);
    document.getElementById('wd-mode').value = wd.mode || 'all';
    document.getElementById('wd-cooldown').value = Number(wd.cooldownSeconds) || 180;
    document.getElementById('wd-unhealthy').checked = wd.restartUnhealthy !== false;
    document.getElementById('wd-exited').checked = Boolean(wd.restartExitedError);
    const trashDaysEl = document.getElementById('wd-trash-days');
    if (trashDaysEl) trashDaysEl.value = String(Number(wd.trashAutoCleanDays) || 0);
    renderWatchdogContainerPicker(wd.containerNames || []);

    // WoL table
    const wolBody = document.getElementById('wol-devices-tbody');
    const devices = data.wolDevices || [];
    if (wolBody) {
      wolBody.innerHTML = devices.length === 0
        ? `<tr><td colspan="4" class="muted-text">Noch keine LAN-Geräte gespeichert.</td></tr>`
        : devices
            .map((d) => `
              <tr>
                <td><strong>${escapeHtml(d.name)}</strong></td>
                <td class="mono">${escapeHtml(d.mac)}</td>
                <td class="mono">${escapeHtml(d.broadcastIp)}:${Number(d.port) || 9}</td>
                <td class="num">
                  <div class="table-actions-row">
                    <button type="button" class="btn-primary btn-sm" data-wol-wake="${escapeHtml(d.id)}">Aufwecken</button>
                    <button type="button" class="btn-danger-ghost btn-sm" data-wol-del="${escapeHtml(d.id)}">Entfernen</button>
                  </div>
                </td>
              </tr>
            `)
            .join('');
    }

    // Schedules table
    const schedBody = document.getElementById('schedules-tbody');
    const schedules = data.schedules || [];
    const typeLabels = {
      'media-scan': 'Mediathek-Scan',
      'storage-analysis': 'Speicher- & Duplikate-Analyse',
      'container-restart': 'Container-Neustart',
      'trash-cleanup': 'Papierkorb-Automatik'
    };
    if (schedBody) {
      schedBody.innerHTML = schedules.length === 0
        ? `<tr><td colspan="6" class="muted-text">Noch keine täglichen Zeitpläne angelegt.</td></tr>`
        : schedules
            .map((s) => `
              <tr>
                <td><input type="checkbox" data-sched-toggle="${escapeHtml(s.id)}" ${s.enabled ? 'checked' : ''} aria-label="Zeitplan aktiv" /></td>
                <td><strong>${escapeHtml(s.name)}</strong></td>
                <td>${escapeHtml(typeLabels[s.type] || s.type)}${s.target ? ` <span class="tag mono">${escapeHtml(s.target)}</span>` : ''}</td>
                <td class="mono">${escapeHtml(s.timeHHMM)}</td>
                <td class="mono">${escapeHtml(s.lastRunDate || 'Noch nie')}</td>
                <td class="num">
                  <div class="table-actions-row">
                    <button type="button" class="btn-secondary btn-sm" data-sched-run="${escapeHtml(s.id)}">Jetzt starten</button>
                    <button type="button" class="btn-danger-ghost btn-sm" data-sched-del="${escapeHtml(s.id)}">Löschen</button>
                  </div>
                </td>
              </tr>
            `)
            .join('');
    }

    // Events log
    const evtBody = document.getElementById('automation-events-tbody');
    const events = data.events || [];
    if (evtBody) {
      evtBody.innerHTML = events.length === 0
        ? `<tr><td colspan="4" class="muted-text">Noch keine Ereignisse protokolliert.</td></tr>`
        : events
            .map((ev) => {
              const lvlClass = ev.level === 'error' ? 'tag-crit' : ev.level === 'warn' ? 'tag-warn' : 'tag-ok';
              return `
                <tr>
                  <td class="mono" style="font-size:11.5px;">${escapeHtml(new Date(ev.ts).toLocaleString('de-DE'))}</td>
                  <td><span class="tag mono">${escapeHtml(ev.source)}</span></td>
                  <td><span class="tag ${lvlClass}">${escapeHtml(ev.level)}</span></td>
                  <td>${escapeHtml(ev.message)}</td>
                </tr>
              `;
            })
            .join('');
    }

    const au = state.autoUpdateConfig || {};
    const auBadge = document.getElementById('autoupdate-status-badge');
    if (auBadge) {
      auBadge.textContent = au.enabled ? `Aktiv (${au.timeHHMM || '03:00'})` : 'Deaktiviert';
      auBadge.className = `tag ${au.enabled ? 'tag-ok' : ''}`;
    }
    const auEnabledEl = document.getElementById('autoupdate-enabled');
    if (auEnabledEl) auEnabledEl.checked = Boolean(au.enabled);
    const auTimeEl = document.getElementById('autoupdate-time');
    if (auTimeEl) auTimeEl.value = au.timeHHMM || '03:00';
    const auLastEl = document.getElementById('autoupdate-last-run');
    if (auLastEl) auLastEl.textContent = au.lastRunAt ? formatDateTimeShort(au.lastRunAt) : 'Noch kein Lauf';
  }

  // ==================== SETTINGS VIEW ====================
  let settingsPopulated = false;
  function renderSettingsView(data) {
    const cfg = data.config || {};
    if (!settingsPopulated) {
      document.getElementById('input-server-name').value = cfg.serverName || '';
      document.getElementById('input-media-paths').value = (cfg.mediaPaths || []).join(', ');
      const pwr = cfg.power || {};
      const idleEl = document.getElementById('input-power-idle');
      const maxEl = document.getElementById('input-power-max');
      const kwhEl = document.getElementById('input-power-kwh');
      if (idleEl) idleEl.value = pwr.idleWatts ?? 18;
      if (maxEl) maxEl.value = pwr.maxWatts ?? 65;
      if (kwhEl) kwhEl.value = pwr.kwhPriceEur ?? 0.32;
      const detected = data.portainer?.detectedUrl ? resolveServiceUrl(data.portainer.detectedUrl) : '';
      document.getElementById('input-portainer-url').value = cfg.portainerUrl || detected || '';
      settingsPopulated = true;
    }

    const activeTheme = normalizeThemeName(document.documentElement.getAttribute('data-theme') || cfg.ui?.theme || 'studio-dark');
    const activeAccent = document.documentElement.getAttribute('data-accent') || cfg.ui?.accent || 'blue';
    document.querySelectorAll('[data-pick-theme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pickTheme === activeTheme);
    });
    document.querySelectorAll('[data-pick-accent]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pickAccent === activeAccent);
    });

    const tokenInput = document.getElementById('input-portainer-token');
    const tokenHint = document.getElementById('portainer-token-hint');
    if (tokenInput && tokenHint) {
      if (cfg.hasPortainerApiKey) {
        tokenInput.placeholder = 'Token gespeichert (leer lassen zum Behalten)';
        tokenHint.textContent = 'API-Token aktiv gespeichert. Stacks werden direkt über Portainer bereitgestellt.';
      } else {
        tokenInput.placeholder = 'ptr_…';
        tokenHint.textContent = 'Optional für Stack-Steuerung und App-Store-Deploy direkt in Portainer.';
      }
    }

    const listEl = document.getElementById('settings-services-list');
    const services = cfg.services || [];
    if (services.length === 0) {
      listEl.innerHTML = `<p class="muted-text">Keine Dienste eingetragen.</p>`;
      return;
    }

    listEl.innerHTML = services
      .map((svc) => `
        <div class="managed-service-row">
          <div style="min-width:0;">
            <div style="font-weight:600;font-size:13px;">${escapeHtml(svc.name)} <span class="tag" style="margin-left:4px;">${escapeHtml(svc.category || 'App')}</span></div>
            <div class="mono" style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(svc.url)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn-secondary btn-sm" data-edit-service="${escapeHtml(svc.id)}">Bearbeiten</button>
            <button class="btn-danger-ghost btn-sm" data-delete-service="${escapeHtml(svc.id)}">Löschen</button>
          </div>
        </div>
      `)
      .join('');
  }

  // ==================== API MUTATIONS ====================
  async function saveConfigPatch(patch) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      let msg = 'Speichern fehlgeschlagen';
      try {
        const d = await res.json();
        if (d?.error) msg = d.error;
      } catch {
        // ignore JSON parse errors
      }
      throw new Error(msg);
    }
    const updated = await res.json();
    if (state.snapshot) {
      state.snapshot.config = updated;
      renderAll();
    }
    return updated;
  }

  async function triggerMediaRescan() {
    const btn = document.getElementById('btn-rescan-media');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Scanne…';
    }
    startGlobalProgress();
    setInlineProgress('media-scan-progress', { active: true, label: 'Scanne Mediathek-Ordner…' });
    try {
      const res = await fetch(`/api/media/scan`, { method: 'POST' });
      if (res.ok) handleSnapshot(await res.json());
    } finally {
      setInlineProgress('media-scan-progress', { active: false });
      endGlobalProgress();
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Neu scannen';
      }
    }
  }

  async function loadContainerLogs(id, name) {
    state.activeLogContainerId = id;
    document.getElementById('modal-logs-title').textContent = `Logs: ${name || id}`;
    document.getElementById('modal-logs-subtitle').textContent = `Container-ID: ${id}`;
    document.getElementById('logs-content').textContent = 'Lade Logs…';
    openModal('modal-logs');

    try {
      const res = await fetch(`/api/docker/${encodeURIComponent(id)}/logs?tail=120`);
      const payload = await res.json();
      const box = document.getElementById('logs-content');
      box.textContent = payload.logs || '(Keine Log-Ausgabe vorhanden)';
      box.scrollTop = box.scrollHeight;
    } catch (err) {
      document.getElementById('logs-content').textContent = `Fehler beim Laden: ${err.message}`;
    }
  }

  // ==================== EVENTS ====================
  function bindEvents() {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.goto));
    });

    // Global Search Ctrl+K
    const openSearch = () => {
      document.getElementById('global-search-input').value = '';
      state.globalFileSearchResults = [];
      renderGlobalSearchResults(true);
      openModal('modal-search');
      setTimeout(() => document.getElementById('global-search-input').focus(), 30);
    };
    document.getElementById('btn-global-search').addEventListener('click', openSearch);
    document.getElementById('global-search-input').addEventListener('input', () => renderGlobalSearchResults(false));
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearch();
      } else if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach((m) => closeModal(m.id));
      }
    });

    // Alerts & Power
    document.getElementById('btn-alerts').addEventListener('click', () => openModal('modal-alerts'));
    document.getElementById('btn-power').addEventListener('click', () => openModal('modal-power'));
    document.querySelectorAll('[data-power-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.powerAction;
        if (!confirm(`Server wirklich ${action === 'reboot' ? 'neu starten' : 'herunterfahren'}?`)) return;
        const res = await fetch(`/api/system/power`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (!res.ok) alert(data.error);
        else closeModal('modal-power');
      });
    });

    // Live Toggle
    document.getElementById('btn-pause').addEventListener('click', () => {
      state.paused = !state.paused;
      updateLiveIndicator();
      if (!state.paused) fetchSnapshotOnce();
    });

    // Telemetry Chart Tabs & Timeframe Selector
    document.querySelectorAll('[data-chart]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartMode = btn.dataset.chart;
        document.querySelectorAll('[data-chart]').forEach((b) => b.classList.toggle('active', b === btn));
        drawTelemetryChart();
      });
    });
    document.querySelectorAll('[data-chart-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartRangeSec = Number(btn.dataset.chartRange) || 60;
        document.querySelectorAll('[data-chart-range]').forEach((b) => b.classList.toggle('active', b === btn));
        if (state.chartRangeSec > 900) {
          loadTelemetryHistory(state.chartRangeSec);
        } else {
          drawTelemetryChart();
        }
      });
    });

    // Docker Filters
    document.querySelectorAll('[data-docker-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.dockerFilter = btn.dataset.dockerFilter;
        document.querySelectorAll('[data-docker-filter]').forEach((b) => b.classList.toggle('active', b === btn));
        if (state.snapshot) renderDockerTables(state.snapshot.docker);
      });
    });
    document.getElementById('overview-docker-search').addEventListener('input', () => {
      if (state.snapshot) renderDockerTables(state.snapshot.docker);
    });
    document.getElementById('docker-full-search').addEventListener('input', () => {
      if (state.snapshot) renderDockerTables(state.snapshot.docker);
    });
    document.getElementById('btn-rescan-media').addEventListener('click', triggerMediaRescan);

    // Overview Widget Customizer
    document.getElementById('btn-customize-overview').addEventListener('click', () => {
      const box = document.getElementById('overview-customizer');
      box.classList.toggle('hidden');
      renderWidgetCustomizer();
    });
    document.getElementById('btn-close-overview-customizer').addEventListener('click', () => {
      document.getElementById('overview-customizer').classList.add('hidden');
    });
    document.getElementById('btn-reset-overview-widgets').addEventListener('click', async () => {
      const defaults = DEFAULT_OVERVIEW_WIDGETS.map((w) => ({ ...w }));
      applyOverviewWidgets(defaults);
      try {
        await saveConfigPatch({ ui: { overviewWidgets: state.overviewWidgets } });
      } catch {
        // ignore save error if offline
      }
    });

    // Files View Controls
    document.getElementById('btn-files-view-list').addEventListener('click', () => {
      state.filesViewMode = 'list';
      document.getElementById('btn-files-view-list').classList.add('active');
      document.getElementById('btn-files-view-grid').classList.remove('active');
      renderFilesView();
    });
    document.getElementById('btn-files-view-grid').addEventListener('click', () => {
      state.filesViewMode = 'grid';
      document.getElementById('btn-files-view-grid').classList.add('active');
      document.getElementById('btn-files-view-list').classList.remove('active');
      renderFilesView();
    });
    document.querySelectorAll('[data-files-search-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filesSearchScope = btn.dataset.filesSearchScope === 'global' ? 'global' : 'folder';
        document.querySelectorAll('[data-files-search-scope]').forEach((b) => b.classList.toggle('active', b === btn));
        const searchInput = document.getElementById('files-search');
        if (searchInput) {
          searchInput.placeholder = state.filesSearchScope === 'global'
            ? 'Alle Laufwerke rekursiv durchsuchen…'
            : 'In Ordner filtern…';
          if (state.filesSearchScope === 'global' && searchInput.value.trim()) {
            runGlobalFilesSearch(searchInput.value);
          } else {
            state.filesGlobalResults = null;
            renderFilesView();
          }
        }
      });
    });
    document.getElementById('files-search').addEventListener('input', (e) => {
      const val = e.target.value || '';
      if (state.filesGlobalSearchTimer) {
        clearTimeout(state.filesGlobalSearchTimer);
        state.filesGlobalSearchTimer = null;
      }
      if (state.filesSearchScope === 'global' && !state.filesTrashMode) {
        if (!val.trim()) {
          state.filesGlobalResults = null;
          renderFilesView();
          return;
        }
        state.filesGlobalSearchTimer = setTimeout(() => runGlobalFilesSearch(val), 220);
      } else {
        renderFilesView();
      }
    });
    document.getElementById('files-grid-container').addEventListener(
      'error',
      (e) => {
        const img = e.target;
        if (!img || img.tagName !== 'IMG') return;
        const fallback = img.dataset.fallbackSrc || '';
        if (fallback && img.dataset.fallbackTried !== '1') {
          img.dataset.fallbackTried = '1';
          img.src = fallback;
          return;
        }
        const emoji = img.dataset.thumbKind === 'video' ? '🎬' : '🖼️';
        const span = document.createElement('span');
        span.textContent = emoji;
        img.replaceWith(span);
      },
      true
    );
    document.getElementById('btn-files-refresh').addEventListener('click', () => {
      if (state.filesTrashMode) loadTrashView();
      else loadFilesDirectory(state.filesPath);
    });
    document.getElementById('btn-files-trash').addEventListener('click', loadTrashView);
    document.getElementById('btn-files-shares')?.addEventListener('click', openSharesListModal);
    document.getElementById('form-share')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const targetPath = document.getElementById('share-target-path').value;
      const ttlHours = Number(document.getElementById('share-ttl').value) || 0;
      const password = document.getElementById('share-password').value;
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath, ttlHours, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || 'Freigabe-Link konnte nicht erstellt werden');
        return;
      }
      const shareUrl = `${window.location.origin}/s/${data.token}`;
      document.getElementById('share-result-url').value = shareUrl;
      document.getElementById('share-result-box').classList.remove('hidden');
      refreshSharesBadge();
    });
    document.getElementById('btn-copy-share-url')?.addEventListener('click', async () => {
      const input = document.getElementById('share-result-url');
      const btn = document.getElementById('btn-copy-share-url');
      if (!input?.value) return;
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      if (btn) {
        btn.textContent = 'Kopiert!';
        setTimeout(() => { btn.textContent = 'Kopieren'; }, 1800);
      }
    });
    document.getElementById('btn-files-mkdir').addEventListener('click', async () => {
      const name = prompt('Name des neuen Ordners:');
      if (!name || !name.trim()) return;
      const res = await fetch(`/api/files/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath: state.filesPath, name: name.trim() })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Ordner konnte nicht erstellt werden');
        return;
      }
      loadFilesDirectory(state.filesPath);
    });
    document.getElementById('btn-files-upload').addEventListener('click', () => document.getElementById('file-upload-input').click());
    document.getElementById('file-upload-input').addEventListener('change', (e) => {
      uploadFilesWithProgress(e.target.files);
      e.target.value = '';
    });

    // External OS Drag & Drop Upload (ignores internal file moves)
    const dropzone = document.getElementById('files-dropzone');
    dropzone.addEventListener('dragover', (e) => {
      const isInternal = Array.from(e.dataTransfer?.types || []).includes('application/x-hs-paths');
      if (isInternal) return;
      e.preventDefault();
      if (!state.filesTrashMode && state.filesPath !== '/') dropzone.classList.add('drop-active');
    });
    dropzone.addEventListener('dragleave', (e) => {
      if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('drop-active');
    });
    dropzone.addEventListener('drop', (e) => {
      const isInternal = Array.from(e.dataTransfer?.types || []).includes('application/x-hs-paths');
      if (isInternal) return;
      e.preventDefault();
      dropzone.classList.remove('drop-active');
      if (!state.filesTrashMode && e.dataTransfer?.files?.length) {
        uploadFilesWithProgress(e.dataTransfer.files);
      }
    });

    // Internal Drag & Drop Move (onto folders, breadcrumbs, sidebar roots, or Trash)
    const filesSection = document.getElementById('view-files');
    let lastDropHighlight = null;
    const clearDropHighlight = () => {
      if (lastDropHighlight) {
        lastDropHighlight.classList.remove('drop-target-hover');
        lastDropHighlight = null;
      }
    };
    filesSection.addEventListener('dragstart', (e) => {
      const dragEl = e.target.closest('[data-drag-path]');
      if (!dragEl || e.target.closest('input, button, a')) {
        if (!dragEl) return;
      }
      if (!dragEl) return;
      const draggedPath = dragEl.dataset.dragPath;
      const sources = state.selectedFiles.has(draggedPath) && state.selectedFiles.size > 1
        ? [...state.selectedFiles]
        : [draggedPath];
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-hs-paths', JSON.stringify(sources));
    });
    filesSection.addEventListener('dragend', clearDropHighlight);
    filesSection.addEventListener('dragover', (e) => {
      const isInternal = Array.from(e.dataTransfer?.types || []).includes('application/x-hs-paths');
      if (!isInternal) return;
      const target = e.target.closest('[data-drop-dir], #btn-files-trash');
      if (!target) {
        clearDropHighlight();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (lastDropHighlight !== target) {
        clearDropHighlight();
        target.classList.add('drop-target-hover');
        lastDropHighlight = target;
      }
    });
    filesSection.addEventListener('dragleave', (e) => {
      const target = e.target.closest('[data-drop-dir], #btn-files-trash');
      if (target && !target.contains(e.relatedTarget)) {
        target.classList.remove('drop-target-hover');
        if (lastDropHighlight === target) lastDropHighlight = null;
      }
    });
    filesSection.addEventListener('drop', async (e) => {
      const isInternal = Array.from(e.dataTransfer?.types || []).includes('application/x-hs-paths');
      if (!isInternal) return;
      const target = e.target.closest('[data-drop-dir], #btn-files-trash');
      clearDropHighlight();
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();

      let paths = [];
      try {
        paths = JSON.parse(e.dataTransfer.getData('application/x-hs-paths') || '[]');
      } catch {
        paths = [];
      }
      if (!Array.isArray(paths) || paths.length === 0) return;

      if (target.id === 'btn-files-trash') {
        const res = await fetch('/api/files/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths })
        });
        if (!res.ok) {
          alert((await res.json().catch(() => ({}))).error || 'Verschieben in den Papierkorb fehlgeschlagen');
          return;
        }
        loadFilesDirectory(state.filesPath);
        refreshTrashBadge();
        return;
      }

      const destDir = target.dataset.dropDir;
      if (!destDir || paths.includes(destDir)) return;
      const res = await fetch('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: paths, destDir })
      });
      if (!res.ok) {
        alert((await res.json().catch(() => ({}))).error || 'Verschieben fehlgeschlagen');
        return;
      }
      loadFilesDirectory(state.filesPath);
    });

    // Select All & Bulk Actions
    document.getElementById('files-select-all').addEventListener('change', (e) => {
      const items = state.filesListing?.items || [];
      if (e.target.checked) items.forEach((i) => state.selectedFiles.add(i.path));
      else state.selectedFiles.clear();
      renderFilesView();
      updateBulkBar();
    });

    document.getElementById('btn-bulk-copy').addEventListener('click', () => openCopyMoveModal('copy'));
    document.getElementById('btn-bulk-move').addEventListener('click', () => openCopyMoveModal('move'));
    document.getElementById('cm-btn-mkdir').addEventListener('click', async () => {
      const parentPath = state.copyMoveBrowserPath;
      if (!parentPath || parentPath === '/') return;
      const name = prompt(`Neuen Zielordner in "${parentPath}" erstellen:`);
      if (!name || !name.trim()) return;
      const res = await fetch('/api/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath, name: name.trim() })
      });
      if (!res.ok) {
        alert((await res.json().catch(() => ({}))).error || 'Ordner konnte nicht erstellt werden');
        return;
      }
      const created = await res.json();
      await loadCopyMoveDirs(created.path || parentPath);
      if (parentPath === state.filesPath) loadFilesDirectory(state.filesPath);
    });

    document.getElementById('form-copy-move').addEventListener('submit', async (e) => {
      e.preventDefault();
      const action = document.getElementById('cm-action').value;
      const destDir = document.getElementById('cm-dest-input').value.trim();
      const sources = state.copyMoveSources.length > 0 ? state.copyMoveSources : [...state.selectedFiles];
      if (sources.length === 0 || !destDir) return;

      const submitBtn = document.getElementById('cm-submit-btn');
      const prevText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = action === 'move' ? 'Verschiebe…' : 'Kopiere…';
      try {
        const res = await fetch(`/api/files/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources, destDir })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          return alert(d.error || 'Aktion fehlgeschlagen');
        }
        closeModal('modal-copy-move');
        loadFilesDirectory(state.filesPath);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = prevText;
      }
    });

    document.getElementById('btn-bulk-zip').addEventListener('click', () => {
      const qs = [...state.selectedFiles].map((p) => `path=${encodeURIComponent(p)}`).join('&');
      window.location.href = `/api/files/zip?${qs}`;
    });

    document.getElementById('btn-bulk-delete').addEventListener('click', async () => {
      const paths = [...state.selectedFiles];
      if (paths.length === 0) return;
      if (!confirm(`${paths.length} ausgewählte Einträge in den Papierkorb verschieben?`)) return;
      const res = await fetch(`/api/files/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Verschieben in den Papierkorb fehlgeschlagen');
        return;
      }
      loadFilesDirectory(state.filesPath);
      refreshTrashBadge();
    });

    // Safe Trash Controls
    document.getElementById('trash-select-all').addEventListener('change', (e) => {
      const items = state.trashListing?.items || [];
      if (e.target.checked) items.forEach((i) => state.selectedTrashKeys.add(i.trashKey));
      else state.selectedTrashKeys.clear();
      renderTrashView();
    });
    async function performTrashRestore(keys, conflictMode = 'check') {
      const res = await fetch('/api/files/trash/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashKeys: keys, conflictMode })
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        state.pendingTrashRestoreKeys = keys;
        const listEl = document.getElementById('trash-conflict-list');
        if (listEl) {
          listEl.innerHTML = (data.conflicts || [])
            .map((c) => `<div>• <strong>${escapeHtml(c.name)}</strong> → ${escapeHtml(c.originalPath)}</div>`)
            .join('') || escapeHtml(data.message || 'Ziel existiert bereits.');
        }
        openModal('modal-trash-conflict');
        return;
      }
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Wiederherstellen fehlgeschlagen');
      await loadTrashView();
      refreshTrashBadge();
    }
    window.__performTrashRestore = performTrashRestore;

    document.getElementById('btn-trash-restore-sel').addEventListener('click', async () => {
      const keys = [...state.selectedTrashKeys];
      if (keys.length === 0) return;
      await performTrashRestore(keys, 'check');
    });
    document.getElementById('btn-trash-conflict-rename')?.addEventListener('click', async () => {
      closeModal('modal-trash-conflict');
      if (state.pendingTrashRestoreKeys?.length) {
        await performTrashRestore(state.pendingTrashRestoreKeys, 'rename');
        state.pendingTrashRestoreKeys = [];
      }
    });
    document.getElementById('btn-trash-conflict-overwrite')?.addEventListener('click', async () => {
      closeModal('modal-trash-conflict');
      if (state.pendingTrashRestoreKeys?.length) {
        await performTrashRestore(state.pendingTrashRestoreKeys, 'overwrite');
        state.pendingTrashRestoreKeys = [];
      }
    });
    document.getElementById('btn-trash-delete-sel').addEventListener('click', async () => {
      const keys = [...state.selectedTrashKeys];
      if (keys.length === 0) return;
      if (!confirm(`${keys.length} Einträge endgültig löschen? Dies kann nicht rückgängig gemacht werden.`)) return;
      const res = await fetch('/api/files/trash/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashKeys: keys })
      });
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Endgültiges Löschen fehlgeschlagen');
      await loadTrashView();
      refreshTrashBadge();
    });
    document.getElementById('btn-trash-empty').addEventListener('click', async () => {
      if (!confirm('Gesamten Papierkorb endgültig leeren? Alle darin befindlichen Dateien werden dauerhaft gelöscht.')) return;
      const res = await fetch('/api/files/trash/empty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Papierkorb leeren fehlgeschlagen');
      await loadTrashView();
      refreshTrashBadge();
    });

    // Media Preview Video Controls (Transcode & Start Jump)
    document.getElementById('btn-preview-transcode')?.addEventListener('click', () => {
      if (!state.activePreview || state.activePreview.kind !== 'video') return;
      state.activePreview.mode = state.activePreview.mode === 'transcode' ? 'native' : 'transcode';
      renderVideoStage(state.activePreview.filePath, state.activePreview.mode, state.activePreview.startSec || 0);
    });
    document.getElementById('btn-preview-jump')?.addEventListener('click', () => {
      if (!state.activePreview || state.activePreview.kind !== 'video') return;
      const startSec = Math.max(0, Number(document.getElementById('preview-video-start')?.value) || 0);
      state.activePreview.startSec = startSec;
      state.activePreview.mode = 'transcode';
      renderVideoStage(state.activePreview.filePath, 'transcode', startSec);
    });

    // Text / Code / Markdown Editor Pro Controls
    const editorArea = document.getElementById('text-editor-area');
    if (editorArea) {
      editorArea.addEventListener('input', updateEditorLineNumbers);
      editorArea.addEventListener('scroll', () => {
        const nums = document.getElementById('editor-line-numbers');
        if (nums) nums.scrollTop = editorArea.scrollTop;
      });
      editorArea.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = editorArea.selectionStart;
          const end = editorArea.selectionEnd;
          editorArea.value = `${editorArea.value.slice(0, start)}  ${editorArea.value.slice(end)}`;
          editorArea.selectionStart = editorArea.selectionEnd = start + 2;
          updateEditorLineNumbers();
        }
      });
    }
    document.getElementById('btn-editor-find-next')?.addEventListener('click', () => {
      const findInput = document.getElementById('editor-find-input');
      const term = findInput?.value || '';
      if (!editorArea || !term) return;
      const text = editorArea.value;
      const lowerText = text.toLowerCase();
      const lowerTerm = term.toLowerCase();
      const startFrom = editorArea.selectionEnd || 0;
      let idx = lowerText.indexOf(lowerTerm, startFrom);
      let wrapped = false;
      if (idx === -1 && startFrom > 0) {
        idx = lowerText.indexOf(lowerTerm, 0);
        wrapped = idx !== -1;
      }
      if (idx === -1) {
        setEditorStatus(`Keine Treffer für „${term}“`, 'err');
        return;
      }
      editorArea.focus();
      editorArea.setSelectionRange(idx, idx + term.length);
      const lineBefore = text.slice(0, idx).split('\n').length;
      setEditorStatus(`Treffer in Zeile ${lineBefore}${wrapped ? ' (von oben neu gesucht)' : ''}`, 'ok');
    });
    document.getElementById('btn-editor-validate')?.addEventListener('click', validateEditorContent);
    document.getElementById('btn-editor-md-toggle')?.addEventListener('click', () => {
      state.activeEditorMarkdownPreview = !state.activeEditorMarkdownPreview;
      const btn = document.getElementById('btn-editor-md-toggle');
      const codeWrap = document.getElementById('editor-code-wrap');
      const mdPreview = document.getElementById('editor-md-preview');
      if (state.activeEditorMarkdownPreview) {
        if (mdPreview && editorArea) mdPreview.innerHTML = renderSafeMarkdown(editorArea.value);
        codeWrap?.classList.add('hidden');
        mdPreview?.classList.remove('hidden');
        if (btn) btn.textContent = 'Quelltext bearbeiten';
      } else {
        mdPreview?.classList.add('hidden');
        codeWrap?.classList.remove('hidden');
        if (btn) btn.textContent = 'Markdown-Vorschau';
      }
    });

    // Text Editor Save
    document.getElementById('btn-editor-save').addEventListener('click', async () => {
      if (!state.activeEditorPath) return;
      const msg = document.getElementById('editor-save-msg');
      const ext = state.activeEditorExt;
      if ((ext === '.json' || ext === '.yml' || ext === '.yaml') && !validateEditorContent()) {
        msg.textContent = 'Syntaxfehler — nicht gespeichert';
        setTimeout(() => { msg.textContent = ''; }, 3000);
        return;
      }
      const content = document.getElementById('text-editor-area').value;
      const res = await fetch(`/api/files/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.activeEditorPath, content })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        msg.textContent = d.error || 'Fehler beim Speichern';
      } else {
        msg.textContent = 'Gespeichert!';
      }
      setTimeout(() => { msg.textContent = ''; }, 2500);
    });

    // App Store & Compose
    document.querySelectorAll('[data-appcat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.appCategory = btn.dataset.appcat;
        document.querySelectorAll('[data-appcat]').forEach((b) => b.classList.toggle('active', b === btn));
        renderAppCatalog();
      });
    });
    document.getElementById('appstore-search').addEventListener('input', renderAppCatalog);
    document.getElementById('btn-custom-container').addEventListener('click', () => openInstallModal(null));
    document.getElementById('btn-docker-new').addEventListener('click', () => openInstallModal(null));
    document.getElementById('btn-add-port-row').addEventListener('click', () => addPortRow());
    document.getElementById('btn-add-vol-row').addEventListener('click', () => addVolumeRow());
    document.getElementById('btn-add-env-row').addEventListener('click', () => addEnvRow());

    const openComposeModal = (stackName = '', yamlText = '', customHint = '') => {
      document.getElementById('compose-error').classList.add('hidden');
      document.getElementById('compose-stack-name').value = stackName;
      document.getElementById('compose-yaml').value = yamlText;
      const pConnected = Boolean(state.snapshot?.portainer?.connected);
      const hintEl = document.getElementById('compose-portainer-hint');
      const submitBtn = document.getElementById('btn-compose-submit');
      if (customHint) {
        hintEl.textContent = customHint;
      } else if (pConnected) {
        hintEl.textContent = 'Portainer API verbunden: Dieser Stack wird direkt als verwalteter Portainer-Stack angelegt (kein „Limited“-Status).';
      } else {
        hintEl.textContent = 'Tipp: Kopiere das YAML direkt in Portainer (Stacks → Add stack) oder verbinde dein Portainer API-Token unter Einstellungen.';
      }
      submitBtn.textContent = pConnected ? 'In Portainer deployen' : 'Lokal als Compose starten';
      openModal('modal-compose');
    };
    window.__openComposeModal = openComposeModal;

    const defaultComposeSample = 'services:\n  mein-dienst:\n    image: nginx:alpine\n    restart: unless-stopped\n    ports:\n      - "8089:80"\n';
    document.getElementById('btn-open-compose-modal').addEventListener('click', () => {
      openComposeModal('', defaultComposeSample);
    });
    document.getElementById('btn-portainer-new-stack').addEventListener('click', () => {
      openComposeModal('', defaultComposeSample);
    });

    document.getElementById('btn-compose-copy').addEventListener('click', async () => {
      const btn = document.getElementById('btn-compose-copy');
      const yaml = document.getElementById('compose-yaml').value;
      try {
        await navigator.clipboard.writeText(yaml);
        btn.textContent = 'In Zwischenablage kopiert!';
      } catch {
        document.getElementById('compose-yaml').select();
        document.execCommand('copy');
        btn.textContent = 'Kopiert!';
      }
      setTimeout(() => { btn.textContent = 'YAML für Portainer kopieren'; }, 2200);
    });

    document.getElementById('form-compose').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-compose-submit');
      const errEl = document.getElementById('compose-error');
      const prevLabel = btn.textContent;
      errEl.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Stelle Stack bereit…';
      try {
        const res = await fetch(`/api/compose/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('compose-stack-name').value.trim(),
            yaml: document.getElementById('compose-yaml').value
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Stack-Deployment fehlgeschlagen');
        closeModal('modal-compose');
        loadDeployedStacks();
        const snapRes = await fetch(`/api/snapshot`);
        if (snapRes.ok) handleSnapshot(await snapRes.json());
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    });

    const BIGBEAR_UPSTREAM_IMAGES = {
      jellyfin: 'lscr.io/linuxserver/jellyfin:latest',
      plex: 'lscr.io/linuxserver/plex:latest',
      immich: 'ghcr.io/immich-app/immich-server:release',
      photoprism: 'photoprism/photoprism:latest',
      nextcloud: 'nextcloud:stable-apache',
      filebrowser: 'filebrowser/filebrowser:latest',
      syncthing: 'lscr.io/linuxserver/syncthing:latest',
      duplicati: 'lscr.io/linuxserver/duplicati:latest',
      paperless: 'ghcr.io/paperless-ngx/paperless-ngx:latest',
      vaultwarden: 'vaultwarden/server:latest',
      adguard: 'adguard/adguardhome:latest',
      'nginx-proxy-manager': 'jc21/nginx-proxy-manager:latest',
      'uptime-kuma': 'louislam/uptime-kuma:1',
      'home-assistant': 'ghcr.io/home-assistant/home-assistant:stable',
      homeassistant: 'ghcr.io/home-assistant/home-assistant:stable',
      qbittorrent: 'lscr.io/linuxserver/qbittorrent:latest',
      portainer: 'portainer/portainer-ce:latest'
    };

    document.getElementById('btn-export-compose-yaml').addEventListener('click', () => {
      const name = (document.getElementById('inst-name').value.trim() || 'mein-dienst').replace(/[^a-zA-Z0-9_-]/g, '-');
      const rawImage = document.getElementById('inst-image').value.trim() || 'nginx:alpine';
      let finalImage = rawImage;
      let migrationHint = '';
      let yamlNote = '';

      if (/bigbeartechworld|big-bear/i.test(rawImage)) {
        const lower = `${rawImage} ${name}`.toLowerCase();
        const matchedKey = Object.keys(BIGBEAR_UPSTREAM_IMAGES).find((k) => lower.includes(k));
        if (matchedKey) {
          finalImage = BIGBEAR_UPSTREAM_IMAGES[matchedKey];
          yamlNote = `# BigBear-Image (${rawImage}) automatisch auf offizielles Original-Image umgestellt (Volume-Pfade prüfen!)`;
          migrationHint = `BigBearCasaOS-Image erkannt und auf offizielles Original-Image (${finalImage}) umgestellt. Bitte Volume-Pfade vor dem Start kurz prüfen.`;
        } else {
          yamlNote = `# HINWEIS: BigBearCasaOS-Image erkannt — bitte durch das offizielle Upstream-Image ersetzen`;
          migrationHint = `BigBearCasaOS-Image (${rawImage}) erkannt — bitte im YAML auf das offizielle Original-Image ändern, bevor du in Portainer deployst.`;
        }
      }

      const networkMode = document.getElementById('inst-network').value;
      const restartPolicy = document.getElementById('inst-restart').value || 'unless-stopped';
      const privileged = document.getElementById('inst-privileged').checked;
      const ports = Array.from(document.querySelectorAll('#inst-ports-list .dynamic-row-3'))
        .map((r) => ({
          host: r.querySelector('.port-host').value.trim(),
          cont: r.querySelector('.port-container').value.trim(),
          proto: r.querySelector('.port-proto').value
        }))
        .filter((p) => p.host && p.cont);
      const volumes = Array.from(document.querySelectorAll('#inst-volumes-list .dynamic-row'))
        .map((r) => ({
          host: r.querySelector('.vol-host').value.trim(),
          cont: r.querySelector('.vol-container').value.trim(),
          mode: r.dataset.volMode || ''
        }))
        .filter((v) => v.host && v.cont);
      const envs = Array.from(document.querySelectorAll('#inst-env-list .dynamic-row'))
        .map((r) => ({
          k: r.querySelector('.env-key').value.trim(),
          v: r.querySelector('.env-val').value
        }))
        .filter((e) => e.k && e.k !== 'PATH');
      const devices = document.getElementById('inst-devices').value
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);

      const lines = ['services:', `  ${name}:`];
      if (yamlNote) lines.push(`    ${yamlNote}`);
      lines.push(`    image: ${finalImage}`);
      lines.push(`    container_name: ${name}`);
      lines.push(`    restart: ${restartPolicy}`);
      if (networkMode === 'host') lines.push('    network_mode: host');
      if (privileged) lines.push('    privileged: true');
      if (ports.length > 0 && networkMode !== 'host') {
        lines.push('    ports:');
        ports.forEach((p) => lines.push(`      - "${p.host}:${p.cont}${p.proto && p.proto !== 'tcp' ? `/${p.proto}` : ''}"`));
      }
      if (volumes.length > 0) {
        lines.push('    volumes:');
        volumes.forEach((v) => lines.push(`      - ${v.host}:${v.cont}${v.mode ? `:${v.mode}` : ''}`));
      }
      if (envs.length > 0) {
        lines.push('    environment:');
        envs.forEach((e) => lines.push(`      - ${e.k}=${e.v}`));
      }
      if (devices.length > 0) {
        lines.push('    devices:');
        devices.forEach((d) => lines.push(`      - ${d}`));
      }

      closeModal('modal-install');
      if (window.__openComposeModal) {
        window.__openComposeModal(name, lines.join('\n') + '\n', migrationHint);
      }
    });

    // Install / Edit Container Submit
    document.getElementById('form-install-app').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('btn-install-submit');
      const errEl = document.getElementById('inst-error');
      const editCid = document.getElementById('inst-edit-cid').value;
      errEl.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = editCid ? 'Aktualisiere Container…' : 'Installiere & starte…';

      try {
        const ports = Array.from(document.querySelectorAll('#inst-ports-list .dynamic-row-3')).map((row) => ({
          hostPort: row.querySelector('.port-host').value.trim(),
          containerPort: row.querySelector('.port-container').value.trim(),
          protocol: row.querySelector('.port-proto').value
        }));
        const volumes = Array.from(document.querySelectorAll('#inst-volumes-list .dynamic-row')).map((row) => {
          const item = {
            hostPath: row.querySelector('.vol-host').value.trim(),
            containerPath: row.querySelector('.vol-container').value.trim()
          };
          if (row.dataset.volMode) item.mode = row.dataset.volMode;
          return item;
        });
        const env = Array.from(document.querySelectorAll('#inst-env-list .dynamic-row')).map((row) => ({
          key: row.querySelector('.env-key').value.trim(),
          value: row.querySelector('.env-val').value
        }));
        const devices = document.getElementById('inst-devices').value
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean);

        const payload = {
          name: document.getElementById('inst-name').value.trim(),
          displayName: state.activeInstallApp?.name || document.getElementById('inst-name').value.trim(),
          category: state.activeInstallApp?.category || 'Docker App',
          tagline: state.activeInstallApp?.tagline || '',
          image: document.getElementById('inst-image').value.trim(),
          networkMode: document.getElementById('inst-network').value,
          restartPolicy: document.getElementById('inst-restart').value,
          privileged: document.getElementById('inst-privileged').checked,
          devices,
          ports,
          volumes,
          env
        };

        const endpoint = editCid
          ? `/api/docker/${encodeURIComponent(editCid)}/recreate`
          : `/api/appstore/install`;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Vorgang fehlgeschlagen');

        closeModal('modal-install');
        const snapRes = await fetch(`/api/snapshot`);
        if (snapRes.ok) handleSnapshot(await snapRes.json());
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = editCid ? 'Speichern & Container neu erstellen' : 'Image laden & Container starten';
      }
    });

    // Terminal Keyboard Bridge
    const termScreen = document.getElementById('terminal-screen');
    termScreen.addEventListener('keydown', (e) => {
      if (!state.termSocket || state.termSocket.readyState !== WebSocket.OPEN) return;
      e.preventDefault();
      if (e.ctrlKey && e.key.toLowerCase() === 'c') state.termSocket.send('\x03');
      else if (e.ctrlKey && e.key.toLowerCase() === 'd') state.termSocket.send('\x04');
      else if (e.key === 'Enter') state.termSocket.send('\r');
      else if (e.key === 'Backspace') state.termSocket.send('\x7f');
      else if (e.key === 'Tab') state.termSocket.send('\t');
      else if (e.key === 'ArrowUp') state.termSocket.send('\x1b[A');
      else if (e.key === 'ArrowDown') state.termSocket.send('\x1b[B');
      else if (e.key.length === 1) state.termSocket.send(e.key);
    });
    document.getElementById('btn-terminal-clear').addEventListener('click', () => {
      termScreen.textContent = '';
      termScreen.focus();
    });

    // Disk Mount Modal
    document.getElementById('form-disk-mount').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('mount-error');
      errEl.classList.add('hidden');
      const devPath = document.getElementById('mount-dev-path').value;
      const mountPoint = document.getElementById('mount-target-path').value.trim();
      const persistFstab = document.getElementById('mount-persist-fstab').checked;
      const res = await fetch(`/api/storage/mount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devPath, mountPoint, persistFstab })
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error;
        errEl.classList.remove('hidden');
        return;
      }
      closeModal('modal-disk-mount');
      const snapRes = await fetch(`/api/snapshot`);
      if (snapRes.ok) handleSnapshot(await snapRes.json());
    });

    // SMB Shares
    document.getElementById('btn-add-smb-share').addEventListener('click', () => {
      if (!state.smbData) return;
      state.smbData.config.shares.push({
        id: `share-${Date.now()}`,
        name: 'Medien',
        path: getDefaultDiskMount('/mnt/daten'),
        readOnly: false
      });
      renderSmbPanel();
    });
    document.getElementById('btn-apply-smb').addEventListener('click', async () => {
      const btn = document.getElementById('btn-apply-smb');
      btn.disabled = true;
      btn.textContent = 'Wende an…';
      try {
        const shares = [];
        document.querySelectorAll('.smb-name-input').forEach((el, idx) => {
          const name = el.value.trim();
          const pathVal = document.querySelectorAll('.smb-path-input')[idx].value.trim();
          const ro = document.querySelectorAll('.smb-ro-input')[idx].checked;
          if (name && pathVal) shares.push({ name, path: pathVal, readOnly: ro });
        });
        const res = await fetch(`/api/smb/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('smb-username').value.trim(),
            password: document.getElementById('smb-password').value,
            shares
          })
        });
        const data = await res.json();
        if (!res.ok) alert(data.error || 'SMB-Konfiguration fehlgeschlagen');
        else await loadSmbStatus();
      } finally {
        btn.disabled = false;
        btn.textContent = 'Samba-Dienst anwenden';
      }
    });

    // Storage Analyzer Controls
    document.getElementById('btn-analyzer-scan').addEventListener('click', async () => {
      const checked = Array.from(document.querySelectorAll('.analyzer-root-cb:checked')).map((el) => el.value);
      const hasCheckboxes = document.querySelectorAll('.analyzer-root-cb').length > 0;
      if (hasCheckboxes && checked.length === 0) {
        alert('Bitte wähle mindestens einen Speicher-Pfad für die Analyse aus.');
        return;
      }
      const res = await fetch('/api/analyzer/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: checked })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || 'Analyse konnte nicht gestartet werden');
        return;
      }
      state.analyzerData = data;
      renderAnalyzerView();
      loadAnalyzerStatus();
    });
    document.querySelectorAll('[data-ana-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.analyzerTab = btn.dataset.anaTab;
        renderAnalyzerView();
      });
    });

    // Automation, Watchdog, Scheduler & Wake-on-LAN
    document.getElementById('wd-mode').addEventListener('change', () => {
      const selected = state.automationData?.watchdog?.containerNames || [];
      renderWatchdogContainerPicker(selected);
    });

    document.getElementById('form-watchdog').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById('wd-save-msg');
      const containerNames = Array.from(document.querySelectorAll('.wd-container-cb:checked')).map((el) => el.value);
      const payload = {
        enabled: document.getElementById('wd-enabled').checked,
        mode: document.getElementById('wd-mode').value,
        cooldownSeconds: Number(document.getElementById('wd-cooldown').value) || 180,
        restartUnhealthy: document.getElementById('wd-unhealthy').checked,
        restartExitedError: document.getElementById('wd-exited').checked,
        trashAutoCleanDays: Number(document.getElementById('wd-trash-days')?.value) || 0,
        containerNames
      };
      const res = await fetch('/api/automation/watchdog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        msgEl.textContent = `Fehler: ${data.error || 'Speichern fehlgeschlagen'}`;
        return;
      }
      state.automationData = data;
      renderAutomationView();
      msgEl.textContent = 'Watchdog gespeichert!';
      setTimeout(() => { msgEl.textContent = ''; }, 2500);
    });

    document.getElementById('form-schedule-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = [...(state.automationData?.schedules || [])];
      current.push({
        name: document.getElementById('sched-name').value.trim(),
        type: document.getElementById('sched-type').value,
        target: document.getElementById('sched-target').value.trim(),
        timeHHMM: document.getElementById('sched-time').value || '03:00',
        enabled: true
      });
      const res = await fetch('/api/automation/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules: current })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || 'Zeitplan konnte nicht gespeichert werden');
      state.automationData = data;
      document.getElementById('form-schedule-add').reset();
      document.getElementById('sched-time').value = '03:00';
      renderAutomationView();
    });

    document.getElementById('form-wol-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = [...(state.automationData?.wolDevices || [])];
      current.push({
        name: document.getElementById('wol-name').value.trim(),
        mac: document.getElementById('wol-mac').value.trim(),
        broadcastIp: document.getElementById('wol-broadcast').value.trim() || '255.255.255.255',
        port: Number(document.getElementById('wol-port').value) || 9
      });
      const res = await fetch('/api/wol/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: current })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || 'Gerät konnte nicht gespeichert werden');
      if (!state.automationData) state.automationData = { watchdog: {}, schedules: [], events: [], wolDevices: [] };
      state.automationData.wolDevices = data.devices || [];
      document.getElementById('form-wol-add').reset();
      document.getElementById('wol-broadcast').value = '255.255.255.255';
      document.getElementById('wol-port').value = '9';
      renderAutomationView();
    });

    document.getElementById('btn-refresh-automation').addEventListener('click', loadAutomationState);

    // Push Notifications
    document.getElementById('form-notifications')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msgEl = document.getElementById('notif-save-msg');
      const ntfyToken = document.getElementById('notif-ntfy-token').value.trim();
      const discordWebhookUrl = document.getElementById('notif-discord-url').value.trim();
      const tgBotToken = document.getElementById('notif-telegram-token').value.trim();
      const webhookSecret = document.getElementById('notif-webhook-secret').value.trim();

      const payload = {
        enabled: document.getElementById('notif-enabled').checked,
        cooldownMinutes: Number(document.getElementById('notif-cooldown').value) || 30,
        triggers: {
          smart: document.getElementById('notif-trig-smart').checked,
          diskFull: document.getElementById('notif-trig-diskfull').checked,
          cpuTemp: document.getElementById('notif-trig-cputemp').checked,
          diskTemp: document.getElementById('notif-trig-disktemp').checked,
          watchdog: document.getElementById('notif-trig-watchdog').checked
        },
        channels: {
          ntfy: {
            enabled: document.getElementById('notif-ntfy-enabled').checked,
            url: document.getElementById('notif-ntfy-url').value.trim() || 'https://ntfy.sh',
            topic: document.getElementById('notif-ntfy-topic').value.trim(),
            ...(ntfyToken ? { token: ntfyToken } : {})
          },
          discord: {
            enabled: document.getElementById('notif-discord-enabled').checked,
            ...(discordWebhookUrl ? { webhookUrl: discordWebhookUrl } : {})
          },
          telegram: {
            enabled: document.getElementById('notif-telegram-enabled').checked,
            chatId: document.getElementById('notif-telegram-chatid').value.trim(),
            ...(tgBotToken ? { botToken: tgBotToken } : {})
          },
          webhook: {
            enabled: document.getElementById('notif-webhook-enabled').checked,
            url: document.getElementById('notif-webhook-url').value.trim(),
            ...(webhookSecret ? { secret: webhookSecret } : {})
          }
        }
      };

      const res = await fetch('/api/notifications/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msgEl) msgEl.textContent = `Fehler: ${data.error || 'Speichern fehlgeschlagen'}`;
        return;
      }
      state.notificationsState = data;
      renderNotificationsPanel();
      if (msgEl) {
        msgEl.textContent = 'Benachrichtigungen gespeichert!';
        setTimeout(() => { msgEl.textContent = ''; }, 2500);
      }
    });

    document.getElementById('btn-notif-test')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-notif-test');
      const msgEl = document.getElementById('notif-save-msg');
      btn.disabled = true;
      if (msgEl) msgEl.textContent = 'Sende Test-Nachricht…';
      try {
        const res = await fetch('/api/notifications/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          if (msgEl) msgEl.textContent = `Hinweis: ${data.error || 'Versand fehlgeschlagen'}`;
        } else {
          if (msgEl) msgEl.textContent = 'Test-Nachricht erfolgreich versendet!';
        }
        await loadNotificationsState();
      } finally {
        btn.disabled = false;
        setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 4000);
      }
    });

    document.getElementById('btn-storage-snapshot')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-storage-snapshot');
      btn.disabled = true;
      try {
        const res = await fetch('/api/storage/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (res.ok) {
          renderStorageHistory(await res.json());
        }
      } finally {
        btn.disabled = false;
      }
    });

    // Docker Maintenance (Image Update Check & Safe Prune)
    document.getElementById('btn-docker-check-updates')?.addEventListener('click', () => {
      runDockerUpdateCheck({ openDetails: true });
    });

    document.getElementById('btn-docker-update-details')?.addEventListener('click', () => {
      openDockerUpdatesModal(false);
    });

    document.getElementById('btn-docker-update-all')?.addEventListener('click', () => {
      openDockerUpdatesModal(false);
      updateAllOutdatedContainers();
    });

    document.getElementById('btn-autoupdate-open-details')?.addEventListener('click', () => {
      openDockerUpdatesModal(false);
    });

    document.getElementById('btn-modal-updates-recheck')?.addEventListener('click', () => {
      runDockerUpdateCheck({ openDetails: true });
    });

    document.getElementById('btn-modal-updates-install-all')?.addEventListener('click', () => {
      updateAllOutdatedContainers();
    });

    document.querySelectorAll('[data-updates-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.dockerUpdatesFilter = btn.dataset.updatesFilter || 'all';
        document.querySelectorAll('[data-updates-filter]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        renderDockerUpdatesModal();
      });
    });

    document.getElementById('docker-updates-tbody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-modal-update-id]');
      if (!btn) return;
      updateSingleContainerWithProgress(btn.dataset.modalUpdateId, btn.dataset.modalUpdateName, btn);
    });

    const loadDockerUsageSummary = async () => {
      const sumEl = document.getElementById('prune-usage-summary');
      if (!sumEl) return;
      sumEl.textContent = 'Lade Docker-Speichernutzung…';
      try {
        const res = await fetch('/api/docker/disk-usage', { cache: 'no-store' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Nicht abrufbar');
        if (!d.available) {
          sumEl.textContent = 'Docker Engine auf diesem Host nicht verfügbar.';
          return;
        }
        sumEl.textContent =
          `Images: ${d.imagesCount} (${d.unusedImagesCount} ungenutzt, ${formatBytesDecimal(d.imagesReclaimableSize)} frei) · ` +
          `Build-Cache: ${d.buildCacheCount} (${formatBytesDecimal(d.buildCacheSize)}) · ` +
          `Volumes: ${d.volumesCount} (${d.danglingVolumesCount} ungenutzt, ${formatBytesDecimal(d.volumesReclaimableSize)}) · ` +
          `Gesamt einsparbar: ${formatBytesDecimal(d.totalReclaimableSize)}`;
      } catch (err) {
        sumEl.textContent = `Fehler: ${err.message}`;
      }
    };

    document.getElementById('btn-docker-open-prune')?.addEventListener('click', () => {
      const msgEl = document.getElementById('prune-msg');
      if (msgEl) msgEl.textContent = '';
      openModal('modal-docker-prune');
      loadDockerUsageSummary();
    });

    document.getElementById('btn-confirm-docker-prune')?.addEventListener('click', async () => {
      const images = document.getElementById('prune-opt-images')?.checked !== false;
      const buildCache = document.getElementById('prune-opt-build')?.checked !== false;
      const volumes = document.getElementById('prune-opt-volumes')?.checked === true;
      if (!images && !buildCache && !volumes) return;
      if (volumes && !confirm('WARNUNG: Ungenutzte anonyme Volumes werden endgültig entfernt. Fortfahren?')) return;

      const btn = document.getElementById('btn-confirm-docker-prune');
      const msgEl = document.getElementById('prune-msg');
      btn.disabled = true;
      btn.textContent = 'Bereinige…';
      try {
        const res = await fetch('/api/docker/prune', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images, buildCache, volumes })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (msgEl) msgEl.textContent = `Fehler: ${data.error || 'Bereinigung fehlgeschlagen'}`;
          return;
        }
        if (msgEl) {
          msgEl.textContent = `Bereinigung fertig: ${formatBytesDecimal(data.reclaimedBytes || 0)} freigegeben (${data.imagesDeleted || 0} Images, ${data.volumesDeleted || 0} Volumes).`;
        }
        await loadDockerUsageSummary();
        const snapRes = await fetch('/api/snapshot');
        if (snapRes.ok) handleSnapshot(await snapRes.json());
      } finally {
        btn.disabled = false;
        btn.textContent = 'Jetzt bereinigen';
      }
    });

    // Host & Network Monitor
    document.getElementById('btn-host-refresh')?.addEventListener('click', () => loadHostStatus(true));
    document.getElementById('form-ping-add')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('ping-name').value.trim();
      const host = document.getElementById('ping-host').value.trim();
      const portRaw = document.getElementById('ping-port').value.trim();
      const port = portRaw ? Number(portRaw) : null;
      if (!name || !host) return;
      const existing = (state.hostData?.pingTargets || []).map((t) => ({
        id: t.id,
        name: t.name,
        host: t.host,
        port: t.port || null
      }));
      existing.push({ id: `ping-${Date.now()}`, name, host, port });
      const res = await fetch('/api/host/ping-targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: existing })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || 'Ziel konnte nicht gespeichert werden');
        return;
      }
      state.hostData = data;
      document.getElementById('form-ping-add').reset();
      renderHostView();
    });

    // Modals close
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal(backdrop.id);
      });
    });

    // Delegated clicks & changes
    document.addEventListener('change', async (e) => {
      const cb = e.target.closest('.file-select-cb');
      if (cb) {
        if (cb.checked) state.selectedFiles.add(cb.dataset.filePath);
        else state.selectedFiles.delete(cb.dataset.filePath);
        updateBulkBar();
        return;
      }

      const trashCb = e.target.closest('.trash-select-cb');
      if (trashCb) {
        if (trashCb.checked) state.selectedTrashKeys.add(trashCb.dataset.trashKey);
        else state.selectedTrashKeys.delete(trashCb.dataset.trashKey);
        updateTrashBulkBar();
        return;
      }

      const rootCb = e.target.closest('.analyzer-root-cb');
      if (rootCb) {
        if (!state.analyzerSelectedRoots) state.analyzerSelectedRoots = new Set();
        if (rootCb.checked) state.analyzerSelectedRoots.add(rootCb.value);
        else state.analyzerSelectedRoots.delete(rootCb.value);
        return;
      }

      const widgetToggle = e.target.closest('[data-toggle-widget]');
      if (widgetToggle) {
        const wid = widgetToggle.dataset.toggleWidget;
        const next = state.overviewWidgets.map((w) => (w.id === wid ? { ...w, visible: widgetToggle.checked } : w));
        applyOverviewWidgets(next);
        try {
          await saveConfigPatch({ ui: { overviewWidgets: state.overviewWidgets } });
        } catch {
          // ignore
        }
        return;
      }

      const schedToggle = e.target.closest('[data-sched-toggle]');
      if (schedToggle && state.automationData) {
        const sid = schedToggle.dataset.schedToggle;
        const next = (state.automationData.schedules || []).map((s) => (s.id === sid ? { ...s, enabled: schedToggle.checked } : s));
        const res = await fetch('/api/automation/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedules: next })
        });
        if (res.ok) {
          state.automationData = await res.json();
          renderAutomationView();
        }
      }
    });

    document.addEventListener('click', async (e) => {
      const themePick = e.target.closest('[data-pick-theme]');
      if (themePick) {
        applyTheme(themePick.dataset.pickTheme, true);
        const msg = document.getElementById('theme-save-msg');
        if (msg) {
          msg.textContent = 'Design gespeichert!';
          setTimeout(() => { msg.textContent = ''; }, 2000);
        }
        return;
      }

      const accentPick = e.target.closest('[data-pick-accent]');
      if (accentPick) {
        applyAccent(accentPick.dataset.pickAccent, true);
        const msg = document.getElementById('theme-save-msg');
        if (msg) {
          msg.textContent = 'Akzentfarbe gespeichert!';
          setTimeout(() => { msg.textContent = ''; }, 2000);
        }
        return;
      }

      const moveWidgetBtn = e.target.closest('[data-move-widget]');
      if (moveWidgetBtn) {
        const wid = moveWidgetBtn.dataset.moveWidget;
        const dir = Number(moveWidgetBtn.dataset.dir);
        const idx = state.overviewWidgets.findIndex((w) => w.id === wid);
        const targetIdx = idx + dir;
        if (idx >= 0 && targetIdx >= 0 && targetIdx < state.overviewWidgets.length) {
          const next = [...state.overviewWidgets];
          [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
          applyOverviewWidgets(next);
          try {
            await saveConfigPatch({ ui: { overviewWidgets: state.overviewWidgets } });
          } catch {
            // ignore
          }
        }
        return;
      }

      const cmBrowseBtn = e.target.closest('[data-cm-browse]');
      if (cmBrowseBtn) {
        loadCopyMoveDirs(cmBrowseBtn.dataset.cmBrowse);
        return;
      }

      const moveSingleBtn = e.target.closest('[data-move-single]');
      if (moveSingleBtn) {
        openCopyMoveModal('move', [moveSingleBtn.dataset.moveSingle]);
        return;
      }

      const trashRestoreBtn = e.target.closest('[data-trash-restore]');
      if (trashRestoreBtn) {
        const res = await fetch('/api/files/trash/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashKeys: [trashRestoreBtn.dataset.trashRestore] })
        });
        if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Wiederherstellen fehlgeschlagen');
        await loadTrashView();
        refreshTrashBadge();
        return;
      }

      const trashDelBtn = e.target.closest('[data-trash-delete]');
      if (trashDelBtn) {
        if (!confirm(`"${trashDelBtn.dataset.trashName}" endgültig löschen? Dies kann nicht rückgängig gemacht werden.`)) return;
        const res = await fetch('/api/files/trash/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashKeys: [trashDelBtn.dataset.trashDelete] })
        });
        if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Endgültiges Löschen fehlgeschlagen');
        await loadTrashView();
        refreshTrashBadge();
        return;
      }

      const trashDupGroupBtn = e.target.closest('[data-trash-dup-group]');
      if (trashDupGroupBtn) {
        const idx = Number(trashDupGroupBtn.dataset.trashDupGroup);
        const group = state.analyzerData?.duplicateGroups?.[idx];
        if (!group || group.files.length < 2) return;
        const extraPaths = group.files.slice(1).map((f) => f.path);
        if (!confirm(`${extraPaths.length} doppelte Kopie(n) in den Papierkorb verschieben? ("${group.files[0].path}" bleibt erhalten)`)) return;
        const res = await fetch('/api/files/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: extraPaths })
        });
        if (!res.ok) {
          alert((await res.json().catch(() => ({}))).error || 'Verschieben fehlgeschlagen');
          return;
        }
        state.analyzerData.duplicateGroups.splice(idx, 1);
        renderAnalyzerView();
        refreshTrashBadge();
        return;
      }

      const trashSingleAnalyzerBtn = e.target.closest('[data-trash-single-path]');
      if (trashSingleAnalyzerBtn) {
        const targetPath = trashSingleAnalyzerBtn.dataset.trashSinglePath;
        const name = trashSingleAnalyzerBtn.dataset.trashName || targetPath;
        if (!confirm(`"${name}" in den Papierkorb verschieben?`)) return;
        const res = await fetch('/api/files/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [targetPath] })
        });
        if (!res.ok) {
          alert((await res.json().catch(() => ({}))).error || 'Verschieben fehlgeschlagen');
          return;
        }
        if (state.analyzerData) {
          state.analyzerData.largestFiles = (state.analyzerData.largestFiles || []).filter((f) => f.path !== targetPath);
          state.analyzerData.duplicateGroups = (state.analyzerData.duplicateGroups || [])
            .map((g) => ({ ...g, files: g.files.filter((f) => f.path !== targetPath) }))
            .filter((g) => g.files.length >= 2);
          renderAnalyzerView();
        }
        refreshTrashBadge();
        return;
      }

      const openAnalyzerDirBtn = e.target.closest('[data-open-analyzer-dir]');
      if (openAnalyzerDirBtn) {
        switchView('files');
        loadFilesDirectory(openAnalyzerDirBtn.dataset.openAnalyzerDir);
        return;
      }

      const schedRunBtn = e.target.closest('[data-sched-run]');
      if (schedRunBtn) {
        schedRunBtn.disabled = true;
        try {
          const res = await fetch(`/api/automation/schedules/${encodeURIComponent(schedRunBtn.dataset.schedRun)}/run`, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) alert(data.error || 'Ausführung fehlgeschlagen');
          else {
            state.automationData = data;
            renderAutomationView();
          }
        } finally {
          schedRunBtn.disabled = false;
        }
        return;
      }

      const schedDelBtn = e.target.closest('[data-sched-del]');
      if (schedDelBtn && state.automationData) {
        const sid = schedDelBtn.dataset.schedDel;
        const next = (state.automationData.schedules || []).filter((s) => s.id !== sid);
        const res = await fetch('/api/automation/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedules: next })
        });
        if (res.ok) {
          state.automationData = await res.json();
          renderAutomationView();
        }
        return;
      }

      const wolWakeBtn = e.target.closest('[data-wol-wake]');
      if (wolWakeBtn) {
        wolWakeBtn.disabled = true;
        try {
          const res = await fetch('/api/wol/wake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: wolWakeBtn.dataset.wolWake })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) alert(data.error || 'Wake-on-LAN fehlgeschlagen');
          else await loadAutomationState();
        } finally {
          wolWakeBtn.disabled = false;
        }
        return;
      }

      const wolDelBtn = e.target.closest('[data-wol-del]');
      if (wolDelBtn && state.automationData) {
        const did = wolDelBtn.dataset.wolDel;
        const next = (state.automationData.wolDevices || []).filter((d) => d.id !== did);
        const res = await fetch('/api/wol/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ devices: next })
        });
        if (res.ok) {
          const data = await res.json();
          state.automationData.wolDevices = data.devices || [];
          renderAutomationView();
        }
        return;
      }

      const alertGoto = e.target.closest('[data-alert-goto]');
      if (alertGoto) {
        closeModal('modal-alerts');
        switchView(alertGoto.dataset.alertGoto);
        return;
      }

      const openDirBtn = e.target.closest('[data-open-dir]');
      if (openDirBtn) {
        loadFilesDirectory(openDirBtn.dataset.openDir);
        return;
      }

      const previewBtn = e.target.closest('[data-preview-file]');
      if (previewBtn) {
        openMediaPreview(previewBtn.dataset.previewFile, previewBtn.dataset.previewKind, previewBtn.dataset.previewName);
        return;
      }

      const editTextBtn = e.target.closest('[data-edit-text]');
      if (editTextBtn) {
        openTextEditor(editTextBtn.dataset.editText);
        return;
      }

      const shareFileBtn = e.target.closest('[data-share-file]');
      if (shareFileBtn) {
        openShareModal(shareFileBtn.dataset.shareFile, shareFileBtn.dataset.fileName);
        return;
      }

      const copyShareLinkBtn = e.target.closest('[data-copy-share-link]');
      if (copyShareLinkBtn) {
        const url = copyShareLinkBtn.dataset.copyShareLink;
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          // ignore clipboard fallback in headless
        }
        const prev = copyShareLinkBtn.textContent;
        copyShareLinkBtn.textContent = 'Kopiert!';
        setTimeout(() => { copyShareLinkBtn.textContent = prev; }, 1600);
        return;
      }

      const revokeShareBtn = e.target.closest('[data-revoke-share]');
      if (revokeShareBtn) {
        const sid = revokeShareBtn.dataset.revokeShare;
        const res = await fetch(`/api/shares/${encodeURIComponent(sid)}`, { method: 'DELETE' });
        if (!res.ok) {
          alert((await res.json().catch(() => ({}))).error || 'Freigabe konnte nicht widerrufen werden');
          return;
        }
        await refreshSharesBadge();
        renderSharesListModal();
        return;
      }

      const delPingBtn = e.target.closest('[data-del-ping]');
      if (delPingBtn && state.hostData) {
        const pid = delPingBtn.dataset.delPing;
        const nextTargets = (state.hostData.pingTargets || [])
          .filter((t) => t.id !== pid)
          .map((t) => ({ id: t.id, name: t.name, host: t.host, port: t.port || null }));
        const res = await fetch('/api/host/ping-targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets: nextTargets })
        });
        if (res.ok) {
          state.hostData = await res.json();
          renderHostView();
        }
        return;
      }

      const extractBtn = e.target.closest('[data-extract-file]');
      if (extractBtn) {
        const res = await fetch(`/api/files/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: extractBtn.dataset.extractFile })
        });
        if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Entpacken fehlgeschlagen');
        else loadFilesDirectory(state.filesPath);
        return;
      }

      const renameBtn = e.target.closest('[data-rename-file]');
      if (renameBtn) {
        const oldName = renameBtn.dataset.fileName;
        const newName = prompt('Neuer Name:', oldName);
        if (!newName || newName.trim() === oldName) return;
        const res = await fetch(`/api/files/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: renameBtn.dataset.renameFile, newName: newName.trim() })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          alert(d.error || 'Umbenennen fehlgeschlagen');
          return;
        }
        loadFilesDirectory(state.filesPath);
        return;
      }

      const delFileBtn = e.target.closest('[data-delete-file]');
      if (delFileBtn) {
        if (!confirm(`"${delFileBtn.dataset.fileName}" in den Papierkorb verschieben?`)) return;
        const res = await fetch(`/api/files/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: delFileBtn.dataset.deleteFile })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          alert(d.error || 'Verschieben in den Papierkorb fehlgeschlagen');
          return;
        }
        loadFilesDirectory(state.filesPath);
        refreshTrashBadge();
        return;
      }

      const delSmbBtn = e.target.closest('[data-del-smb]');
      if (delSmbBtn && state.smbData) {
        state.smbData.config.shares.splice(Number(delSmbBtn.dataset.delSmb), 1);
        renderSmbPanel();
        return;
      }

      const mountBtn = e.target.closest('[data-mount-dev]');
      if (mountBtn) {
        document.getElementById('mount-error').classList.add('hidden');
        document.getElementById('mount-dev-path').value = mountBtn.dataset.mountDev;
        document.getElementById('mount-target-path').value = '/mnt/archiv';
        openModal('modal-disk-mount');
        return;
      }

      const formatBtn = e.target.closest('[data-format-dev]');
      if (formatBtn) {
        const dev = formatBtn.dataset.formatDev;
        const confirmDev = prompt(`ACHTUNG: Alle Daten auf ${dev} werden gelöscht!\nTippe "${dev}" zur Bestätigung ein:`);
        if (confirmDev !== dev) return;
        const res = await fetch(`/api/storage/format`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ devPath: dev, fsType: 'ext4', label: 'homeserver' })
        });
        const data = await res.json();
        if (!res.ok) alert(data.error);
        else alert(`${dev} erfolgreich als ext4 formatiert.`);
        return;
      }

      const unmountBtn = e.target.closest('[data-unmount-disk]');
      if (unmountBtn) {
        const mp = unmountBtn.dataset.unmountDisk;
        if (!confirm(`Laufwerk "${mp}" wirklich aushängen?`)) return;
        const res = await fetch(`/api/storage/unmount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mountPoint: mp })
        });
        if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Aushängen fehlgeschlagen');
        return;
      }

      const installBtn = e.target.closest('[data-install-app]');
      if (installBtn) {
        const app = state.appCatalog.find((a) => a.id === installBtn.dataset.installApp);
        if (app) openInstallModal(app);
        return;
      }

      const portainerStackBtn = e.target.closest('[data-portainer-stack-action]');
      if (portainerStackBtn) {
        const sid = portainerStackBtn.dataset.pstackId;
        const action = portainerStackBtn.dataset.portainerStackAction;
        portainerStackBtn.disabled = true;
        try {
          const res = await fetch(`/api/portainer/stacks/${encodeURIComponent(sid)}/${action}`, { method: 'POST' });
          if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Portainer-Aktion fehlgeschlagen');
          else {
            const snapRes = await fetch(`/api/snapshot`);
            if (snapRes.ok) handleSnapshot(await snapRes.json());
          }
        } finally {
          portainerStackBtn.disabled = false;
        }
        return;
      }

      const tplBtn = e.target.closest('[data-install-template]');
      if (tplBtn) {
        const tpl = state.composeTemplates.find((t) => t.id === tplBtn.dataset.installTemplate);
        if (tpl && window.__openComposeModal) {
          window.__openComposeModal(tpl.id.replace('-stack', ''), tpl.yaml);
        }
        return;
      }

      const editStackBtn = e.target.closest('[data-stack-edit]');
      if (editStackBtn) {
        const st = state.deployedStacks.find((s) => s.name === editStackBtn.dataset.stackEdit);
        if (st && window.__openComposeModal) {
          window.__openComposeModal(st.name, st.yaml);
        }
        return;
      }

      const editPortainerStackBtn = e.target.closest('[data-edit-portainer-stack]');
      if (editPortainerStackBtn) {
        const sid = editPortainerStackBtn.dataset.editPortainerStack;
        const sname = editPortainerStackBtn.dataset.pstackName || sid;
        editPortainerStackBtn.disabled = true;
        try {
          const res = await fetch(`/api/portainer/stacks/${encodeURIComponent(sid)}/yaml`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Stack-YAML konnte nicht geladen werden');
          if (window.__openComposeModal) {
            window.__openComposeModal(sname, data.yaml || '');
          }
        } catch (err) {
          alert(err.message);
        } finally {
          editPortainerStackBtn.disabled = false;
        }
        return;
      }

      const delSslBtn = e.target.closest('[data-del-ssl]');
      if (delSslBtn) {
        const sslId = delSslBtn.dataset.delSsl;
        const current = (state.hostData?.sslTargets || []).filter((t) => t.id !== sslId);
        const res = await fetch('/api/host/ssl-targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets: current })
        });
        if (res.ok) {
          const payload = await res.json();
          if (state.hostData) state.hostData.sslTargets = payload.targets || [];
          renderHostView();
        }
        return;
      }

      const stackActionBtn = e.target.closest('[data-stack-action]');
      if (stackActionBtn) {
        const stack = stackActionBtn.dataset.stack;
        const action = stackActionBtn.dataset.stackAction;
        if (action === 'delete' && !confirm(`Compose Stack "${stack}" stoppen und löschen?`)) return;
        stackActionBtn.disabled = true;
        try {
          const res = await fetch(`/api/compose/${encodeURIComponent(stack)}/${action}`, { method: 'POST' });
          if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Compose-Aktion fehlgeschlagen');
          await loadDeployedStacks();
        } finally {
          stackActionBtn.disabled = false;
        }
        return;
      }

      const editDiskBtn = e.target.closest('[data-edit-disk]');
      if (editDiskBtn && state.snapshot) {
        const disk = state.snapshot.storage.disks.find((d) => d.id === editDiskBtn.dataset.editDisk);
        if (disk) {
          document.getElementById('disk-edit-id').value = disk.id;
          document.getElementById('disk-edit-label').value = disk.label;
          document.getElementById('disk-edit-meta').textContent = `${disk.device} · ${disk.mountpoint} (${formatBytesDecimal(disk.totalBytes)})`;
          openModal('modal-disk');
        }
        return;
      }

      const logBtn = e.target.closest('[data-view-logs]');
      if (logBtn) {
        loadContainerLogs(logBtn.dataset.viewLogs, logBtn.dataset.containerName);
        return;
      }

      const termBtn = e.target.closest('[data-open-term]');
      if (termBtn) {
        openTerminalModal(termBtn.dataset.openTerm, termBtn.dataset.cname);
        return;
      }

      const editContainerBtn = e.target.closest('[data-edit-container]');
      if (editContainerBtn) {
        const cid = editContainerBtn.dataset.editContainer;
        const res = await fetch(`/api/docker/${encodeURIComponent(cid)}/inspect`);
        const cfg = await res.json();
        if (!res.ok) alert(cfg.error);
        else openInstallModal(null, cfg);
        return;
      }

      const openUpdateDetailsBtn = e.target.closest('[data-open-update-details]');
      if (openUpdateDetailsBtn) {
        const filter = openUpdateDetailsBtn.dataset.openUpdateDetails || 'all';
        state.dockerUpdatesFilter = filter;
        document.querySelectorAll('[data-updates-filter]').forEach((b) => {
          b.classList.toggle('active', b.dataset.updatesFilter === filter);
        });
        openDockerUpdatesModal(false);
        return;
      }

      const updateContainerBtn = e.target.closest('[data-update-container]');
      if (updateContainerBtn) {
        const cid = updateContainerBtn.dataset.updateContainer;
        const cname = updateContainerBtn.dataset.cname;
        if (!confirm(`Neuestes Image für "${cname}" ziehen und Container neu starten?`)) return;
        await updateSingleContainerWithProgress(cid, cname, updateContainerBtn);
        return;
      }

      const dockerActionBtn = e.target.closest('[data-docker-action]');
      if (dockerActionBtn) {
        const cid = dockerActionBtn.dataset.cid;
        const action = dockerActionBtn.dataset.dockerAction;
        if (action === 'remove' && !confirm(`Container "${dockerActionBtn.dataset.cname || cid}" wirklich löschen?`)) return;
        dockerActionBtn.disabled = true;
        try {
          const res = await fetch(`/api/docker/${encodeURIComponent(cid)}/${action}`, { method: 'POST' });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            alert(d.error || 'Container-Aktion fehlgeschlagen');
          } else {
            const snapRes = await fetch(`/api/snapshot`);
            if (snapRes.ok) handleSnapshot(await snapRes.json());
          }
        } finally {
          dockerActionBtn.disabled = false;
        }
        return;
      }

      const editSvcBtn = e.target.closest('[data-edit-service]');
      if (editSvcBtn && state.snapshot) {
        const svc = (state.snapshot.config.services || []).find((s) => s.id === editSvcBtn.dataset.editService);
        if (svc) {
          document.getElementById('modal-service-title').textContent = 'Dienst bearbeiten';
          document.getElementById('svc-edit-id').value = svc.id;
          document.getElementById('svc-name').value = svc.name || '';
          document.getElementById('svc-category').value = svc.category || '';
          document.getElementById('svc-url').value = svc.url || '';
          document.getElementById('svc-match').value = svc.containerMatch || '';
          document.getElementById('svc-desc').value = svc.description || '';
          openModal('modal-service');
        }
        return;
      }

      const delSvcBtn = e.target.closest('[data-delete-service]');
      if (delSvcBtn && state.snapshot) {
        const id = delSvcBtn.dataset.deleteService;
        try {
          await saveConfigPatch({ services: (state.snapshot.config.services || []).filter((s) => s.id !== id) });
        } catch (err) {
          alert(err.message);
        }
      }
    });

    document.getElementById('btn-refresh-logs').addEventListener('click', () => {
      if (state.activeLogContainerId) loadContainerLogs(state.activeLogContainerId);
    });

    const openNewServiceModal = () => {
      document.getElementById('modal-service-title').textContent = 'Neuen Dienst hinzufügen';
      document.getElementById('form-service').reset();
      document.getElementById('svc-edit-id').value = '';
      openModal('modal-service');
    };
    document.getElementById('btn-add-service').addEventListener('click', openNewServiceModal);
    document.getElementById('btn-settings-add-service').addEventListener('click', openNewServiceModal);

    document.getElementById('form-disk-label').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('disk-edit-id').value;
      const label = document.getElementById('disk-edit-label').value.trim();
      if (!id || !label) return;
      try {
        await saveConfigPatch({ diskLabels: { [id]: label } });
        closeModal('modal-disk');
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('form-service').addEventListener('submit', async (e) => {
      e.preventDefault();
      const existingId = document.getElementById('svc-edit-id').value;
      const currentServices = [...(state.snapshot?.config?.services || [])];
      const item = {
        id: existingId || `svc-${Date.now()}`,
        name: document.getElementById('svc-name').value.trim(),
        category: document.getElementById('svc-category').value.trim(),
        url: document.getElementById('svc-url').value.trim(),
        containerMatch: document.getElementById('svc-match').value.trim(),
        description: document.getElementById('svc-desc').value.trim()
      };
      const idx = currentServices.findIndex((s) => s.id === item.id);
      if (idx >= 0) currentServices[idx] = item;
      else currentServices.push(item);

      try {
        await saveConfigPatch({ services: currentServices });
        closeModal('modal-service');
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btn-goto-portainer-settings').addEventListener('click', () => {
      switchView('settings');
      setTimeout(() => document.getElementById('input-portainer-url')?.focus(), 80);
    });

    document.getElementById('btn-test-portainer').addEventListener('click', async () => {
      const msg = document.getElementById('portainer-save-msg');
      const btn = document.getElementById('btn-test-portainer');
      btn.disabled = true;
      msg.textContent = 'Prüfe Verbindung…';
      try {
        const res = await fetch(`/api/portainer/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: document.getElementById('input-portainer-url').value.trim(),
            apiKey: document.getElementById('input-portainer-token').value.trim()
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Test fehlgeschlagen');
        msg.textContent = `OK (${data.endpointName}, ${data.stackCount} Stacks)`;
      } catch (err) {
        msg.textContent = `Fehler: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('form-portainer-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      const portainerUrl = document.getElementById('input-portainer-url').value.trim();
      const portainerApiKey = document.getElementById('input-portainer-token').value.trim();
      const msg = document.getElementById('portainer-save-msg');
      const patch = { portainerUrl };
      if (portainerApiKey) patch.portainerApiKey = portainerApiKey;
      try {
        await saveConfigPatch(patch);
        document.getElementById('input-portainer-token').value = '';
        msg.textContent = 'Portainer gespeichert!';
        const snapRes = await fetch(`/api/snapshot`);
        if (snapRes.ok) handleSnapshot(await snapRes.json());
      } catch (err) {
        msg.textContent = `Fehler: ${err.message}`;
      }
      setTimeout(() => { msg.textContent = ''; }, 3000);
    });

    document.getElementById('form-general-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      const serverName = document.getElementById('input-server-name').value.trim();
      const mediaPaths = document.getElementById('input-media-paths').value.split(',').map((p) => p.trim()).filter(Boolean);
      const power = {
        idleWatts: Number(document.getElementById('input-power-idle')?.value) || 18,
        maxWatts: Number(document.getElementById('input-power-max')?.value) || 65,
        kwhPriceEur: Number(document.getElementById('input-power-kwh')?.value) || 0.32
      };
      const msg = document.getElementById('settings-save-msg');
      try {
        await saveConfigPatch({ serverName, mediaPaths, power });
        msg.textContent = 'Gespeichert!';
      } catch (err) {
        msg.textContent = `Fehler: ${err.message}`;
      }
      setTimeout(() => { msg.textContent = ''; }, 2500);
    });

    document.getElementById('form-password-settings')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('pw-current').value;
      const newPassword = document.getElementById('pw-new').value;
      const confirmPassword = document.getElementById('pw-confirm').value;
      const msg = document.getElementById('pw-save-msg');
      if (newPassword !== confirmPassword) {
        msg.textContent = 'Fehler: Neue Passwörter stimmen nicht überein.';
        return;
      }
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        msg.textContent = `Fehler: ${data.error || 'Passwort konnte nicht gespeichert werden'}`;
        return;
      }
      document.getElementById('form-password-settings').reset();
      msg.textContent = data.message || 'Passwort gespeichert!';
      setTimeout(() => { msg.textContent = ''; }, 3500);
      loadAuthMeta();
      loadAuditLog();
    });

    document.getElementById('btn-refresh-audit')?.addEventListener('click', loadAuditLog);

    // 2FA / TOTP Setup & Disable
    document.getElementById('btn-totp-setup')?.addEventListener('click', async () => {
      const res = await fetch('/api/auth/totp/setup', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || '2FA-Setup fehlgeschlagen');
        return;
      }
      document.getElementById('totp-secret-text').textContent = data.secret || '—';
      const qrBox = document.getElementById('totp-qr-box');
      if (qrBox && window.renderQrSvg && data.otpauthUrl) {
        qrBox.innerHTML = window.renderQrSvg(data.otpauthUrl, 160);
      }
      document.getElementById('totp-enable-error')?.classList.add('hidden');
      document.getElementById('totp-backup-codes-box')?.classList.add('hidden');
      document.getElementById('totp-setup-panel')?.classList.remove('hidden');
    });

    document.getElementById('form-totp-enable')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = document.getElementById('totp-verify-code').value.trim();
      const errEl = document.getElementById('totp-enable-error');
      errEl?.classList.add('hidden');
      const res = await fetch('/api/auth/totp/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = data.error || 'Ungültiger Code';
          errEl.classList.remove('hidden');
        }
        return;
      }
      document.getElementById('form-totp-enable').reset();
      document.getElementById('totp-setup-panel')?.classList.add('hidden');
      const bcList = document.getElementById('totp-backup-codes-list');
      if (bcList && Array.isArray(data.backupCodes)) {
        bcList.innerHTML = data.backupCodes.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join('');
        document.getElementById('totp-backup-codes-box')?.classList.remove('hidden');
      }
      loadAuthMeta();
      loadAuditLog();
    });

    document.getElementById('form-totp-disable')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('totp-disable-pw').value;
      const msg = document.getElementById('totp-disable-msg');
      const res = await fetch('/api/auth/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msg) msg.textContent = `Fehler: ${data.error || 'Deaktivierung fehlgeschlagen'}`;
        return;
      }
      document.getElementById('form-totp-disable').reset();
      document.getElementById('totp-backup-codes-box')?.classList.add('hidden');
      if (msg) msg.textContent = '2FA deaktiviert.';
      setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
      loadAuthMeta();
      loadAuditLog();
    });

    // SSL Checker
    document.getElementById('form-ssl-add')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('ssl-name').value.trim();
      const host = document.getElementById('ssl-host').value.trim();
      const port = Number(document.getElementById('ssl-port').value) || 443;
      const current = [...(state.hostData?.sslTargets || []), { id: `ssl-${Date.now()}`, name, host, port }];
      const res = await fetch('/api/host/ssl-targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: current })
      });
      if (res.ok) {
        const data = await res.json();
        if (state.hostData) state.hostData.sslTargets = data.targets || [];
        document.getElementById('form-ssl-add').reset();
        document.getElementById('ssl-port').value = '443';
        renderHostView();
      }
    });

    document.getElementById('btn-ssl-check-now')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-ssl-check-now');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Prüfe…';
      }
      startGlobalProgress();
      setInlineProgress('host-load-progress', { active: true, label: 'Prüfe SSL-Zertifikate…' });
      try {
        const res = await fetch('/api/host/ssl-check', { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          if (state.hostData) state.hostData.sslTargets = data.targets || [];
          renderHostView();
        }
      } finally {
        setInlineProgress('host-load-progress', { active: false });
        endGlobalProgress();
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Jetzt prüfen';
        }
      }
    });

    // Docker Auto-Update (Per-Container Policy & Schedule)
    document.getElementById('docker-full-tbody')?.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-autoupdate-policy]');
      if (!sel) return;
      const name = sel.dataset.autoupdatePolicy;
      const policy = sel.value;
      const res = await fetch('/api/docker/autoupdate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policies: { [name]: policy } })
      });
      if (res.ok) {
        state.autoUpdateConfig = await res.json();
      }
    });

    document.getElementById('form-autoupdate')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const enabled = document.getElementById('autoupdate-enabled').checked;
      const timeHHMM = document.getElementById('autoupdate-time').value || '03:00';
      const msg = document.getElementById('autoupdate-save-msg');
      const res = await fetch('/api/docker/autoupdate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, timeHHMM })
      });
      if (res.ok) {
        state.autoUpdateConfig = await res.json();
        renderAutomationView();
        if (msg) msg.textContent = 'Gespeichert!';
        setTimeout(() => { if (msg) msg.textContent = ''; }, 2500);
      }
    });

    document.getElementById('btn-autoupdate-run-now')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-autoupdate-run-now');
      const msg = document.getElementById('autoupdate-save-msg');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Läuft…';
      }
      if (msg) msg.textContent = 'Prüfe Images & führe Auto-Updates aus…';
      startGlobalProgress();
      setInlineProgress('autoupdate-progress', { active: true, label: 'Prüfe Registries & aktualisiere markierte Container…' });
      try {
        const res = await fetch('/api/docker/autoupdate/run', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (msg) msg.textContent = `Fertig: ${data.updated?.length || 0} aktualisiert, ${data.notified?.length || 0} Updates gefunden.`;
        await loadAutomationState();
      } finally {
        setInlineProgress('autoupdate-progress', { active: false });
        endGlobalProgress();
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Jetzt prüfen & updaten';
        }
      }
    });

    document.getElementById('form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('login-password').value;
      const totpCode = document.getElementById('login-totp')?.value.trim() || '';
      const errEl = document.getElementById('login-error');
      errEl.classList.add('hidden');
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, totpCode })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (d.totpRequired) {
          document.getElementById('login-totp-group')?.classList.remove('hidden');
          document.getElementById('login-totp')?.focus();
        }
        errEl.textContent = d.error || 'Falsches Passwort.';
        errEl.classList.remove('hidden');
        return;
      }
      document.getElementById('auth-overlay').classList.add('hidden');
      loadAuthMeta();
      connectStream();
    });

    document.getElementById('btn-logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
      if (state.watchdogTimer) {
        clearInterval(state.watchdogTimer);
        state.watchdogTimer = null;
      }
      stopPollingFallback();
      document.getElementById('auth-overlay').classList.remove('hidden');
    });

    window.addEventListener('resize', drawTelemetryChart);

    document.getElementById('btn-quick-speedtest')?.addEventListener('click', () => {
      switchView('host');
      activateSubTab('host', 'network');
      requestAnimationFrame(() => {
        document.getElementById('host-speedtest-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    document.getElementById('health-score-pills')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-health-goto]');
      if (!btn) return;
      const view = btn.dataset.healthGoto;
      if (view) switchView(view);
      if (btn.dataset.healthSubtab) {
        activateSubTab(view, btn.dataset.healthSubtab);
      }
    });

    document.getElementById('btn-speedtest-run')?.addEventListener('click', runLanSpeedtest);
    renderSpeedtestHistory();
  }

  // ==================== ANIMATED HEALTH SCORE & LAN SPEEDTEST ====================
  function renderHealthScore(data) {
    const card = document.getElementById('overview-health-card');
    if (!card || !data?.system) return;

    let score = 100;
    const pills = [];
    const sys = data.system;
    const cpuPct = Number(sys.cpu?.usagePercent ?? 0);
    const cpuTemp = sys.temperatures?.cpuCelsius;
    const ramPct = Number(sys.memory?.usedPercent ?? 0);
    const disks = Array.isArray(data.storage?.disks) ? data.storage.disks : [];
    const containers = Array.isArray(data.docker?.containers) ? data.docker.containers : [];

    if (cpuPct >= 90) {
      score -= 18;
      pills.push({ label: `CPU hoch (${cpuPct.toFixed(0)}%)`, level: 'crit', goto: 'host', subtab: 'live' });
    } else if (cpuPct >= 75) {
      score -= 8;
      pills.push({ label: `CPU ${cpuPct.toFixed(0)}%`, level: 'warn', goto: 'host', subtab: 'live' });
    } else {
      pills.push({ label: `CPU ${cpuPct.toFixed(0)}%`, level: 'ok', goto: 'host', subtab: 'live' });
    }

    if (typeof cpuTemp === 'number' && Number.isFinite(cpuTemp)) {
      if (cpuTemp >= 85) {
        score -= 20;
        pills.push({ label: `Temp ${cpuTemp.toFixed(0)} °C`, level: 'crit', goto: 'host', subtab: 'live' });
      } else if (cpuTemp >= 72) {
        score -= 8;
        pills.push({ label: `Temp ${cpuTemp.toFixed(0)} °C`, level: 'warn', goto: 'host', subtab: 'live' });
      }
    }

    if (ramPct >= 92) {
      score -= 18;
      pills.push({ label: `RAM kritisch (${ramPct.toFixed(0)}%)`, level: 'crit', goto: 'host', subtab: 'live' });
    } else if (ramPct >= 80) {
      score -= 8;
      pills.push({ label: `RAM ${ramPct.toFixed(0)}%`, level: 'warn', goto: 'host', subtab: 'live' });
    } else {
      pills.push({ label: `RAM ${ramPct.toFixed(0)}%`, level: 'ok', goto: 'host', subtab: 'live' });
    }

    const smartFails = disks.filter((d) => d.smartHealth && /fail|bad|crit/i.test(String(d.smartHealth))).length;
    const maxDiskPct = disks.reduce((m, d) => Math.max(m, Number(d.usedPercent ?? 0)), 0);
    if (smartFails > 0) {
      score -= 30;
      pills.push({ label: `${smartFails} SMART-Fehler`, level: 'crit', goto: 'storage' });
    } else if (maxDiskPct >= 92) {
      score -= 15;
      pills.push({ label: `Speicher voll (${maxDiskPct.toFixed(0)}%)`, level: 'crit', goto: 'storage' });
    } else if (maxDiskPct >= 82) {
      score -= 6;
      pills.push({ label: `Speicher ${maxDiskPct.toFixed(0)}%`, level: 'warn', goto: 'storage' });
    } else {
      pills.push({ label: `Speicher OK`, level: 'ok', goto: 'storage' });
    }

    const unhealthy = containers.filter((c) => c.health === 'unhealthy' || c.oomKilled).length;
    const running = containers.filter((c) => c.state === 'running').length;
    if (unhealthy > 0) {
      score -= Math.min(25, unhealthy * 12);
      pills.push({ label: `${unhealthy} Container auffällig`, level: 'crit', goto: 'docker', subtab: 'oom' });
    } else if (containers.length > 0) {
      pills.push({ label: `${running}/${containers.length} Container aktiv`, level: 'ok', goto: 'docker', subtab: 'containers' });
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const level = score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'crit';
    card.classList.remove('health-ok', 'health-warn', 'health-crit');
    card.classList.add(`health-${level}`);

    const ring = document.getElementById('health-ring-progress');
    if (ring) {
      const circumference = 226.2;
      ring.style.strokeDashoffset = String((circumference * (1 - score / 100)).toFixed(2));
    }
    const valEl = document.getElementById('health-score-val');
    if (valEl) valEl.textContent = String(score);

    const titleEl = document.getElementById('health-score-title');
    const badgeEl = document.getElementById('health-score-badge');
    if (titleEl) {
      titleEl.textContent =
        level === 'ok'
          ? 'Homeserver läuft optimal'
          : level === 'warn'
            ? 'Erhöhte Auslastung erkannt'
            : 'Handlungsbedarf beim Homeserver';
    }
    if (badgeEl) {
      badgeEl.textContent = level === 'ok' ? 'Optimal' : level === 'warn' ? 'Achtung' : 'Kritisch';
    }

    const pillsEl = document.getElementById('health-score-pills');
    if (pillsEl) {
      pillsEl.innerHTML = pills
        .map(
          (p) =>
            `<button type="button" class="health-pill pill-${p.level}" data-health-goto="${escapeHtml(p.goto)}"${
              p.subtab ? ` data-health-subtab="${escapeHtml(p.subtab)}"` : ''
            }>${escapeHtml(p.label)}</button>`
        )
        .join('');
    }
  }

  function setSpeedtestGauge(mbps, maxMbps = 1000) {
    const arc = document.getElementById('speedtest-arc-fill');
    const valEl = document.getElementById('speedtest-live-mbps');
    const safeMbps = Math.max(0, Number(mbps) || 0);
    if (valEl) {
      valEl.textContent = safeMbps >= 100 ? Math.round(safeMbps).toString() : safeMbps.toFixed(1);
    }
    if (arc) {
      const arcLen = 270.2;
      const ratio = Math.min(1, Math.log10(1 + (safeMbps / maxMbps) * 9));
      arc.style.strokeDashoffset = String((arcLen * (1 - ratio)).toFixed(2));
    }
  }

  function renderSpeedtestHistory() {
    const box = document.getElementById('speedtest-history');
    if (!box) return;
    let items = [];
    try {
      items = JSON.parse(localStorage.getItem('hs_speedtest_history') || '[]');
    } catch {
      items = [];
    }
    if (!Array.isArray(items) || items.length === 0) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = items
      .slice(0, 4)
      .map(
        (it) =>
          `<span class="io-pill mono">${escapeHtml(it.time)} · ↓ ${Number(it.dlMbps).toFixed(0)} / ↑ ${Number(it.ulMbps).toFixed(0)} Mbit/s · ${Number(it.pingMs).toFixed(1)} ms</span>`
      )
      .join('');
  }

  let globalProgressDepth = 0;
  function startGlobalProgress(percent = null) {
    globalProgressDepth += 1;
    const track = document.getElementById('global-progress-track');
    const fill = document.getElementById('global-progress-fill');
    if (!track || !fill) return;
    track.classList.remove('hidden');
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      fill.classList.remove('indeterminate');
      fill.style.width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
    } else {
      fill.classList.add('indeterminate');
      fill.style.width = '';
    }
  }

  function setGlobalProgress(percent) {
    const track = document.getElementById('global-progress-track');
    const fill = document.getElementById('global-progress-fill');
    if (!track || !fill) return;
    track.classList.remove('hidden');
    fill.classList.remove('indeterminate');
    fill.style.width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  }

  function endGlobalProgress() {
    globalProgressDepth = Math.max(0, globalProgressDepth - 1);
    if (globalProgressDepth > 0) return;
    const track = document.getElementById('global-progress-track');
    const fill = document.getElementById('global-progress-fill');
    if (!track || !fill) return;
    fill.classList.remove('indeterminate');
    fill.style.width = '100%';
    setTimeout(() => {
      if (globalProgressDepth === 0) {
        track.classList.add('hidden');
        fill.style.width = '0%';
      }
    }, 220);
  }

  function setInlineProgress(prefix, { active, percent = null, label = null } = {}) {
    const wrap = document.getElementById(`${prefix}-wrap`);
    const fill = document.getElementById(`${prefix}-fill`);
    const pctEl = document.getElementById(`${prefix}-pct`);
    const labelEl = document.getElementById(`${prefix}-label`);
    if (!wrap) return;
    if (!active) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    if (label !== null && labelEl) labelEl.textContent = label;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      if (fill) {
        fill.classList.remove('progress-indeterminate');
        fill.style.width = `${clamped}%`;
      }
      if (pctEl) pctEl.textContent = `${clamped}%`;
    } else {
      if (fill) {
        fill.classList.add('progress-indeterminate');
        fill.style.width = '45%';
      }
      if (pctEl) pctEl.textContent = 'Aktiv';
    }
  }

  function shortDigest(digest) {
    if (!digest) return '—';
    const clean = String(digest).replace(/^sha256:/i, '');
    return `sha256:${clean.slice(0, 12)}`;
  }

  function updateDockerMaintenanceBar(data) {
    const bar = document.getElementById('docker-maintenance-bar');
    const msg = document.getElementById('docker-maintenance-msg');
    const detailsBtn = document.getElementById('btn-docker-update-details');
    const allBtn = document.getElementById('btn-docker-update-all');
    if (!bar || !msg || !data) return;
    const avail = Number(data.updatesAvailable || 0);
    const checked = Number(data.checkedImages || 0);
    bar.classList.remove('hidden');
    msg.textContent = `Registry-Prüfung abgeschlossen: ${checked} Images geprüft · ${avail} Update(s) verfügbar.`;
    detailsBtn?.classList.remove('hidden');
    if (allBtn) {
      allBtn.classList.toggle('hidden', avail === 0);
      allBtn.textContent = `Alle updaten (${avail})`;
    }
  }

  function renderDockerUpdatesModal() {
    const data = state.dockerUpdatesData;
    const tbody = document.getElementById('docker-updates-tbody');
    const summaryEl = document.getElementById('docker-updates-summary');
    const installAllBtn = document.getElementById('btn-modal-updates-install-all');
    if (!tbody) return;

    const results = Array.isArray(data?.results) ? data.results : [];
    const availList = results.filter((r) => r.updateAvailable);
    const errList = results.filter((r) => r.error);
    const okList = results.filter((r) => !r.updateAvailable && !r.error && r.checked !== false);

    if (summaryEl) {
      const ts = data?.checkedAt ? ` · Stand: ${formatTimeShort(data.checkedAt)}` : '';
      summaryEl.textContent = `${results.length} Container · ${availList.length} Update(s) verfügbar · ${okList.length} aktuell · ${errList.length} Fehler${ts}`;
    }

    if (installAllBtn) {
      installAllBtn.classList.toggle('hidden', availList.length === 0);
      installAllBtn.textContent = `Alle Updates installieren (${availList.length})`;
    }

    const filter = state.dockerUpdatesFilter || 'all';
    const filtered = results.filter((r) => {
      if (filter === 'available') return Boolean(r.updateAvailable);
      if (filter === 'uptodate') return !r.updateAvailable && !r.error;
      if (filter === 'error') return Boolean(r.error);
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted-text">${
        results.length === 0
          ? 'Noch keine Update-Prüfung durchgeführt. Klicke auf „Neu prüfen“.'
          : 'Keine Container für diesen Filter.'
      }</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((r) => {
        let statusTag = `<span class="tag tag-ok">Aktuell</span>`;
        if (r.updatedNow) {
          statusTag = `<span class="tag tag-ok">Aktualisiert ✓</span>`;
        } else if (r.updateAvailable) {
          statusTag = `<span class="tag tag-warn">Update verfügbar</span>`;
        } else if (r.error) {
          statusTag = `<span class="tag tag-crit">Fehler</span>`;
        } else if (r.checked === false) {
          statusTag = `<span class="tag">Nicht geprüft</span>`;
        }

        const digestHtml = r.error
          ? `<div class="digest-compare"><span class="form-error" style="font-size:11px;">${escapeHtml(r.error)}</span></div>`
          : `<div class="digest-compare mono">
              <span class="digest-chip" title="${escapeHtml(r.localDigest || '')}">Lokal: ${escapeHtml(shortDigest(r.localDigest))}</span>
              ${
                r.remoteDigest
                  ? `<span class="digest-chip ${r.updateAvailable ? 'digest-new' : ''}" title="${escapeHtml(r.remoteDigest)}">Registry: ${escapeHtml(shortDigest(r.remoteDigest))}</span>`
                  : ''
              }
            </div>`;

        const actionHtml = r.updateAvailable
          ? `<button type="button" class="btn-primary btn-xs" data-modal-update-id="${escapeHtml(r.id)}" data-modal-update-name="${escapeHtml(r.name)}">Jetzt updaten</button>`
          : `<button type="button" class="btn-secondary btn-xs" data-modal-update-id="${escapeHtml(r.id)}" data-modal-update-name="${escapeHtml(r.name)}">Re-Pull</button>`;

        return `
          <tr>
            <td>
              <strong>${escapeHtml(r.name)}</strong>
              <div class="muted-text mono" style="font-size:11px;">${escapeHtml(r.state || '—')} · ${escapeHtml(r.id)}</div>
            </td>
            <td>
              <div class="mono" style="font-size:12px;word-break:break-all;">${escapeHtml(r.image)}</div>
              ${digestHtml}
            </td>
            <td>${statusTag}</td>
            <td class="num">${actionHtml}</td>
          </tr>
        `;
      })
      .join('');
  }

  async function openDockerUpdatesModal(autoCheckIfEmpty = false) {
    openModal('modal-docker-updates');
    if (!state.dockerUpdatesData) {
      startGlobalProgress();
      setInlineProgress('docker-updates-progress', { active: true, label: 'Lade gespeicherte Update-Daten…' });
      try {
        const res = await fetch('/api/docker/updates', { cache: 'no-store' });
        if (res.ok) {
          state.dockerUpdatesData = await res.json();
          if (state.dockerUpdatesData.checkedImages > 0) {
            updateDockerMaintenanceBar(state.dockerUpdatesData);
          }
        }
      } finally {
        setInlineProgress('docker-updates-progress', { active: false });
        endGlobalProgress();
      }
    }
    renderDockerUpdatesModal();
    if (autoCheckIfEmpty && (!state.dockerUpdatesData || state.dockerUpdatesData.checkedImages === 0)) {
      await runDockerUpdateCheck({ openDetails: true });
    }
  }

  async function runDockerUpdateCheck({ openDetails = true } = {}) {
    const btn = document.getElementById('btn-docker-check-updates');
    const recheckBtn = document.getElementById('btn-modal-updates-recheck');
    const bar = document.getElementById('docker-maintenance-bar');
    const msg = document.getElementById('docker-maintenance-msg');
    if (openDetails) openModal('modal-docker-updates');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Prüfe…';
    }
    if (recheckBtn) recheckBtn.disabled = true;
    if (bar && msg) {
      bar.classList.remove('hidden');
      msg.textContent = 'Prüfe Container-Images in den Registries…';
    }
    startGlobalProgress();
    setInlineProgress('docker-maintenance-progress', { active: true, label: 'Vergleiche lokale Image-Digests mit Docker Hub / GHCR…' });
    setInlineProgress('docker-updates-progress', { active: true, label: 'Prüfe alle Container-Images in den Registries…' });
    try {
      const res = await fetch('/api/docker/check-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msg) msg.textContent = `Fehler: ${data.error || 'Update-Prüfung fehlgeschlagen'}`;
        alert(data.error || 'Update-Prüfung fehlgeschlagen');
        return;
      }
      state.dockerUpdatesData = data;
      updateDockerMaintenanceBar(data);
      renderDockerUpdatesModal();
      const snapRes = await fetch('/api/snapshot');
      if (snapRes.ok) handleSnapshot(await snapRes.json());
    } finally {
      setInlineProgress('docker-maintenance-progress', { active: false });
      setInlineProgress('docker-updates-progress', { active: false });
      endGlobalProgress();
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Updates prüfen';
      }
      if (recheckBtn) recheckBtn.disabled = false;
    }
  }

  async function updateSingleContainerWithProgress(cid, cname, triggerBtn = null) {
    const origText = triggerBtn?.textContent || 'Update';
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = 'Lädt…';
    }
    const bar = document.getElementById('docker-maintenance-bar');
    const msg = document.getElementById('docker-maintenance-msg');
    if (bar && msg) {
      bar.classList.remove('hidden');
      msg.textContent = `Aktualisiere Container „${cname || cid}“…`;
    }
    startGlobalProgress();
    setInlineProgress('docker-maintenance-progress', { active: true, label: `Ziehe neues Image & starte „${cname || cid}“ neu…` });
    setInlineProgress('docker-updates-progress', { active: true, label: `Aktualisiere „${cname || cid}“ (Image Pull & Recreate)…` });
    try {
      const res = await fetch(`/api/docker/${encodeURIComponent(cid)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (msg) msg.textContent = `Update für „${cname || cid}“ fehlgeschlagen: ${d.error || 'Fehler'}`;
        alert(d.error || 'Container-Update fehlgeschlagen');
        return false;
      }
      if (state.dockerUpdatesData?.results) {
        const entry = state.dockerUpdatesData.results.find((r) => r.id === cid || r.name === cname);
        if (entry) {
          entry.updateAvailable = false;
          entry.updatedNow = true;
          entry.error = null;
          if (entry.remoteDigest) entry.localDigest = entry.remoteDigest;
        }
        state.dockerUpdatesData.updatesAvailable = state.dockerUpdatesData.results.filter((r) => r.updateAvailable).length;
        updateDockerMaintenanceBar(state.dockerUpdatesData);
        renderDockerUpdatesModal();
      }
      if (msg) msg.textContent = `Container „${cname || cid}“ erfolgreich aktualisiert.`;
      const snapRes = await fetch('/api/snapshot');
      if (snapRes.ok) handleSnapshot(await snapRes.json());
      return true;
    } finally {
      setInlineProgress('docker-maintenance-progress', { active: false });
      setInlineProgress('docker-updates-progress', { active: false });
      endGlobalProgress();
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = origText;
      }
    }
  }

  async function updateAllOutdatedContainers() {
    const results = state.dockerUpdatesData?.results || [];
    const targets = results.filter((r) => r.updateAvailable);
    if (targets.length === 0) return;
    if (!confirm(`${targets.length} Container jetzt nacheinander aktualisieren?`)) return;

    const btnModal = document.getElementById('btn-modal-updates-install-all');
    const btnBar = document.getElementById('btn-docker-update-all');
    if (btnModal) btnModal.disabled = true;
    if (btnBar) btnBar.disabled = true;

    let doneCount = 0;
    let failedCount = 0;
    startGlobalProgress(5);
    try {
      for (const item of targets) {
        const pct = Math.round((doneCount / targets.length) * 100);
        setGlobalProgress(Math.max(5, pct));
        const label = `Aktualisiere (${doneCount + 1}/${targets.length}): ${item.name}…`;
        setInlineProgress('docker-updates-progress', { active: true, percent: pct, label });
        setInlineProgress('docker-maintenance-progress', { active: true, percent: pct, label });

        const res = await fetch(`/api/docker/${encodeURIComponent(item.id)}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
          item.updateAvailable = false;
          item.updatedNow = true;
          item.error = null;
          if (item.remoteDigest) item.localDigest = item.remoteDigest;
        } else {
          failedCount += 1;
          item.error = d.error || 'Update fehlgeschlagen';
        }
        doneCount += 1;
        const nextPct = Math.round((doneCount / targets.length) * 100);
        setGlobalProgress(nextPct);
        setInlineProgress('docker-updates-progress', { active: true, percent: nextPct, label: `${doneCount}/${targets.length} verarbeitet…` });
        setInlineProgress('docker-maintenance-progress', { active: true, percent: nextPct, label: `${doneCount}/${targets.length} verarbeitet…` });
        state.dockerUpdatesData.updatesAvailable = results.filter((r) => r.updateAvailable).length;
        renderDockerUpdatesModal();
      }
      updateDockerMaintenanceBar(state.dockerUpdatesData);
      const msg = document.getElementById('docker-maintenance-msg');
      if (msg) {
        msg.textContent = `Batch-Update abgeschlossen: ${doneCount - failedCount} aktualisiert${failedCount > 0 ? `, ${failedCount} fehlgeschlagen` : ''}.`;
      }
      const snapRes = await fetch('/api/snapshot');
      if (snapRes.ok) handleSnapshot(await snapRes.json());
    } finally {
      setTimeout(() => {
        setInlineProgress('docker-updates-progress', { active: false });
        setInlineProgress('docker-maintenance-progress', { active: false });
      }, 600);
      endGlobalProgress();
      if (btnModal) btnModal.disabled = false;
      if (btnBar) btnBar.disabled = false;
    }
  }

  let speedtestRunning = false;
  async function runLanSpeedtest() {
    if (speedtestRunning) return;
    speedtestRunning = true;
    const btn = document.getElementById('btn-speedtest-run');
    const statusEl = document.getElementById('speedtest-status');
    const phaseEl = document.getElementById('speedtest-phase');
    const sizeMb = Math.min(32, Math.max(8, Number(document.getElementById('speedtest-size')?.value) || 16));

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Messung läuft…';
    }
    startGlobalProgress(5);
    setInlineProgress('speedtest-progress', { active: true, percent: 5, label: 'Phase 1/3: Messe Latenz & Jitter…' });

    try {
      // Phase 1: Ping & Jitter
      if (phaseEl) phaseEl.textContent = 'Ping';
      if (statusEl) statusEl.textContent = 'Messe Latenz & Jitter zum NAS…';
      setSpeedtestGauge(0);

      const rtts = [];
      for (let i = 0; i < 5; i += 1) {
        const t0 = performance.now();
        await fetch(`/api/net/ping?_=${Date.now()}_${i}`, { cache: 'no-store' });
        rtts.push(performance.now() - t0);
        const pct = 5 + Math.round(((i + 1) / 5) * 15);
        setGlobalProgress(pct);
        setInlineProgress('speedtest-progress', { active: true, percent: pct, label: `Phase 1/3: Ping (${i + 1}/5)…` });
      }
      const avgPing = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      const jitter = rtts.reduce((a, b) => a + Math.abs(b - avgPing), 0) / rtts.length;
      const pingEl = document.getElementById('speedtest-ping-val');
      const jitterEl = document.getElementById('speedtest-jitter-val');
      if (pingEl) pingEl.textContent = `${avgPing.toFixed(1)} ms`;
      if (jitterEl) jitterEl.textContent = `Jitter: ${jitter.toFixed(1)} ms`;

      // Phase 2: Download (streaming)
      if (phaseEl) phaseEl.textContent = 'Download';
      if (statusEl) statusEl.textContent = `Lade ${sizeMb} MB vom NAS…`;
      const expectedBytes = sizeMb * 1024 * 1024;
      const dlStart = performance.now();
      const dlRes = await fetch(`/api/net/download?mb=${sizeMb}&_=${Date.now()}`, { cache: 'no-store' });
      let dlBytes = 0;
      if (dlRes.body && dlRes.body.getReader) {
        const reader = dlRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          dlBytes += value.byteLength;
          const sec = Math.max(0.02, (performance.now() - dlStart) / 1000);
          setSpeedtestGauge((dlBytes * 8) / sec / 1e6);
          const pct = 20 + Math.round(Math.min(1, dlBytes / expectedBytes) * 40);
          setGlobalProgress(pct);
          setInlineProgress('speedtest-progress', { active: true, percent: pct, label: `Phase 2/3: Download (${(dlBytes / 1048576).toFixed(1)} / ${sizeMb} MB)…` });
        }
      } else {
        const buf = await dlRes.arrayBuffer();
        dlBytes = buf.byteLength;
      }
      const dlSec = Math.max(0.01, (performance.now() - dlStart) / 1000);
      const dlMbps = (dlBytes * 8) / dlSec / 1e6;
      const dlMBs = dlBytes / dlSec / (1024 * 1024);
      setSpeedtestGauge(dlMbps);
      document.getElementById('speedtest-dl-val').textContent = `${dlMbps.toFixed(1)} Mbit/s`;
      document.getElementById('speedtest-dl-mbs').textContent = `${dlMBs.toFixed(1)} MB/s`;

      // Phase 3: Upload (with live XHR upload progress!)
      if (phaseEl) phaseEl.textContent = 'Upload';
      if (statusEl) statusEl.textContent = `Sende ${sizeMb} MB zum NAS…`;
      setInlineProgress('speedtest-progress', { active: true, percent: 60, label: `Phase 3/3: Upload (0 / ${sizeMb} MB)…` });
      const payload = new Uint8Array(expectedBytes);
      const ulStart = performance.now();
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/net/upload');
        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          const sec = Math.max(0.02, (performance.now() - ulStart) / 1000);
          setSpeedtestGauge((ev.loaded * 8) / sec / 1e6);
          const pct = 60 + Math.round((ev.loaded / ev.total) * 40);
          setGlobalProgress(pct);
          setInlineProgress('speedtest-progress', { active: true, percent: pct, label: `Phase 3/3: Upload (${(ev.loaded / 1048576).toFixed(1)} / ${sizeMb} MB)…` });
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
        xhr.onerror = () => reject(new Error('Netzwerkfehler beim Upload'));
        xhr.send(payload);
      });
      const ulSec = Math.max(0.01, (performance.now() - ulStart) / 1000);
      const ulMbps = (payload.byteLength * 8) / ulSec / 1e6;
      const ulMBs = payload.byteLength / ulSec / (1024 * 1024);
      setSpeedtestGauge(ulMbps);
      setGlobalProgress(100);
      setInlineProgress('speedtest-progress', { active: true, percent: 100, label: 'Messung abgeschlossen!' });
      document.getElementById('speedtest-ul-val').textContent = `${ulMbps.toFixed(1)} Mbit/s`;
      document.getElementById('speedtest-ul-mbs').textContent = `${ulMBs.toFixed(1)} MB/s`;

      if (phaseEl) phaseEl.textContent = 'Fertig';
      if (statusEl) {
        statusEl.textContent = `Abgeschlossen (${sizeMb} MB) · ↓ ${dlMbps.toFixed(0)} Mbit/s · ↑ ${ulMbps.toFixed(0)} Mbit/s · Ping ${avgPing.toFixed(1)} ms`;
      }

      try {
        const prev = JSON.parse(localStorage.getItem('hs_speedtest_history') || '[]');
        const next = [
          {
            time: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            dlMbps,
            ulMbps,
            pingMs: avgPing
          },
          ...(Array.isArray(prev) ? prev : [])
        ].slice(0, 6);
        localStorage.setItem('hs_speedtest_history', JSON.stringify(next));
      } catch {}
      renderSpeedtestHistory();
    } catch (err) {
      if (phaseEl) phaseEl.textContent = 'Fehler';
      if (statusEl) statusEl.textContent = `Speedtest fehlgeschlagen: ${err.message}`;
    } finally {
      speedtestRunning = false;
      setTimeout(() => setInlineProgress('speedtest-progress', { active: false }), 900);
      endGlobalProgress();
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Speedtest starten';
      }
    }
  }

  // ==================== BOOT ====================
  async function init() {
    initTheme();
    initPwa();
    initSubTabs();
    initMobileNav();
    bindEvents();
    localStorage.removeItem('hs_mode');
    const urlView = new URLSearchParams(window.location.search).get('view');
    if (urlView && VIEW_TITLES[urlView]) {
      switchView(urlView);
    }
    const ok = await checkAuthAndStart();
    if (ok) connectStream();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
