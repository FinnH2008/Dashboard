(() => {
  'use strict';

  const MAX_HISTORY = 60;
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
    docker: 'Docker-Container',
    portainer: 'Portainer & Compose Stacks',
    appstore: 'Homeserver App Store',
    analyzer: 'Speicher-Analyse & Duplikate',
    automation: 'Automation, Watchdog & Wake-on-LAN',
    settings: 'System- & Design-Einstellungen'
  };
  const THEMES = ['studio-dark', 'studio-light', 'oled', 'slate', 'indigo'];
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
    dockerFilter: 'all',
    snapshot: null,
    history: [],
    eventSource: null,
    pollTimer: null,
    watchdogTimer: null,
    lastSnapshotAt: 0,
    transport: 'connecting', // 'connecting' | 'sse' | 'polling'
    activeLogContainerId: null,
    uiSyncedFromServer: false,
    overviewWidgets: DEFAULT_OVERVIEW_WIDGETS.map((w) => ({ ...w })),
    // Files
    filesPath: '/',
    filesViewMode: 'list', // 'list' | 'grid'
    filesListing: null,
    selectedFiles: new Set(),
    activeEditorPath: null,
    filesTrashMode: false,
    trashListing: null,
    selectedTrashKeys: new Set(),
    copyMoveSources: [],
    copyMoveBrowserPath: '/',
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

  function applyTheme(rawTheme, persistServer = false) {
    const theme = normalizeThemeName(rawTheme);
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hs_theme', theme);

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

  // ==================== NAVIGATION & MODALS ====================
  function switchView(viewName) {
    state.activeView = viewName;
    const titleEl = document.getElementById('active-view-title');
    if (titleEl) titleEl.textContent = VIEW_TITLES[viewName] || 'Systemübersicht';
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });
    if (viewName === 'overview') {
      requestAnimationFrame(() => {
        drawTelemetryChart();
        drawMediaDonut();
      });
    } else if (viewName === 'files') {
      if (state.filesTrashMode) loadTrashView();
      else loadFilesDirectory(state.filesPath);
      refreshTrashBadge();
    } else if (viewName === 'smb') {
      loadSmbStatus();
    } else if (viewName === 'portainer') {
      loadDeployedStacks();
    } else if (viewName === 'appstore') {
      loadAppCatalog();
    } else if (viewName === 'analyzer') {
      loadAnalyzerStatus();
    } else if (viewName === 'automation') {
      loadAutomationState();
    }
  }

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
    if (id === 'modal-preview') {
      document.getElementById('media-preview-stage').innerHTML = '';
    }
    if (id === 'modal-terminal' && state.termSocket) {
      state.termSocket.close();
      state.termSocket = null;
    }
  }

  // ==================== STREAMING & SNAPSHOTS ====================
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

    // Instant initial snapshot so UI never sits at zeroes waiting for SSE handshake
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

    const pointNow = {
      ts: Date.now(),
      cpu: Number(data.system?.cpu?.usagePercent) || 0,
      ram: Number(data.system?.memory?.usedPercent) || 0,
      netRxMB: (Number(data.system?.network?.rxBytesPerSec) || 0) / (1024 * 1024),
      netTxMB: (Number(data.system?.network?.txBytesPerSec) || 0) / (1024 * 1024),
      diskReadMB: (Number(data.storage?.totals?.readBytesPerSec) || 0) / (1024 * 1024),
      diskWriteMB: (Number(data.storage?.totals?.writeBytesPerSec) || 0) / (1024 * 1024)
    };

    state.history.push(pointNow);
    if (state.history.length > MAX_HISTORY) state.history.shift();

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

  function renderGlobalSearchResults() {
    const q = (document.getElementById('global-search-input').value || '').toLowerCase().trim();
    const results = [];
    const data = state.snapshot;

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

    const navTargets = [
      { label: 'Übersicht & Cockpit', view: 'overview' },
      { label: 'Dateimanager & Papierkorb', view: 'files' },
      { label: 'Festplatten & Blockgeräte', view: 'storage' },
      { label: 'Freigaben (SMB / Samba)', view: 'smb' },
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
    results.slice(0, 12).forEach((r) => {
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
    const maxVal = Math.max(1, ...slice.map((p) => p.netRxMB + p.netTxMB));
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
    const pad = { top: 12, right: 12, bottom: 22, left: 42 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    const gridColor = getCssVar('--grid-line');
    const textColor = getCssVar('--text-muted');
    const blue = getCssVar('--accent-blue');
    const emerald = getCssVar('--accent-emerald');
    const amber = getCssVar('--accent-amber');

    let seriesA = [];
    let seriesB = [];
    let labelA = '';
    let labelB = '';
    let colorA = blue;
    let colorB = emerald;
    let unit = '%';
    let maxY = 100;

    if (state.chartMode === 'compute') {
      seriesA = state.history.map((p) => p.cpu);
      seriesB = state.history.map((p) => p.ram);
      labelA = 'CPU-Auslastung';
      labelB = 'RAM-Belegung';
      colorA = blue;
      colorB = emerald;
      unit = '%';
      maxY = 100;
    } else if (state.chartMode === 'network') {
      seriesA = state.history.map((p) => p.netRxMB);
      seriesB = state.history.map((p) => p.netTxMB);
      labelA = 'Empfangen (↓)';
      labelB = 'Senden (↑)';
      colorA = blue;
      colorB = amber;
      unit = 'MB/s';
      maxY = Math.max(10, Math.ceil(Math.max(...seriesA, ...seriesB, 5) * 1.25));
    } else {
      seriesA = state.history.map((p) => p.diskReadMB);
      seriesB = state.history.map((p) => p.diskWriteMB);
      labelA = 'Festplatten Lesen';
      labelB = 'Festplatten Schreiben';
      colorA = emerald;
      colorB = amber;
      unit = 'MB/s';
      maxY = Math.max(10, Math.ceil(Math.max(...seriesA, ...seriesB, 5) * 1.25));
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

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('-60s', pad.left, h - 16);
    ctx.textAlign = 'right';
    ctx.fillText(`Jetzt (${unit})`, w - pad.right, h - 16);

    function drawSeries(values, color, fillAlpha) {
      if (values.length < 2) return;
      const stepX = plotW / (MAX_HISTORY - 1);
      const startIndex = MAX_HISTORY - values.length;

      let lastX = pad.left;
      let lastY = pad.top + plotH;

      ctx.beginPath();
      values.forEach((v, idx) => {
        const x = pad.left + (startIndex + idx) * stepX;
        const clamped = Math.max(0, Math.min(maxY, v));
        const y = pad.top + plotH - (clamped / maxY) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        lastX = x;
        lastY = y;
      });

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.85;
      ctx.lineJoin = 'round';
      ctx.stroke();

      const firstX = pad.left + startIndex * stepX;
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
    const fmt = (v) => (unit === '%' ? `${v.toFixed(1)}%` : `${v.toFixed(1)} MB/s`);

    document.getElementById('telemetry-legend').innerHTML = `
      <span class="legend-item"><span class="legend-swatch" style="background:${colorA}"></span>${escapeHtml(labelA)}: <strong class="mono">${fmt(lastA)}</strong></span>
      <span class="legend-item"><span class="legend-swatch" style="background:${colorB}"></span>${escapeHtml(labelB)}: <strong class="mono">${fmt(lastB)}</strong></span>
    `;
  }

  function renderMediaOverview(data) {
    const media = data.media;
    const subtitle = document.getElementById('media-summary-subtitle');
    if (!media.configured) {
      subtitle.textContent = 'Keine Medien-Ordner konfiguriert (Einstellungen → Speicherpfade)';
    } else if (media.scanning && (!media.totalFiles || media.totalFiles === 0)) {
      subtitle.textContent = `Scanne ${media.scannedPaths.length} Medien-Ordner im Hintergrund…`;
    } else {
      subtitle.textContent = `${media.scannedPaths.length} Ordner gescannt${media.truncated ? ' (Teil-Scan)' : ''}${media.scanning ? ' · aktualisiere…' : ''}`;
    }

    document.getElementById('donut-total-size').textContent = formatBytesDecimal(media.totalBytes);
    document.getElementById('donut-total-files').textContent = `${formatNumber(media.totalFiles)} Dateien`;

    document.getElementById('overview-media-categories').innerHTML = media.categories
      .map((cat) => {
        const color = CATEGORY_COLORS[cat.id] || CATEGORY_COLORS.other;
        return `
          <div class="media-cat-row">
            <span class="media-cat-dot" style="background:${color}"></span>
            <div class="media-cat-info">
              <div class="media-cat-name">${escapeHtml(cat.label)}</div>
              <div class="media-cat-count mono">${formatNumber(cat.count)} Dateien · ${cat.percent.toFixed(1)}%</div>
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
            ${unmountBtn ? `<div style="display:flex;justify-content:flex-end;">${unmountBtn}</div>` : ''}
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
    overviewSubtitle.textContent = summaryText;
    fullSubtitle.textContent = `${summaryText}${docker.allowControl ? ' · Portainer & Vollsteuerung aktiv' : ' · Nur-Lese-Modus'}`;

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
        return `
          <tr>
            <td>
              <div class="container-name">
                ${escapeHtml(c.name)}
                ${c.stackName ? `<span class="tag" style="margin-left:5px;font-size:10px;">Stack: ${escapeHtml(c.stackName)}</span>` : ''}
              </div>
              <div class="container-sub mono">${escapeHtml(c.statusText)}</div>
            </td>
            <td class="mono docker-img-cell" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</td>
            <td>${renderStateBadge(c)}</td>
            <td class="num mono">${c.state === 'running' ? `${c.cpuPercent.toFixed(1)}%` : '—'}</td>
            <td class="num mono">${c.state === 'running' ? formatBytesBinary(c.memoryBytes) : '—'}</td>
            <td>${renderPortBadges(c.ports)}</td>
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
  }

  // ==================== FILES MANAGER & TRASH ====================
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

  async function loadFilesDirectory(targetPath) {
    state.filesTrashMode = false;
    state.filesPath = targetPath || '/';
    state.selectedFiles.clear();
    updateBulkBar();
    document.getElementById('btn-files-trash')?.classList.remove('active');
    document.getElementById('files-trash-bar')?.classList.add('hidden');
    document.getElementById('files-trash-container')?.classList.add('hidden');
    document.getElementById('files-header-actions')?.classList.remove('hidden');

    try {
      const res = await fetch(`/api/files/list?path=${encodeURIComponent(state.filesPath)}`);
      if (!res.ok) throw new Error('Ordner konnte nicht geladen werden');
      state.filesListing = await res.json();
      renderFilesView();
    } catch (err) {
      document.getElementById('files-tbody').innerHTML = `<tr><td colspan="6" class="form-error">${escapeHtml(err.message)}</td></tr>`;
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
      case 'text': return 'Text / Config';
      case 'archive': return 'Archiv / Backup';
      case 'document': return 'Dokument';
      default: return 'Datei';
    }
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

    const crumbsEl = document.getElementById('files-breadcrumbs');
    if (listing.currentPath === '/') {
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

    const canWrite = listing.allowWrite && listing.currentPath !== '/';
    document.getElementById('btn-files-mkdir').disabled = !canWrite;
    document.getElementById('btn-files-upload').disabled = !canWrite;

    const search = (document.getElementById('files-search').value || '').toLowerCase();
    const filtered = (listing.items || []).filter((i) => !search || i.name.toLowerCase().includes(search));

    const listContainer = document.getElementById('files-list-container');
    const gridContainer = document.getElementById('files-grid-container');
    listContainer.classList.toggle('hidden', state.filesViewMode !== 'list');
    gridContainer.classList.toggle('hidden', state.filesViewMode !== 'grid');

    const tbody = document.getElementById('files-tbody');
    const rows = [];
    if (listing.parentPath !== null) {
      const dropParentAttr = listing.parentPath !== '/' ? `data-drop-dir="${escapeHtml(listing.parentPath)}"` : '';
      rows.push(`<tr ${dropParentAttr}><td></td><td colspan="5"><button class="file-entry-btn mono" data-open-dir="${escapeHtml(listing.parentPath)}">.. (Ebene nach oben)</button></td></tr>`);
    }

    if (filtered.length === 0) {
      rows.push(`<tr><td colspan="6" class="muted-text">Dieser Ordner ist leer.</td></tr>`);
    } else {
      filtered.forEach((item) => {
        const isPreviewable = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio';
        const isText = item.kind === 'text';
        const isArchive = item.kind === 'archive' && (item.name.endsWith('.zip') || item.name.endsWith('.tar.gz') || item.name.endsWith('.tgz') || item.name.endsWith('.tar'));
        const modStr = item.modifiedAt ? new Date(item.modifiedAt).toLocaleString('de-DE') : '—';
        const dlUrl = item.isDirectory
          ? `/api/files/zip?path=${encodeURIComponent(item.path)}`
          : `/api/files/raw?path=${encodeURIComponent(item.path)}&download=1`;
        const checked = state.selectedFiles.has(item.path) ? 'checked' : '';

        const actionBtns = item.isDirectory
          ? `<button class="btn-secondary btn-sm" data-open-dir="${escapeHtml(item.path)}">Öffnen</button>
             <a class="btn-secondary btn-sm" href="${escapeHtml(dlUrl)}" download style="text-decoration:none;">ZIP laden</a>`
          : `${isPreviewable ? `<button class="btn-secondary btn-sm" data-preview-file="${escapeHtml(item.path)}" data-preview-kind="${escapeHtml(item.kind)}" data-preview-name="${escapeHtml(item.name)}">Ansehen</button>` : ''}
             ${isText ? `<button class="btn-secondary btn-sm" data-edit-text="${escapeHtml(item.path)}">Editor</button>` : ''}
             ${isArchive && canWrite ? `<button class="btn-secondary btn-sm" data-extract-file="${escapeHtml(item.path)}">Entpacken</button>` : ''}
             <a class="btn-secondary btn-sm" href="${escapeHtml(dlUrl)}" download style="text-decoration:none;">Download</a>`;

        const writeBtns = canWrite
          ? `<button class="btn-secondary btn-sm" data-move-single="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Verschieben</button>
             <button class="btn-secondary btn-sm" data-rename-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Umbenennen</button>
             <button class="btn-danger-ghost btn-sm" data-delete-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Papierkorb</button>`
          : '';

        const dragAttr = canWrite ? `draggable="true" data-drag-path="${escapeHtml(item.path)}"` : '';
        const dropAttr = item.isDirectory ? `data-drop-dir="${escapeHtml(item.path)}"` : '';

        rows.push(`
          <tr ${dragAttr} ${dropAttr}>
            <td>${listing.currentPath !== '/' ? `<input type="checkbox" class="file-select-cb" data-file-path="${escapeHtml(item.path)}" ${checked} />` : ''}</td>
            <td>
              <button class="file-entry-btn" ${item.isDirectory ? `data-open-dir="${escapeHtml(item.path)}"` : isText ? `data-edit-text="${escapeHtml(item.path)}"` : `data-preview-file="${escapeHtml(item.path)}" data-preview-kind="${escapeHtml(item.kind)}" data-preview-name="${escapeHtml(item.name)}"`}>
                <span>${item.isDirectory ? '📁' : item.kind === 'image' ? '🖼️' : item.kind === 'video' ? '🎬' : item.kind === 'audio' ? '🎵' : item.kind === 'text' ? '📝' : '📄'}</span>
                <span>${escapeHtml(item.name)}</span>
              </button>
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

    // Grid View (with thumbnails, checkboxes, Drag&Drop & quick Move/Download/Trash buttons)
    gridContainer.innerHTML = filtered
      .map((item) => {
        const rawUrl = `/api/files/raw?path=${encodeURIComponent(item.path)}`;
        const dlUrl = item.isDirectory
          ? `/api/files/zip?path=${encodeURIComponent(item.path)}`
          : `/api/files/raw?path=${encodeURIComponent(item.path)}&download=1`;
        const checked = state.selectedFiles.has(item.path) ? 'checked' : '';
        const thumb = item.isDirectory
          ? '📁'
          : item.kind === 'image'
          ? `<img src="${escapeHtml(rawUrl)}" loading="lazy" alt="${escapeHtml(item.name)}" />`
          : item.kind === 'video'
          ? '🎬'
          : item.kind === 'audio'
          ? '🎵'
          : item.kind === 'text'
          ? '📝'
          : '📄';
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
              ${listing.currentPath !== '/' ? `<input type="checkbox" class="file-select-cb" data-file-path="${escapeHtml(item.path)}" ${checked} />` : '<span></span>'}
              <span class="mono" style="font-size:10.5px;color:var(--text-muted);">${item.isDirectory ? 'Ordner' : formatBytesDecimal(item.sizeBytes)}</span>
            </div>
            <div class="file-thumb-box" ${attr}>${thumb}</div>
            <div class="file-grid-name" ${attr} title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            <div class="file-grid-actions">
              <a class="btn-secondary btn-xs" href="${escapeHtml(dlUrl)}" download style="text-decoration:none;" title="${item.isDirectory ? 'Als ZIP herunterladen' : 'Herunterladen'}">${item.isDirectory ? 'ZIP' : 'Laden'}</a>
              ${canWrite ? `<button type="button" class="btn-secondary btn-xs" data-move-single="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">Verschieben</button>
              <button type="button" class="btn-danger-ghost btn-xs" data-delete-file="${escapeHtml(item.path)}" data-file-name="${escapeHtml(item.name)}">🗑️ </button>` : ''}
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

    let idx = 0;
    const errors = [];
    const uploadNext = () => {
      if (idx >= files.length) {
        wrap.classList.add('hidden');
        bar.style.width = '0%';
        pctEl.textContent = '0%';
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

  function openMediaPreview(filePath, kind, name) {
    const rawUrl = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
    document.getElementById('modal-preview-title').textContent = name || 'Dateivorschau';
    document.getElementById('modal-preview-path').textContent = filePath;
    document.getElementById('btn-preview-download').href = `${rawUrl}&download=1`;

    const stage = document.getElementById('media-preview-stage');
    if (kind === 'image') {
      stage.innerHTML = `<img src="${escapeHtml(rawUrl)}" alt="${escapeHtml(name)}" />`;
    } else if (kind === 'video') {
      stage.innerHTML = `<video src="${escapeHtml(rawUrl)}" controls autoplay></video>`;
    } else if (kind === 'audio') {
      stage.innerHTML = `<audio src="${escapeHtml(rawUrl)}" controls autoplay style="width:100%;max-width:480px;"></audio>`;
    } else {
      stage.innerHTML = `<p class="muted-text">Keine direkte Browser-Vorschau für diesen Dateityp. Nutze "Herunterladen".</p>`;
    }
    openModal('modal-preview');
  }

  async function openTextEditor(filePath) {
    const res = await fetch(`/api/files/text?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Datei konnte nicht geöffnet werden');
    state.activeEditorPath = filePath;
    document.getElementById('modal-editor-title').textContent = data.name;
    document.getElementById('modal-editor-path').textContent = filePath;
    document.getElementById('text-editor-area').value = data.content || '';
    document.getElementById('editor-save-msg').textContent = '';
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

  // ==================== AUTOMATION, WATCHDOG & WAKE-ON-LAN ====================
  async function loadAutomationState() {
    try {
      const res = await fetch('/api/automation/state', { cache: 'no-store' });
      if (!res.ok) return;
      state.automationData = await res.json();
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
      'container-restart': 'Container-Neustart'
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
  }

  // ==================== SETTINGS VIEW ====================
  let settingsPopulated = false;
  function renderSettingsView(data) {
    const cfg = data.config || {};
    if (!settingsPopulated) {
      document.getElementById('input-server-name').value = cfg.serverName || '';
      document.getElementById('input-media-paths').value = (cfg.mediaPaths || []).join(', ');
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
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/media/scan`, { method: 'POST' });
      if (res.ok) handleSnapshot(await res.json());
    } finally {
      if (btn) btn.disabled = false;
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
      renderGlobalSearchResults();
      openModal('modal-search');
      setTimeout(() => document.getElementById('global-search-input').focus(), 30);
    };
    document.getElementById('btn-global-search').addEventListener('click', openSearch);
    document.getElementById('global-search-input').addEventListener('input', renderGlobalSearchResults);
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

    // Telemetry Chart Tabs
    document.querySelectorAll('[data-chart]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartMode = btn.dataset.chart;
        document.querySelectorAll('[data-chart]').forEach((b) => b.classList.toggle('active', b === btn));
        drawTelemetryChart();
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
    document.getElementById('files-search').addEventListener('input', renderFilesView);
    document.getElementById('btn-files-refresh').addEventListener('click', () => {
      if (state.filesTrashMode) loadTrashView();
      else loadFilesDirectory(state.filesPath);
    });
    document.getElementById('btn-files-trash').addEventListener('click', loadTrashView);
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
    document.getElementById('btn-trash-restore-sel').addEventListener('click', async () => {
      const keys = [...state.selectedTrashKeys];
      if (keys.length === 0) return;
      const res = await fetch('/api/files/trash/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashKeys: keys })
      });
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Wiederherstellen fehlgeschlagen');
      await loadTrashView();
      refreshTrashBadge();
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

    // Text Editor Save
    document.getElementById('btn-editor-save').addEventListener('click', async () => {
      if (!state.activeEditorPath) return;
      const content = document.getElementById('text-editor-area').value;
      const res = await fetch(`/api/files/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.activeEditorPath, content })
      });
      const msg = document.getElementById('editor-save-msg');
      msg.textContent = res.ok ? 'Gespeichert!' : 'Fehler beim Speichern';
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

      const updateContainerBtn = e.target.closest('[data-update-container]');
      if (updateContainerBtn) {
        const cid = updateContainerBtn.dataset.updateContainer;
        const cname = updateContainerBtn.dataset.cname;
        if (!confirm(`Neuestes Image für "${cname}" ziehen und Container neu starten?`)) return;
        updateContainerBtn.disabled = true;
        updateContainerBtn.textContent = 'Lädt…';
        try {
          const res = await fetch(`/api/docker/${encodeURIComponent(cid)}/update`, { method: 'POST', body: '{}' });
          const d = await res.json();
          if (!res.ok) alert(d.error);
          else {
            const snapRes = await fetch(`/api/snapshot`);
            if (snapRes.ok) handleSnapshot(await snapRes.json());
          }
        } finally {
          updateContainerBtn.disabled = false;
          updateContainerBtn.textContent = 'Update';
        }
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
      const msg = document.getElementById('settings-save-msg');
      try {
        await saveConfigPatch({ serverName, mediaPaths });
        msg.textContent = 'Gespeichert!';
      } catch (err) {
        msg.textContent = `Fehler: ${err.message}`;
      }
      setTimeout(() => { msg.textContent = ''; }, 2500);
    });

    document.getElementById('form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      errEl.classList.add('hidden');
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        errEl.textContent = d.error || 'Falsches Passwort.';
        errEl.classList.remove('hidden');
        return;
      }
      document.getElementById('auth-overlay').classList.add('hidden');
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
  }

  // ==================== BOOT ====================
  async function init() {
    initTheme();
    bindEvents();
    localStorage.removeItem('hs_mode');
    const ok = await checkAuthAndStart();
    if (ok) connectStream();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
