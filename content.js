/**
 * =============================================================================
 * Zap Negócios — content.js
 * =============================================================================
 * Extensão Chrome para Travel Flow CRM e WhatsApp Web.
 *
 * Injeta um painel lateral na página de atendimento que permite ao operador
 * criar, visualizar, editar e excluir múltiplos negócios vinculados a um lead,
 * usando conversationId, telefone do lead e origem da conversa como vínculos.
 *
 * O campo Nome do Lead é preenchido automaticamente a partir do DOM do CRM
 * ou do cabeçalho da conversa no WhatsApp Web.
 *
 * API_BASE, API_KEY e a sessão do usuário são carregados do storage,
 * configurados pelo usuário na página de Opções da extensão.
 *
 * O papel do usuário logado controla permissões: viewer, editor, admin ou owner.
 *
 * Os dados são persistidos em banco MySQL via API PHP hospedada no servidor
 * do operador. A extensão detecta automaticamente trocas de atendimento e
 * recarrega os negócios correspondentes sem recarregar a página.
 *
 * Correções aplicadas (v0.4.1):
 *   - getElementById com template literals corrigidas em clearForm, fillForm e getFormData
 *   - querySelector com template literals corrigidas no sistema de abas
 *
 * Novidades (v0.4.5):
 *   - updatePanelTitle(): título h2 do painel atualiza com o nome do lead
 *     ao trocar de conversa, com retentativas para aguardar o DOM do SPA
 *   - page-bridge.js captura o nome do lead assincronamente e inclui
 *     no evento tfq:conversation-change (detail.leadName), permitindo
 *     atualização imediata do título antes do loadNegocios terminar
 *
 * Autor:   Ricardo Macari
 * Contato: macari@gmail.com
 * Projeto: Zap Negócios
 * =============================================================================
 */
(function () {

  const PANEL_ID           = 'tfq-panel';
  const TOGGLE_ID          = 'tfq-toggle';
  const LEAD_NAME_SELECTOR = 'h3.font-semibold:not(.truncate)';
  const TRAVEL_FLOW_HOST   = 'travelflow.tur.br';
  const WHATSAPP_HOST      = 'web.whatsapp.com';
  const INTERNAL_FIELD_KEYS = new Set(['deleted_at', 'deleted_by_user_id']);
  const DEFAULT_TOGGLE_SETTINGS = {
    label: 'Negócios',
    x: 960,
    y: 10,
    color: '#ce1212'
  };
  const DEFAULT_PANEL_SETTINGS = {
    slideMs: 300,
    rebuildDelayMs: 90
  };
  const DEFAULT_NOTIFICATION_SETTINGS = {
    enabled: true,
    intervalMinutes: 5,
    lookaheadMinutes: 15,
    historyDays: 1,
    normalPriority: 1,
    highPriority: 2,
    inAppAlertMinutes: 30,
    soundEnabled: true,
    emailEnabled: false,
    emailIntervalMinutes: 120
  };
  const DEFAULT_TASK_AUTOMATION_SETTINGS = {
    autoFollowupEnabled: false,
    dueHours: 24,
    businessStart: '08:00',
    businessEnd: '18:00',
    title: 'Fazer follow-up'
  };
  const DEFAULT_THEME_SETTINGS = {
    mode: 'auto',
    nightStart: '18:00',
    nightEnd: '07:00',
    dayPrimary: '#0a6c74',
    nightPrimary: '#4fb3bf',
    applyToCrm: true
  };

  let API_BASE  = '';
  let API_KEY   = '';
  let AUTH_TOKEN = '';
  let CURRENT_USER = null;
  let userConfigLoaded = false;
  let toggleSettingsLoaded = false;
  let panelSettingsLoaded = false;
  let notificationSettingsLoaded = false;
  let taskAutomationSettingsLoaded = false;
  let themeSettingsLoaded = false;
  let toggleSettings = { ...DEFAULT_TOGGLE_SETTINGS };
  let panelSettings = { ...DEFAULT_PANEL_SETTINGS };
  let notificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  let taskAutomationSettings = { ...DEFAULT_TASK_AUTOMATION_SETTINGS };
  let themeSettings = { ...DEFAULT_THEME_SETTINGS };
  let rolePermissionMap = {};
  let userPermissionMap = {};
  let permissionCatalog = [];
  let toggleDragState = null;
  let suppressNextToggleClick = false;

  function loadUserConfig() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get(['tfq_api_base', 'tfq_api_key'], syncResult => {
          chrome.storage.local.get(['tfq_auth_token', 'tfq_user'], localResult => {
            API_BASE    = (syncResult.tfq_api_base || '').trim().replace(/\/$/, '');
            API_KEY     = (syncResult.tfq_api_key || '').trim();
            AUTH_TOKEN  = (localResult.tfq_auth_token || '').trim();
            CURRENT_USER = localResult.tfq_user || null;
            userConfigLoaded = true;
            resolve();
          });
        });
      } catch (e) {
        userConfigLoaded = true;
        resolve();
      }
    });
  }

  function isConfigured() {
    return API_BASE !== '' && API_KEY !== '' && AUTH_TOKEN !== '';
  }

  function roleLevel(role) {
    return { viewer: 10, editor: 20, admin: 30, owner: 40 }[role] || 0;
  }

  function hasRole(minRole) {
    return CURRENT_USER && roleLevel(CURRENT_USER.role) >= roleLevel(minRole);
  }

  function userPermissions() {
    if (!CURRENT_USER) return [];
    if (CURRENT_USER.role === 'owner') return ['*'];
    return Array.isArray(CURRENT_USER.permissions) ? CURRENT_USER.permissions : [];
  }

  function hasPermission(permission, fallbackRole = '') {
    if (!CURRENT_USER) return false;
    if (CURRENT_USER.role === 'owner') return true;
    const permissions = userPermissions();
    if (permissions.includes('*') || permissions.includes(permission)) return true;
    return fallbackRole ? hasRole(fallbackRole) : false;
  }

  function canEdit() {
    return hasPermission('negocio.edit', 'editor');
  }

  function canDeleteNegocio() {
    return hasPermission('negocio.delete', 'admin');
  }

  function canRestoreNegocio() {
    return hasPermission('negocio.restore', 'admin');
  }

  function canViewTasks() {
    return hasPermission('tasks.view', 'viewer');
  }

  function canEditTasks() {
    return hasPermission('tasks.edit', 'editor');
  }

  function canAdminTasks() {
    return hasPermission('tasks.admin', 'admin');
  }

  function canAccessAdmin() {
    return hasPermission('admin.access', 'admin');
  }

  function isAdmin() {
    return canAccessAdmin();
  }

  function canViewUsersAdmin() {
    return hasPermission('admin.users.view', 'admin') || hasPermission('admin.users.edit', 'admin');
  }

  function canManageUsers() {
    return hasPermission('admin.users.edit', 'admin');
  }

  function canCreateOwner() {
    return hasRole('owner');
  }

  function isInternalField(field) {
    return INTERNAL_FIELD_KEYS.has(field && (field.key || field.name));
  }

  function hasDeletedAtValue(value) {
    const text = String(value || '').trim();
    return text !== '' && text !== '0000-00-00' && text !== '0000-00-00 00:00:00';
  }

  function apiHeaders(extra = {}) {
    const headers = { 'X-Api-Key': API_KEY, ...extra };
    if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
    return headers;
  }

  function adminHeaders(extra = {}) {
    return apiHeaders(extra);
  }

  function adminApiHeaders(extra = {}) {
    return apiHeaders(extra);
  }

  function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, number));
  }

  function normalizeTimeValue(value, fallback) {
    const text = String(value || '').trim();
    return /^\d{2}:\d{2}$/.test(text) ? text : fallback;
  }

  function normalizeThemeSettings(value = {}) {
    const mode = ['auto', 'light', 'dark'].includes(value.mode) ? value.mode : DEFAULT_THEME_SETTINGS.mode;
    const colorPattern = /^#[0-9a-f]{6}$/i;
    return {
      mode,
      nightStart: normalizeTimeValue(value.nightStart, DEFAULT_THEME_SETTINGS.nightStart),
      nightEnd: normalizeTimeValue(value.nightEnd, DEFAULT_THEME_SETTINGS.nightEnd),
      dayPrimary: colorPattern.test(String(value.dayPrimary || '')) ? String(value.dayPrimary) : DEFAULT_THEME_SETTINGS.dayPrimary,
      nightPrimary: colorPattern.test(String(value.nightPrimary || '')) ? String(value.nightPrimary) : DEFAULT_THEME_SETTINGS.nightPrimary,
      applyToCrm: value.applyToCrm === true
    };
  }

  function minutesFromTime(value) {
    const [hours, minutes] = normalizeTimeValue(value, '00:00').split(':').map(Number);
    return hours * 60 + minutes;
  }

  function isNightThemeTime(settings) {
    const start = minutesFromTime(settings.nightStart);
    const end = minutesFromTime(settings.nightEnd);
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    if (start === end) return false;
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  function getEffectiveTheme(settings = themeSettings) {
    const normalized = normalizeThemeSettings(settings);
    if (normalized.mode === 'dark') return 'dark';
    if (normalized.mode === 'light') return 'light';
    return isNightThemeTime(normalized) ? 'dark' : 'light';
  }

  function applyThemeSettings() {
    themeSettings = normalizeThemeSettings(themeSettings);
    const theme = getEffectiveTheme(themeSettings);
    const panel = getPanel();
    const toggle = getToggle();
    const primary = theme === 'dark' ? themeSettings.nightPrimary : themeSettings.dayPrimary;
    document.documentElement.style.setProperty('--tf-addon-primary', primary);
    document.documentElement.style.setProperty('--tf-addon-primary-strong', theme === 'dark' ? '#7fd6df' : '#08545a');
    document.body.classList.toggle('tfq-crm-theme-dark', themeSettings.applyToCrm && theme === 'dark');
    document.body.classList.toggle('tfq-crm-theme-light', themeSettings.applyToCrm && theme === 'light');
    [panel, toggle].forEach(el => {
      if (!el) return;
      el.classList.toggle('tfq-theme-dark', theme === 'dark');
      el.classList.toggle('tfq-theme-light', theme === 'light');
    });
    window.setTimeout(() => {
      markActiveCrmConversation();
      markReadableCrmBubbles();
      markCrmThemeSurfaces();
    }, 50);
  }

  function markActiveCrmConversation() {
    document.querySelectorAll('.tfq-crm-active-conversation').forEach(el => {
      el.classList.remove('tfq-crm-active-conversation');
    });

    if (!document.body.classList.contains('tfq-crm-theme-dark') || getPlatform() !== 'travel_flow') return;

    const context = getCurrentContext();
    const leadName = cleanDomText(context.leadName);
    const leadPhone = normalizePhone(context.leadPhone);
    if (!leadName && !leadPhone) return;

    const maxRight = window.innerWidth * 0.45;
    let best = null;
    let bestScore = 0;
    document.querySelectorAll('div, li, button, a').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      if (rect.right > maxRight || rect.width < 160 || rect.height < 42 || rect.height > 130) return;

      const text = cleanDomText(el.textContent);
      if (!text || text.length > 500) return;

      let score = 0;
      if (leadPhone && normalizePhone(text).includes(leadPhone)) score += 100;
      if (leadName && text.toLowerCase().includes(leadName.toLowerCase())) score += 80;
      if (!score) return;
      score += Math.max(0, 40 - Math.abs(rect.height - 72));

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    });

    if (best) best.classList.add('tfq-crm-active-conversation');
  }

  function getRgbParts(value) {
    const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
    if (!match) return null;
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (alpha <= 0) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      alpha
    };
  }

  function isLightBubbleColor(color) {
    if (!color) return false;
    const brightness = (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
    const isLightGreen = color.g >= 210 && color.r >= 170 && color.b >= 150;
    return brightness >= 188 || isLightGreen;
  }

  function markReadableCrmBubbles() {
    document.querySelectorAll('.tfq-crm-readable-bubble').forEach(el => {
      el.classList.remove('tfq-crm-readable-bubble');
    });

    if (!document.body.classList.contains('tfq-crm-theme-dark') || getPlatform() !== 'travel_flow') return;

    document.querySelectorAll('div, article, section').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 70 || rect.height < 24 || rect.width > window.innerWidth * 0.72 || rect.height > 360) return;
      const text = cleanDomText(el.textContent);
      if (!text || text.length > 1200) return;

      const color = getRgbParts(window.getComputedStyle(el).backgroundColor);
      if (!isLightBubbleColor(color)) return;

      el.classList.add('tfq-crm-readable-bubble');
    });
  }

  function markCrmThemeSurfaces() {
    document.querySelectorAll('[data-tfq-crm-sidebar-contrast="1"], [data-tfq-crm-header-contrast="1"]').forEach(el => {
      el.removeAttribute('data-tfq-crm-sidebar-contrast');
      el.removeAttribute('data-tfq-crm-header-contrast');
      el.style.removeProperty('color');
      el.style.removeProperty('opacity');
      el.style.removeProperty('filter');
      el.style.removeProperty('stroke');
    });
    document.querySelectorAll('.tfq-crm-main-sidebar, .tfq-crm-sidebar-readable, .tfq-crm-header-surface, .tfq-crm-wallpaper-surface, .tfq-crm-composer-surface').forEach(el => {
      el.classList.remove('tfq-crm-main-sidebar', 'tfq-crm-sidebar-readable', 'tfq-crm-header-surface', 'tfq-crm-wallpaper-surface', 'tfq-crm-composer-surface');
    });

    if (!document.body.classList.contains('tfq-crm-theme-dark') || getPlatform() !== 'travel_flow') return;

    document.querySelectorAll('aside, nav, div').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      if (rect.left > 20 || rect.top > 20 || rect.width < 170 || rect.width > 290 || rect.height < window.innerHeight * 0.65) return;
      el.classList.add('tfq-crm-main-sidebar');
    });

    document.querySelectorAll('div, nav, aside, a, button, span, p, small, strong, b, svg').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      const isSidebarRegion = rect.left < 260 && rect.top > 105 && rect.width <= 250 && rect.height >= 10 && rect.height <= 110;
      if (isSidebarRegion) {
        el.classList.add('tfq-crm-sidebar-readable');
        el.setAttribute('data-tfq-crm-sidebar-contrast', '1');
        el.style.setProperty('color', '#e5edf7', 'important');
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('filter', 'none', 'important');
        if (el.tagName.toLowerCase() === 'svg') {
          el.style.setProperty('stroke', 'currentColor', 'important');
        }
      }
    });

    document.querySelectorAll('h1, h2, h3, h4, span, p, small, strong, b, div').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      const isConversationHeader = rect.top >= 0
        && rect.top <= 86
        && rect.left >= 55
        && rect.left <= window.innerWidth - 120
        && rect.width <= 520
        && rect.height >= 10
        && rect.height <= 86;
      if (!isConversationHeader) return;
      const text = cleanDomText(el.textContent);
      if (!text || text.length > 160) return;

      el.setAttribute('data-tfq-crm-header-contrast', '1');
      el.style.setProperty('color', '#f8fafc', 'important');
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('filter', 'none', 'important');
    });

    document.querySelectorAll('header, div, section').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      const isHeaderSurface = rect.top >= 0
        && rect.top <= 12
        && rect.left >= 55
        && rect.width >= 360
        && rect.height >= 44
        && rect.height <= 92;
      if (!isHeaderSurface) return;

      el.classList.add('tfq-crm-header-surface');
      el.querySelectorAll('h1, h2, h3, h4, span, p, small, strong, b, div').forEach(child => {
        child.setAttribute('data-tfq-crm-header-contrast', '1');
        child.style.setProperty('color', '#f8fafc', 'important');
        child.style.setProperty('opacity', '1', 'important');
        child.style.setProperty('filter', 'none', 'important');
      });
    });

    document.querySelectorAll('main, section, article, div').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      if (rect.left < window.innerWidth * 0.28 || rect.width < 420 || rect.height < 320) return;
      const style = window.getComputedStyle(el);
      const hasWallpaper = style.backgroundImage && style.backgroundImage !== 'none';
      const bg = getRgbParts(style.backgroundColor);
      const isLargeLightSurface = bg && isLightBubbleColor(bg);
      if (hasWallpaper || isLargeLightSurface) {
        el.classList.add('tfq-crm-wallpaper-surface');
      }
    });

    document.querySelectorAll('div, footer, section').forEach(el => {
      if (!isVisibleElement(el) || el.closest(`#${PANEL_ID}`)) return;
      const rect = el.getBoundingClientRect();
      const isComposerArea = rect.left > window.innerWidth * 0.28
        && rect.bottom > window.innerHeight - 95
        && rect.width > 420
        && rect.height >= 46
        && rect.height <= 130;
      if (isComposerArea) el.classList.add('tfq-crm-composer-surface');
    });
  }

  function loadThemeSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get(['tfq_theme_settings'], result => {
          themeSettings = normalizeThemeSettings(result.tfq_theme_settings || {});
          themeSettingsLoaded = true;
          applyThemeSettings();
          resolve(themeSettings);
        });
      } catch {
        themeSettings = { ...DEFAULT_THEME_SETTINGS };
        themeSettingsLoaded = true;
        applyThemeSettings();
        resolve(themeSettings);
      }
    });
  }

  function saveThemeSettings(settings) {
    themeSettings = normalizeThemeSettings(settings);
    applyThemeSettings();
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set({ tfq_theme_settings: themeSettings }, () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          themeSettingsLoaded = true;
          resolve(themeSettings);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function normalizeToggleSettings(value = {}) {
    const label = String(value.label || DEFAULT_TOGGLE_SETTINGS.label).trim().slice(0, 24);
    const color = /^#[0-9a-f]{6}$/i.test(String(value.color || ''))
      ? String(value.color)
      : DEFAULT_TOGGLE_SETTINGS.color;
    const fallbackX = value.side === 'left'
      ? 16
      : Math.max(16, window.innerWidth - 120);
    const x = clampNumber(value.x ?? fallbackX, 8, Math.max(8, window.innerWidth - 56));
    const y = clampNumber(value.y ?? value.top ?? DEFAULT_TOGGLE_SETTINGS.y, 8, Math.max(8, window.innerHeight - 44));

    return {
      label: label || DEFAULT_TOGGLE_SETTINGS.label,
      x,
      y,
      color
    };
  }

  function applyToggleSettings() {
    const toggle = getToggle();
    if (!toggle) return;

    const settings = normalizeToggleSettings(toggleSettings);
    const badgeText = toggle.querySelector('.tfq-toggle-count')?.textContent || '';
    const badgeHidden = toggle.querySelector('.tfq-toggle-count')?.classList.contains('tfq-hidden') !== false;
    toggle.innerHTML = `
      <span class="tfq-toggle-label">${escapeHtml(settings.label)}</span>
      <span id="tfq-toggle-count" class="tfq-toggle-count ${badgeHidden ? 'tfq-hidden' : ''}">${escapeHtml(badgeText)}</span>
    `;
    toggle.style.setProperty('--tfq-toggle-bg', settings.color);
    toggle.style.setProperty('--tfq-toggle-x', `${settings.x}px`);
    toggle.style.setProperty('--tfq-toggle-y', `${settings.y}px`);
    toggleSettings = settings;
  }

  function loadToggleSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get(['tfq_toggle_settings'], result => {
          toggleSettings = normalizeToggleSettings(result.tfq_toggle_settings || {});
          toggleSettingsLoaded = true;
          applyToggleSettings();
          resolve(toggleSettings);
        });
      } catch {
        toggleSettings = { ...DEFAULT_TOGGLE_SETTINGS };
        toggleSettingsLoaded = true;
        applyToggleSettings();
        resolve(toggleSettings);
      }
    });
  }

  function saveToggleSettings(settings) {
    toggleSettings = normalizeToggleSettings(settings);
    applyToggleSettings();

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set({ tfq_toggle_settings: toggleSettings }, () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(toggleSettings);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function normalizePanelSettings(value = {}) {
    return {
      slideMs: clampNumber(value.slideMs ?? DEFAULT_PANEL_SETTINGS.slideMs, 0, 800),
      rebuildDelayMs: clampNumber(value.rebuildDelayMs ?? DEFAULT_PANEL_SETTINGS.rebuildDelayMs, 0, 600)
    };
  }

  function applyPanelSettings() {
    panelSettings = normalizePanelSettings(panelSettings);
    document.documentElement.style.setProperty('--tfq-panel-slide-ms', `${panelSettings.slideMs}ms`);
  }

  function loadPanelSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get(['tfq_panel_settings'], result => {
          panelSettings = normalizePanelSettings(result.tfq_panel_settings || {});
          panelSettingsLoaded = true;
          applyPanelSettings();
          resolve(panelSettings);
        });
      } catch {
        panelSettings = { ...DEFAULT_PANEL_SETTINGS };
        panelSettingsLoaded = true;
        applyPanelSettings();
        resolve(panelSettings);
      }
    });
  }

  function savePanelSettings(settings) {
    panelSettings = normalizePanelSettings(settings);
    applyPanelSettings();

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set({ tfq_panel_settings: panelSettings }, () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          panelSettingsLoaded = true;
          resolve(panelSettings);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function normalizeNotificationSettings(value = {}) {
    return {
      enabled: value.enabled !== false,
      intervalMinutes: clampNumber(value.intervalMinutes ?? DEFAULT_NOTIFICATION_SETTINGS.intervalMinutes, 1, 120),
      lookaheadMinutes: clampNumber(value.lookaheadMinutes ?? DEFAULT_NOTIFICATION_SETTINGS.lookaheadMinutes, 0, 1440),
      historyDays: clampNumber(value.historyDays ?? DEFAULT_NOTIFICATION_SETTINGS.historyDays, 1, 60),
      normalPriority: clampNumber(value.normalPriority ?? DEFAULT_NOTIFICATION_SETTINGS.normalPriority, 0, 2),
      highPriority: clampNumber(value.highPriority ?? DEFAULT_NOTIFICATION_SETTINGS.highPriority, 0, 2),
      inAppAlertMinutes: clampNumber(value.inAppAlertMinutes ?? DEFAULT_NOTIFICATION_SETTINGS.inAppAlertMinutes, 5, 240),
      soundEnabled: value.soundEnabled !== false,
      emailEnabled: value.emailEnabled === true,
      emailIntervalMinutes: clampNumber(value.emailIntervalMinutes ?? DEFAULT_NOTIFICATION_SETTINGS.emailIntervalMinutes, 15, 1440)
    };
  }

  function loadNotificationSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get(['tfq_notification_settings'], result => {
          notificationSettings = normalizeNotificationSettings(result.tfq_notification_settings || {});
          notificationSettingsLoaded = true;
          resolve(notificationSettings);
        });
      } catch {
        notificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
        notificationSettingsLoaded = true;
        resolve(notificationSettings);
      }
    });
  }

  function saveNotificationSettings(settings) {
    notificationSettings = normalizeNotificationSettings(settings);

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set({ tfq_notification_settings: notificationSettings }, () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          notificationSettingsLoaded = true;
          resolve(notificationSettings);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function normalizeTaskAutomationSettings(value = {}) {
    return {
      autoFollowupEnabled: value.autoFollowupEnabled === true,
      dueHours: clampNumber(value.dueHours ?? DEFAULT_TASK_AUTOMATION_SETTINGS.dueHours, 1, 720),
      businessStart: /^\d{2}:\d{2}$/.test(String(value.businessStart || '')) ? String(value.businessStart) : DEFAULT_TASK_AUTOMATION_SETTINGS.businessStart,
      businessEnd: /^\d{2}:\d{2}$/.test(String(value.businessEnd || '')) ? String(value.businessEnd) : DEFAULT_TASK_AUTOMATION_SETTINGS.businessEnd,
      title: String(value.title || DEFAULT_TASK_AUTOMATION_SETTINGS.title).trim() || DEFAULT_TASK_AUTOMATION_SETTINGS.title
    };
  }

  async function loadTaskAutomationSettings() {
    if (!isConfigured()) {
      taskAutomationSettings = { ...DEFAULT_TASK_AUTOMATION_SETTINGS };
      taskAutomationSettingsLoaded = true;
      return taskAutomationSettings;
    }

    try {
      const result = await fetchJson(`${API_BASE}/settings.php?key=task_automation&_t=${Date.now()}`, {
        headers: apiHeaders()
      });
      taskAutomationSettings = normalizeTaskAutomationSettings(result.settings || {});
    } catch {
      taskAutomationSettings = { ...DEFAULT_TASK_AUTOMATION_SETTINGS };
    }

    taskAutomationSettingsLoaded = true;
    return taskAutomationSettings;
  }

  async function saveTaskAutomationSettings(settings) {
    taskAutomationSettings = normalizeTaskAutomationSettings(settings);

    const result = await fetchJson(`${API_BASE}/settings.php`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        key: 'task_automation',
        settings: taskAutomationSettings
      })
    });

    taskAutomationSettings = normalizeTaskAutomationSettings(result.settings || taskAutomationSettings);
    taskAutomationSettingsLoaded = true;
    return taskAutomationSettings;
  }

  function getTaskAutomationStatusEl() {
    return document.getElementById('tfq-task-automation-status');
  }

  function setTaskAutomationStatus(message, type = '') {
    const el = getTaskAutomationStatusEl();
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  function renderTaskAutomationSettingsForm() {
    const enabledInput = document.getElementById('tfq-auto-followup-enabled');
    const dueInput = document.getElementById('tfq-auto-followup-hours');
    const startInput = document.getElementById('tfq-auto-followup-start');
    const endInput = document.getElementById('tfq-auto-followup-end');
    const titleInput = document.getElementById('tfq-auto-followup-title');
    if (!enabledInput || !dueInput || !startInput || !endInput || !titleInput) return;

    const settings = normalizeTaskAutomationSettings(taskAutomationSettings);
    enabledInput.checked = settings.autoFollowupEnabled;
    dueInput.value = String(settings.dueHours);
    startInput.value = settings.businessStart;
    endInput.value = settings.businessEnd;
    titleInput.value = settings.title;
  }

  function collectTaskAutomationSettingsForm() {
    return normalizeTaskAutomationSettings({
      autoFollowupEnabled: document.getElementById('tfq-auto-followup-enabled')?.checked === true,
      dueHours: document.getElementById('tfq-auto-followup-hours')?.value,
      businessStart: document.getElementById('tfq-auto-followup-start')?.value,
      businessEnd: document.getElementById('tfq-auto-followup-end')?.value,
      title: document.getElementById('tfq-auto-followup-title')?.value
    });
  }

  async function saveTaskAutomationSettingsFromForm() {
    try {
      setTaskAutomationStatus('Salvando tarefas...', '');
      await saveTaskAutomationSettings(collectTaskAutomationSettingsForm());
      renderTaskAutomationSettingsForm();
      setTaskAutomationStatus('Configuração de tarefas salva para todos os usuários.', 'success');
    } catch (error) {
      setTaskAutomationStatus(`Erro: ${error.message}`, 'error');
    }
  }

  async function resetTaskAutomationSettings() {
    try {
      setTaskAutomationStatus('Restaurando padrão...', '');
      await saveTaskAutomationSettings(DEFAULT_TASK_AUTOMATION_SETTINGS);
      renderTaskAutomationSettingsForm();
      setTaskAutomationStatus('Configuração global de tarefas restaurada.', 'success');
    } catch (error) {
      setTaskAutomationStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function getToggleAppearanceStatusEl() {
    return document.getElementById('tfq-toggle-appearance-status');
  }

  function setToggleAppearanceStatus(message, type = '') {
    const el = getToggleAppearanceStatusEl();
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  function getThemeSettingsStatusEl() {
    return document.getElementById('tfq-theme-settings-status');
  }

  function setThemeSettingsStatus(message, type = '') {
    const el = getThemeSettingsStatusEl();
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  function renderThemeSettingsForm() {
    const modeInput = document.getElementById('tfq-theme-mode');
    const nightStartInput = document.getElementById('tfq-theme-night-start');
    const nightEndInput = document.getElementById('tfq-theme-night-end');
    const dayPrimaryInput = document.getElementById('tfq-theme-day-primary');
    const nightPrimaryInput = document.getElementById('tfq-theme-night-primary');
    const applyToCrmInput = document.getElementById('tfq-theme-apply-crm');
    if (!modeInput || !nightStartInput || !nightEndInput || !dayPrimaryInput || !nightPrimaryInput || !applyToCrmInput) return;

    const settings = normalizeThemeSettings(themeSettings);
    modeInput.value = settings.mode;
    nightStartInput.value = settings.nightStart;
    nightEndInput.value = settings.nightEnd;
    dayPrimaryInput.value = settings.dayPrimary;
    nightPrimaryInput.value = settings.nightPrimary;
    applyToCrmInput.checked = settings.applyToCrm;
    applyThemeSettings();
  }

  function collectThemeSettingsForm() {
    return normalizeThemeSettings({
      mode: document.getElementById('tfq-theme-mode')?.value,
      nightStart: document.getElementById('tfq-theme-night-start')?.value,
      nightEnd: document.getElementById('tfq-theme-night-end')?.value,
      dayPrimary: document.getElementById('tfq-theme-day-primary')?.value,
      nightPrimary: document.getElementById('tfq-theme-night-primary')?.value,
      applyToCrm: document.getElementById('tfq-theme-apply-crm')?.checked === true
    });
  }

  function previewThemeSettings() {
    themeSettings = collectThemeSettingsForm();
    applyThemeSettings();
  }

  async function saveThemeSettingsFromForm() {
    try {
      setThemeSettingsStatus('Salvando tema...', '');
      await saveThemeSettings(collectThemeSettingsForm());
      renderThemeSettingsForm();
      setThemeSettingsStatus('Tema salvo neste navegador.', 'success');
    } catch (error) {
      setThemeSettingsStatus(`Erro: ${error.message}`, 'error');
    }
  }

  async function toggleCrmThemeFromForm() {
    try {
      themeSettings = collectThemeSettingsForm();
      applyThemeSettings();
      setThemeSettingsStatus('Atualizando tema...', '');
      await saveThemeSettings(themeSettings);
      setThemeSettingsStatus(themeSettings.applyToCrm ? 'Tema aplicado ao CRM.' : 'Tema removido do CRM.', 'success');
    } catch (error) {
      setThemeSettingsStatus(`Erro: ${error.message}`, 'error');
    }
  }

  async function resetThemeSettings() {
    try {
      setThemeSettingsStatus('Restaurando padrão...', '');
      await saveThemeSettings(DEFAULT_THEME_SETTINGS);
      renderThemeSettingsForm();
      setThemeSettingsStatus('Tema restaurado para o padrão.', 'success');
    } catch (error) {
      setThemeSettingsStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function renderToggleAppearanceForm() {
    const labelInput = document.getElementById('tfq-toggle-label');
    const xInput = document.getElementById('tfq-toggle-x');
    const xNumberInput = document.getElementById('tfq-toggle-x-number');
    const yInput = document.getElementById('tfq-toggle-y');
    const yNumberInput = document.getElementById('tfq-toggle-y-number');
    const colorInput = document.getElementById('tfq-toggle-color');

    if (!labelInput || !xInput || !xNumberInput || !yInput || !yNumberInput || !colorInput) return;

    const settings = normalizeToggleSettings(toggleSettings);
    const maxX = Math.max(8, window.innerWidth - 56);
    const maxY = Math.max(8, window.innerHeight - 44);
    labelInput.value = settings.label;
    xInput.max = String(maxX);
    xNumberInput.max = String(maxX);
    yInput.max = String(maxY);
    yNumberInput.max = String(maxY);
    xInput.value = String(settings.x);
    xNumberInput.value = String(settings.x);
    yInput.value = String(settings.y);
    yNumberInput.value = String(settings.y);
    colorInput.value = settings.color;
    applyToggleSettings();
  }

  function collectToggleAppearanceForm() {
    return normalizeToggleSettings({
      label: document.getElementById('tfq-toggle-label')?.value || DEFAULT_TOGGLE_SETTINGS.label,
      x: document.getElementById('tfq-toggle-x-number')?.value || document.getElementById('tfq-toggle-x')?.value,
      y: document.getElementById('tfq-toggle-y-number')?.value || document.getElementById('tfq-toggle-y')?.value,
      color: document.getElementById('tfq-toggle-color')?.value || DEFAULT_TOGGLE_SETTINGS.color
    });
  }

  function previewToggleAppearance() {
    toggleSettings = collectToggleAppearanceForm();
    applyToggleSettings();
  }

  async function saveToggleAppearance() {
    try {
      setToggleAppearanceStatus('Salvando aparência do botão...', '');
      await saveToggleSettings(collectToggleAppearanceForm());
      renderToggleAppearanceForm();
      setToggleAppearanceStatus('Aparência do botão salva neste navegador.', 'success');
    } catch (error) {
      setToggleAppearanceStatus(`Erro: ${error.message}`, 'error');
    }
  }

  async function resetToggleAppearance() {
    try {
      setToggleAppearanceStatus('Restaurando padrão...', '');
      await saveToggleSettings(DEFAULT_TOGGLE_SETTINGS);
      renderToggleAppearanceForm();
      setToggleAppearanceStatus('Botão restaurado para o padrão.', 'success');
    } catch (error) {
      setToggleAppearanceStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function syncTogglePositionInputs() {
    const settings = normalizeToggleSettings(toggleSettings);
    const xInput = document.getElementById('tfq-toggle-x');
    const xNumberInput = document.getElementById('tfq-toggle-x-number');
    const yInput = document.getElementById('tfq-toggle-y');
    const yNumberInput = document.getElementById('tfq-toggle-y-number');

    if (xInput) xInput.value = String(settings.x);
    if (xNumberInput) xNumberInput.value = String(settings.x);
    if (yInput) yInput.value = String(settings.y);
    if (yNumberInput) yNumberInput.value = String(settings.y);
  }

  function getPanelSettingsStatusEl() {
    return document.getElementById('tfq-panel-settings-status');
  }

  function setPanelSettingsStatus(message, type = '') {
    const el = getPanelSettingsStatusEl();
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  function renderPanelSettingsForm() {
    const slideInput = document.getElementById('tfq-panel-slide-ms');
    const slideNumberInput = document.getElementById('tfq-panel-slide-ms-number');
    const rebuildInput = document.getElementById('tfq-panel-rebuild-delay-ms');
    const rebuildNumberInput = document.getElementById('tfq-panel-rebuild-delay-ms-number');
    if (!slideInput || !slideNumberInput || !rebuildInput || !rebuildNumberInput) return;

    const settings = normalizePanelSettings(panelSettings);
    slideInput.value = String(settings.slideMs);
    slideNumberInput.value = String(settings.slideMs);
    rebuildInput.value = String(settings.rebuildDelayMs);
    rebuildNumberInput.value = String(settings.rebuildDelayMs);
    applyPanelSettings();
  }

  function collectPanelSettingsForm() {
    return normalizePanelSettings({
      slideMs: document.getElementById('tfq-panel-slide-ms-number')?.value || document.getElementById('tfq-panel-slide-ms')?.value,
      rebuildDelayMs: document.getElementById('tfq-panel-rebuild-delay-ms-number')?.value || document.getElementById('tfq-panel-rebuild-delay-ms')?.value
    });
  }

  function previewPanelSettings() {
    panelSettings = collectPanelSettingsForm();
    applyPanelSettings();
  }

  async function savePanelSettingsFromForm() {
    try {
      setPanelSettingsStatus('Salvando ajustes da janela...', '');
      await savePanelSettings(collectPanelSettingsForm());
      renderPanelSettingsForm();
      setPanelSettingsStatus('Ajustes da janela salvos neste navegador.', 'success');
    } catch (error) {
      setPanelSettingsStatus(`Erro: ${error.message}`, 'error');
    }
  }

  async function resetPanelSettings() {
    try {
      setPanelSettingsStatus('Restaurando padrão...', '');
      await savePanelSettings(DEFAULT_PANEL_SETTINGS);
      renderPanelSettingsForm();
      setPanelSettingsStatus('Ajustes da janela restaurados.', 'success');
    } catch (error) {
      setPanelSettingsStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function getNotificationSettingsStatusEl() {
    return document.getElementById('tfq-notification-settings-status');
  }

  function setNotificationSettingsStatus(message, type = '') {
    const el = getNotificationSettingsStatusEl();
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  function renderNotificationSettingsForm() {
    const enabledInput = document.getElementById('tfq-notifications-enabled');
    const intervalInput = document.getElementById('tfq-notification-interval');
    const lookaheadInput = document.getElementById('tfq-notification-lookahead');
    const historyInput = document.getElementById('tfq-notification-history-days');
    const normalPriorityInput = document.getElementById('tfq-notification-normal-priority');
    const highPriorityInput = document.getElementById('tfq-notification-high-priority');
    const inAppAlertInput = document.getElementById('tfq-notification-in-app-minutes');
    const soundInput = document.getElementById('tfq-notification-sound-enabled');
    const emailInput = document.getElementById('tfq-notification-email-enabled');
    const emailIntervalInput = document.getElementById('tfq-notification-email-interval');
    if (!enabledInput || !intervalInput || !lookaheadInput || !historyInput || !normalPriorityInput || !highPriorityInput || !inAppAlertInput || !soundInput || !emailInput || !emailIntervalInput) return;

    const settings = normalizeNotificationSettings(notificationSettings);
    enabledInput.checked = settings.enabled;
    intervalInput.value = String(settings.intervalMinutes);
    lookaheadInput.value = String(settings.lookaheadMinutes);
    historyInput.value = String(settings.historyDays);
    normalPriorityInput.value = String(settings.normalPriority);
    highPriorityInput.value = String(settings.highPriority);
    inAppAlertInput.value = String(settings.inAppAlertMinutes);
    soundInput.checked = settings.soundEnabled;
    emailInput.checked = settings.emailEnabled;
    emailIntervalInput.value = String(settings.emailIntervalMinutes);
  }

  function collectNotificationSettingsForm() {
    return normalizeNotificationSettings({
      enabled: document.getElementById('tfq-notifications-enabled')?.checked !== false,
      intervalMinutes: document.getElementById('tfq-notification-interval')?.value,
      lookaheadMinutes: document.getElementById('tfq-notification-lookahead')?.value,
      historyDays: document.getElementById('tfq-notification-history-days')?.value,
      normalPriority: document.getElementById('tfq-notification-normal-priority')?.value,
      highPriority: document.getElementById('tfq-notification-high-priority')?.value,
      inAppAlertMinutes: document.getElementById('tfq-notification-in-app-minutes')?.value,
      soundEnabled: document.getElementById('tfq-notification-sound-enabled')?.checked === true,
      emailEnabled: document.getElementById('tfq-notification-email-enabled')?.checked === true,
      emailIntervalMinutes: document.getElementById('tfq-notification-email-interval')?.value
    });
  }

  async function saveNotificationSettingsFromForm() {
    try {
      setNotificationSettingsStatus('Salvando notificações...', '');
      await saveNotificationSettings(collectNotificationSettingsForm());
      renderNotificationSettingsForm();
      setNotificationSettingsStatus('Notificações salvas neste navegador.', 'success');
    } catch (error) {
      setNotificationSettingsStatus(`Erro: ${error.message}`, 'error');
    }
  }

  async function resetNotificationSettings() {
    try {
      setNotificationSettingsStatus('Restaurando padrão...', '');
      await saveNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
      renderNotificationSettingsForm();
      setNotificationSettingsStatus('Notificações restauradas para o padrão.', 'success');
    } catch (error) {
      setNotificationSettingsStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function setupToggleDragging(toggle) {
    toggle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;

      const rect = toggle.getBoundingClientRect();
      toggleDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top,
        moved: false
      };

      toggle.classList.add('tfq-toggle-dragging');
      toggle.setPointerCapture(event.pointerId);
    });

    toggle.addEventListener('pointermove', event => {
      if (!toggleDragState || toggleDragState.pointerId !== event.pointerId) return;

      const dx = event.clientX - toggleDragState.startX;
      const dy = event.clientY - toggleDragState.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        toggleDragState.moved = true;
      }
      if (!toggleDragState.moved) return;

      event.preventDefault();
      toggleSettings = normalizeToggleSettings({
        ...toggleSettings,
        x: toggleDragState.originX + dx,
        y: toggleDragState.originY + dy
      });
      applyToggleSettings();
      syncTogglePositionInputs();
    });

    const finishDrag = async event => {
      if (!toggleDragState || toggleDragState.pointerId !== event.pointerId) return;

      const didMove = toggleDragState.moved;
      toggleDragState = null;
      toggle.classList.remove('tfq-toggle-dragging');
      try {
        toggle.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }

      if (!didMove) return;
      suppressNextToggleClick = true;
      window.setTimeout(() => { suppressNextToggleClick = false; }, 250);

      try {
        await saveToggleSettings(toggleSettings);
        syncTogglePositionInputs();
        setToggleAppearanceStatus('Posição do botão salva.', 'success');
      } catch (error) {
        setToggleAppearanceStatus(`Erro: ${error.message}`, 'error');
      }
    };

    toggle.addEventListener('pointerup', finishDrag);
    toggle.addEventListener('pointercancel', finishDrag);
  }

  function sendRuntimeMessageSafe(message) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(message, () => {
        // Ignora lastError: a operação principal não deve falhar se o
        // service worker estiver reiniciando ou se a extensão tiver sido recarregada.
        void chrome.runtime.lastError;
      });
    } catch {
      // Contexto invalidado após reload da extensão. Um refresh da página injeta
      // o content script novo, mas não deve transformar salvamento em erro.
    }
  }

  async function fetchJson(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        ...options,
        signal: controller.signal
      });
      const text = await response.text();
      let result = {};

      if (text) {
        try {
          result = JSON.parse(text);
        } catch {
          throw new Error(
            response.ok
              ? 'Resposta inválida do servidor. Verifique se a URL aponta para os arquivos PHP corretos.'
              : `Servidor retornou HTTP ${response.status} com resposta inválida.`
          );
        }
      }

      if (!response.ok) {
        const error = new Error(result.message || `Servidor retornou HTTP ${response.status}.`);
        error.status = response.status;
        error.payload = result;
        throw error;
      }

      if (result.success === false) {
        const error = new Error(result.message || 'A operação não foi concluída pelo servidor.');
        error.status = response.status;
        error.payload = result;
        throw error;
      }

      return result;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Tempo de conexão esgotado. Verifique o servidor e tente novamente.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const defaultFields = [
    { key: 'nome_lead',        label: 'Nome do Lead',               type: 'text',     auto: true },
    { key: 'lead_phone',       label: 'Telefone do Lead',           type: 'text',     auto: true },
    { key: 'email',            label: 'Email',                      type: 'text' },
    { key: 'destino',          label: 'Destino',                    type: 'text' },
    {
      key: 'status_negocio',
      label: 'Status do Negócio',
      type: 'select',
      options: ['', 'Novo', 'Em atendimento', 'Cotação enviada', 'Aguardando retorno', 'Fechado', 'Perdido']
    },
    {
      key: 'temperatura_lead',
      label: 'Temperatura do Lead',
      type: 'select',
      options: ['', 'Frio', 'Morno', 'Quente']
    },
    { key: 'proximo_contato',  label: 'Próximo Contato',            type: 'date' },
    { key: 'valor_estimado',   label: 'Valor Estimado',             type: 'currency' },
    { key: 'responsavel',      label: 'Responsável',                type: 'text' },
    { key: 'data_viagem',      label: 'Data da Viagem',             type: 'text' },
    { key: 'duracao_viagem',   label: 'Duração da Viagem',          type: 'text' },
    { key: 'numero_viajantes', label: 'Nº de Viajantes',            type: 'number' },
    { key: 'idade_viajantes',  label: 'Idade dos Viajantes',        type: 'text' },
    { key: 'cidade_origem',    label: 'Cidade de Origem',           type: 'text' },
    { key: 'orcamento',        label: 'Orçamento',                  type: 'currency' },
    {
      key: 'tipo_compra',
      label: 'Tipo de Compra',
      type: 'select',
      options: ['', 'Pacote completo', 'Aéreo + Hotel', 'Só hotel', 'Só aéreo', 'Cruzeiro', 'Seguro', 'Outro']
    },
    {
      key: 'prioridade_valor',
      label: 'Prioridade de Valor',
      type: 'select',
      options: ['', 'Preço', 'Custo-Benefício', 'Conforto', 'Experiências', 'Luxo']
    },
    {
      key: 'quando_reservar',
      label: 'Quando Pretende Reservar',
      type: 'select',
      options: ['', 'Hoje', 'Esta semana', 'Este mês', 'Em 30 dias', 'Só pesquisando']
    },
    { key: 'observacoes', label: 'Observações', type: 'textarea' }
  ];

  let fields = [...defaultFields];

  let currentConversationId     = '';
  let panelInitialized          = false;
  let syncScheduled             = false;
  let negociosCache             = [];
  let tasksCache                = [];
  let taskOverviewCache         = [];
  let taskOverviewFilter        = 'overdue';
  let taskAssigneesCache        = [];
  let auditPage                 = 1;
  let auditPagination           = { page: 1, pages: 1, total: 0, limit: 7 };
  let editingId                 = 0;
  let negocioViewMode           = 'create';
  let businessEditUnlocked      = false;
  let negocioLoadingLocked      = false;
  let editingTaskId             = 0;
  let editingTaskSource         = null;
  let focusedTaskId             = 0;
  let focusTaskNavigationPending = false;
  let lastFormSignature         = '';
  let formFieldsLoadedFromServer = false;
  let formFieldsLoadError        = '';
  let negociosRequestSeq        = 0;
  let tasksRequestSeq           = 0;
  let taskOverviewRequestSeq    = 0;
  let visibilityCheckInterval   = null;
  let lastCheckedConversationId = '';
  let observerDebounceTimer     = null;
  let panelRebuildContextKey    = '';
  let panelRebuildTimer         = null;
  let lastOverdueSoundAt        = 0;

  function getPlatform() {
    const host = window.location.hostname;
    const pathname = window.location.pathname;

    if (host === TRAVEL_FLOW_HOST && (pathname.includes('/atendimento-web') || pathname === '/atendimento-web')) {
      return 'travel_flow';
    }
    if (host === WHATSAPP_HOST) {
      return 'whatsapp_web';
    }

    return '';
  }

  function normalizePhone(value) {
    return String(value || '').replace(/\D+/g, '');
  }

  function simpleHash(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function getTravelFlowConversationId() {
    return new URL(window.location.href).searchParams.get('conversationId') || '';
  }

  function cleanDomText(value) {
    return String(value || '')
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisibleElement(element) {
    if (!element || !element.getClientRects || element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function stripWhatsAppStatus(text) {
    return cleanDomText(text)
      .replace(/\s+visto por último.*$/i, '')
      .replace(/\s+online$/i, '')
      .replace(/\s+digitando\.{0,3}$/i, '')
      .trim();
  }

  function isGenericWhatsAppText(text) {
    const value = stripWhatsAppStatus(text);
    const lower = value.toLowerCase();

    if (!lower || lower.length < 2 || lower.length > 80) return true;
    if (/^visto por último/i.test(lower)) return true;
    if (/^(online|digitando|dados do perfil|dados do contato|perfil|recado|mídia|links|docs)$/i.test(lower)) return true;
    if (/^(pesquisar|mais opções|menu|voltar|fechar|conversas|chamadas|status)$/i.test(lower)) return true;
    if (/^clique para/i.test(lower)) return true;

    return false;
  }

  function getWhatsAppHeaderText() {
    const header = document.querySelector('#main header');
    if (!header) return '';

    const candidates = [];
    const seen = new Set();
    const addCandidate = (value, score) => {
      const cleaned = stripWhatsAppStatus(value);
      if (isGenericWhatsAppText(cleaned) || seen.has(cleaned)) return;
      seen.add(cleaned);
      candidates.push({ value: cleaned, score });
    };

    header.querySelectorAll('[data-testid*="chat-title"], [data-testid*="conversation-info-header-chat-title"]').forEach(el => {
      if (isVisibleElement(el)) addCandidate(el.textContent, 120);
    });

    header.querySelectorAll('span[title]').forEach(el => {
      if (isVisibleElement(el)) addCandidate(el.getAttribute('title') || el.textContent, 110);
    });

    header.querySelectorAll('div[title]').forEach(el => {
      if (isVisibleElement(el)) addCandidate(el.getAttribute('title') || el.textContent, 70);
    });

    header.querySelectorAll('span[dir="auto"], div[dir="auto"]').forEach(el => {
      if (isVisibleElement(el)) addCandidate(el.textContent, 60);
    });

    candidates.sort((a, b) => b.score - a.score || a.value.length - b.value.length);
    return candidates.length ? candidates[0].value : '';
  }

  function isPlausibleLeadPhone(phone) {
    const digits = normalizePhone(phone);
    return digits.length >= 10 && digits.length <= 15;
  }

  function extractPhoneFromText(text) {
    const match = String(text || '').match(/(?:\+?\d[\d\s().-]{7,}\d)/);
    if (!match) return '';

    const phone = normalizePhone(match[0]);
    return isPlausibleLeadPhone(phone) ? phone : '';
  }

  function extractPhoneFromHref(href) {
    try {
      return extractPhoneFromText(decodeURIComponent(String(href || '')));
    } catch {
      return extractPhoneFromText(href);
    }
  }

  function getTravelFlowLeadPhoneFromDom() {
    const leadNameEl = document.querySelector(LEAD_NAME_SELECTOR);
    let parent = leadNameEl;
    let depth = 0;
    while (parent && depth < 6) {
      const text = cleanDomText(parent.textContent);
      if (text.length <= 800) {
        const phone = extractPhoneFromText(text);
        if (phone) return phone;
      }
      parent = parent.parentElement;
      depth++;
    }

    const phoneLinks = document.querySelectorAll(
      'a[href^="tel:"], a[href*="wa.me/"], a[href*="api.whatsapp.com"], a[href*="web.whatsapp.com/send"]'
    );

    for (const link of phoneLinks) {
      const phone = extractPhoneFromHref(link.getAttribute('href'));
      if (phone) return phone;
    }

    const controls = document.querySelectorAll('input, textarea');
    for (const control of controls) {
      const hint = [
        control.name,
        control.id,
        control.placeholder,
        control.getAttribute('aria-label')
      ].join(' ');
      if (!/telefone|celular|whats|phone|tel/i.test(hint)) continue;

      const phone = extractPhoneFromText(control.value);
      if (phone) return phone;
    }

    const labeledElements = document.querySelectorAll('label, span, p, div');
    let checked = 0;
    for (const element of labeledElements) {
      const text = (element.textContent || '').trim();
      if (text.length > 300 || !/telefone|celular|whats|phone|tel/i.test(text)) continue;

      const container = element.closest('div') || element.parentElement || element;
      const containerText = (container.textContent || '').trim();
      const phone = extractPhoneFromText(containerText.length <= 600 ? containerText : text);
      if (phone) return phone;

      checked++;
      if (checked >= 40) break;
    }

    return '';
  }

  function getLeadPhoneFromDom() {
    const platform = getPlatform();

    if (platform === 'whatsapp_web') {
      const headerText = getWhatsAppHeaderText();
      const headerPhone = extractPhoneFromText(headerText);
      if (headerPhone) return headerPhone;
      return '';
    }

    if (platform === 'travel_flow') {
      return getTravelFlowLeadPhoneFromDom();
    }

    return '';
  }

  function getLeadNameFromDom() {
    const platform = getPlatform();

    if (platform === 'whatsapp_web') {
      const text = getWhatsAppHeaderText();
      return text;
    }

    const el = document.querySelector(LEAD_NAME_SELECTOR);
    return el ? el.textContent.trim() : '';
  }

  function getCurrentContext() {
    const platform = getPlatform();
    const leadName = getLeadNameFromDom();
    const leadPhone = getLeadPhoneFromDom();

    if (platform === 'travel_flow') {
      const conversationId = getTravelFlowConversationId();
      return {
        platform,
        conversationId,
        sourceConversationId: conversationId,
        leadName,
        leadPhone,
        isValid: conversationId !== ''
      };
    }

    if (platform === 'whatsapp_web') {
      const sourceConversationId = leadPhone || (leadName ? `name_${simpleHash(leadName)}` : '');
      return {
        platform,
        conversationId: '',
        sourceConversationId,
        leadName,
        leadPhone,
        isValid: sourceConversationId !== ''
      };
    }

    return {
      platform: '',
      conversationId: '',
      sourceConversationId: '',
      leadName: '',
      leadPhone: '',
      isValid: false
    };
  }

  function getContextKey(context = getCurrentContext()) {
    if (context.platform === 'travel_flow' && context.conversationId) {
      return `travel_flow:${context.conversationId}`;
    }
    if (context.leadPhone) return `${context.platform}:phone:${context.leadPhone}`;
    if (context.sourceConversationId) return `${context.platform}:source:${context.sourceConversationId}`;
    return '';
  }

  function hasValidConversation() {
    return getCurrentContext().isValid;
  }

  function getPanel()                  { return document.getElementById(PANEL_ID); }
  function getToggle()                 { return document.getElementById(TOGGLE_ID); }
  function getConversationIdDisplay()  { return document.getElementById('tfq-conversation-id'); }
  function getStatus()                 { return document.getElementById('tfq-status'); }
  function getNegociosDropdown()       { return document.getElementById('tfq-negocios-dropdown'); }
  function getFormTitle()              { return document.getElementById('tfq-form-title'); }
  function getEditingBadge()           { return document.getElementById('tfq-editing-badge'); }
  function getRestoreBtn()             { return document.getElementById('tfq-restore'); }
  function getEditNegocioBtn()         { return document.getElementById('tfq-edit-negocio'); }
  function getCancelNegocioBtn()       { return document.getElementById('tfq-cancel'); }
  function getNegocioFormGrid()        { return document.getElementById('tfq-negocio-form-grid'); }

  function setStatus(message, type) {
    const el = getStatus();
    if (!el) return;
    el.textContent = message || '';
    el.className   = type ? type : '';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#039;');
  }

  function createField(field) {
    const fieldKey = escapeHtml(field.key);
    const fieldLabel = escapeHtml(field.label || field.key);
    const autoHint = field.auto
      ? '<span class="tfq-auto-hint" title="Preenchido automaticamente">⚡</span>'
      : '';

    const lockedAttr = isNegocioFieldLocked() ? ' disabled' : '';

    if (field.type === 'select') {
      const options = Array.isArray(field.options) ? field.options : [''];
      return `
        <div class="tfq-row">
          <label class="tfq-label" for="tfq-${fieldKey}">${fieldLabel}${autoHint}</label>
          <select class="tfq-select" id="tfq-${fieldKey}"${lockedAttr}>
            ${options.map(option =>
              `<option value="${escapeHtml(option)}">${escapeHtml(option || 'Selecione')}</option>`
            ).join('')}
          </select>
        </div>
      `;
    }

    if (field.type === 'textarea') {
      return `
        <div class="tfq-row">
          <label class="tfq-label" for="tfq-${fieldKey}">${fieldLabel}${autoHint}</label>
          <textarea class="tfq-textarea" id="tfq-${fieldKey}" rows="4"${lockedAttr}></textarea>
        </div>
      `;
    }

    const inputType = field.type === 'date'
      ? 'date'
      : 'text';
    const inputMode = ['currency', 'number'].includes(field.type) ? ' inputmode="decimal"' : '';
    const placeholder = field.type === 'currency' ? ' placeholder="R$ 0,00"' : '';

    return `
      <div class="tfq-row">
        <label class="tfq-label" for="tfq-${fieldKey}">${fieldLabel}${autoHint}</label>
        <input class="tfq-input" id="tfq-${fieldKey}" type="${inputType}"${inputMode}${placeholder}${lockedAttr} />
      </div>
    `;
  }

  async function loadFormFields() {
    if (!isConfigured()) {
      fields = [...defaultFields];
      formFieldsLoadedFromServer = false;
      formFieldsLoadError = '';
      return;
    }

    try {
      const result = await fetchJson(`${API_BASE}/get_form_fields.php?_t=${Date.now()}`, {
        headers: apiHeaders()
      });

      if (!result.success || !Array.isArray(result.fields) || result.fields.length === 0) {
        throw new Error(result.message || 'Erro ao buscar campos do formulário.');
      }

      fields = result.fields.filter(field => !isInternalField(field));
      formFieldsLoadedFromServer = true;
      formFieldsLoadError = '';
    } catch (error) {
      fields = [...defaultFields];
      formFieldsLoadedFromServer = false;
      formFieldsLoadError = error.message || 'Erro ao carregar campos.';
    }
  }

  function renderFormFields() {
    const grid = getNegocioFormGrid();
    if (!grid) return;
    grid.innerHTML = fields.map(createField).join('');
    autoFillLeadName();
    autoFillLeadPhone();
    reapplyNegocioFieldLock();
  }

  function applyFieldOrderToForm(orderedFieldNames) {
    const currentData = getFormData();
    const ordered = [];

    orderedFieldNames.forEach(name => {
      const field = fields.find(item => item.key === name);
      if (field) ordered.push(field);
    });

    fields.forEach(field => {
      if (!ordered.find(item => item.key === field.key)) ordered.push(field);
    });

    fields = ordered;
    renderFormFields();
    fillForm(currentData);
  }

  // ✅ CORRIGIDO: getElementById com template literal correta
  function clearForm() {
    fields.forEach(field => {
      const el = document.getElementById(`tfq-${field.key}`);
      if (el) el.value = '';
    });
    autoFillLeadName();
    autoFillLeadPhone();
  }

  function autoFillLeadName() {
    const el = document.getElementById('tfq-nome_lead');
    if (el && el.value === '') {
      const name = getLeadNameFromDom();
      if (name) el.value = name;
    }
  }

  function autoFillLeadPhone() {
    const el = document.getElementById('tfq-lead_phone');
    if (el && el.value === '') {
      const phone = getLeadPhoneFromDom();
      if (phone) el.value = phone;
    }
  }

  function getFormLeadPhoneValue() {
    const el = document.getElementById('tfq-lead_phone');
    return normalizePhone(el ? el.value : '');
  }

  function getLeadContextPayload() {
    const context = getCurrentContext();
    const leadPhone = context.leadPhone || getFormLeadPhoneValue();

    return {
      conversation_id:        context.conversationId,
      source_platform:        context.platform,
      source_conversation_id: context.sourceConversationId,
      lead_name:              context.leadName || getLeadNameFromDom(),
      lead_phone:             leadPhone
    };
  }

  function appendLeadContextParams(params, context = getCurrentContext()) {
    const lookupPhone = context.leadPhone || getFormLeadPhoneValue();

    params.set('source_platform', context.platform);
    if (context.conversationId) params.set('conversation_id', context.conversationId);
    if (lookupPhone) params.set('lead_phone', lookupPhone);
    if (context.sourceConversationId) params.set('source_conversation_id', context.sourceConversationId);
    if (context.platform === 'whatsapp_web' && !lookupPhone && context.leadName) {
      params.set('lead_name', context.leadName);
    }
  }

  // ✅ CORRIGIDO: getElementById com template literal correta
  function fillForm(data) {
    clearForm();
    if (!data) {
      reapplyNegocioFieldLock();
      return;
    }
    fields.forEach(field => {
      const el = document.getElementById(`tfq-${field.key}`);
      if (el && data[field.key] != null) {
        el.value = data[field.key];
      }
    });
    autoFillLeadName();
    autoFillLeadPhone();
    reapplyNegocioFieldLock();
  }

  // ✅ CORRIGIDO: getElementById com template literal correta
  function getFormData() {
    const context = getCurrentContext();
    const data = {
      id:                     editingId || 0,
      conversation_id:        context.conversationId,
      source_platform:        context.platform,
      source_conversation_id: context.sourceConversationId
    };
    fields.forEach(field => {
      const el = document.getElementById(`tfq-${field.key}`);
      data[field.key] = el ? el.value.trim() : '';
    });
    if (!data.lead_phone && context.leadPhone) {
      data.lead_phone = context.leadPhone;
    }
    if (!data.nome_lead && context.leadName) {
      data.nome_lead = context.leadName;
    }
    return data;
  }

  function getFormSignature() {
    const data = {};
    fields.forEach(field => {
      const el = document.getElementById(`tfq-${field.key}`);
      data[field.key] = el ? el.value.trim() : '';
    });
    return JSON.stringify(data);
  }

  function markFormPristine() {
    lastFormSignature = getFormSignature();
  }

  function hasUnsavedChanges() {
    const panel = getPanel();
    if (!panel || !panel.classList.contains('tfq-open') || !lastFormSignature) return false;
    return getFormSignature() !== lastFormSignature;
  }

  function confirmDiscardChanges(message = 'Há alterações não salvas neste negócio. Deseja descartá-las?') {
    return !hasUnsavedChanges() || window.confirm(message);
  }

  function isNegocioFieldLocked() {
    return negocioLoadingLocked || (editingId > 0 && !businessEditUnlocked);
  }

  function setNegocioFieldsReadonly(readonly) {
    const locked = Boolean(readonly);
    const grid = getNegocioFormGrid();
    if (grid) {
      grid.classList.toggle('tfq-negocio-form-locked', locked);
      grid.querySelectorAll('input, select, textarea').forEach(el => {
        el.disabled = locked;
        el.readOnly = locked;
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
      });
      return;
    }

    fields.forEach(field => {
      const el = document.getElementById(`tfq-${field.key}`);
      if (el) {
        el.disabled = locked;
        el.readOnly = locked;
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
      }
    });
  }

  function reapplyNegocioFieldLock() {
    setNegocioFieldsReadonly(isNegocioFieldLocked());
  }

  function beginNegocioLoadingState(message = 'Carregando negócio...') {
    negocioViewMode = 'loading';
    businessEditUnlocked = false;
    negocioLoadingLocked = true;
    clearForm();
    if (getFormTitle()) getFormTitle().textContent = 'Carregando Negócio';
    if (getEditingBadge()) getEditingBadge().textContent = '';
    const editBtn = getEditNegocioBtn();
    if (editBtn) editBtn.classList.add('tfq-hidden');
    const saveBtn = document.getElementById('tfq-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.title = message;
    }
    const deleteBtn = document.getElementById('tfq-delete');
    if (deleteBtn) deleteBtn.disabled = true;
    const cancelBtn = getCancelNegocioBtn();
    if (cancelBtn) {
      cancelBtn.textContent = 'Limpar';
      cancelBtn.title = message;
    }
    reapplyNegocioFieldLock();
  }

  function forceCurrentNegocioViewMode() {
    if (editingId <= 0) {
      reapplyNegocioFieldLock();
      return;
    }

    const item = negociosCache.find(n => Number(n.id) === Number(editingId));
    if (item) {
      setEditingState(editingId, item, 'view');
      const dropdown = getNegociosDropdown();
      if (dropdown) dropdown.value = String(editingId);
      return;
    }

    negocioLoadingLocked = false;
    negocioViewMode = 'view';
    businessEditUnlocked = false;
    reapplyNegocioFieldLock();
  }

  function scheduleCurrentNegocioViewModeLock() {
    [0, 80, 250, 600].forEach(delay => {
      window.setTimeout(forceCurrentNegocioViewMode, delay);
    });
  }

  function isNegocioFormControl(target) {
    return Boolean(target && target.closest && target.closest('#tfq-negocio-form-grid input, #tfq-negocio-form-grid select, #tfq-negocio-form-grid textarea'));
  }

  function blockLockedNegocioEditEvent(event) {
    if (!isNegocioFieldLocked() || !isNegocioFormControl(event.target)) return;
    if (event.type === 'keydown' && event.key === 'Tab') return;

    event.preventDefault();
    event.stopPropagation();
    reapplyNegocioFieldLock();
    setStatus('Clique em Editar para alterar este negócio.', 'error');
  }

  function installNegocioEditGuard(panel) {
    ['beforeinput', 'input', 'change', 'paste', 'cut', 'drop', 'keydown'].forEach(type => {
      panel.addEventListener(type, blockLockedNegocioEditEvent, true);
    });
  }

  function applyNegocioMode(item = null) {
    const saveBtn = document.getElementById('tfq-save');
    const deleteBtn = document.getElementById('tfq-delete');
    const restoreBtn = getRestoreBtn();
    const editBtn = getEditNegocioBtn();
    const cancelBtn = getCancelNegocioBtn();
    const canDelete = canDeleteNegocio();
    const isDeleted = Boolean(item && hasDeletedAtValue(item.deleted_at));
    const isExisting = editingId > 0 && item;
    const isViewing = negocioViewMode === 'view';
    const isEditing = negocioViewMode === 'edit' && businessEditUnlocked;

    setNegocioFieldsReadonly(isDeleted || isNegocioFieldLocked());

    if (editBtn) {
      editBtn.classList.toggle('tfq-hidden', !isExisting || isDeleted || isEditing);
      editBtn.disabled = !canEdit();
      editBtn.title = canEdit() ? 'Editar negócio' : 'Seu usuário não tem permissão para editar negócios';
    }

    if (saveBtn) {
      saveBtn.disabled = isDeleted || isViewing || !canEdit();
      saveBtn.textContent = isExisting ? 'Salvar alterações' : 'Salvar';
      saveBtn.title = isViewing
        ? 'Clique em Editar para alterar este negócio'
        : (isDeleted ? 'Restaure o negócio antes de editar' : (canEdit() ? 'Salvar negócio' : 'Seu usuário não tem permissão para salvar negócios'));
    }

    if (cancelBtn) {
      cancelBtn.textContent = isExisting && isEditing ? 'Cancelar' : 'Limpar';
      cancelBtn.title = isExisting && isEditing
        ? 'Cancelar edição e voltar para visualização'
        : 'Limpar formulário';
    }

    if (deleteBtn) {
      deleteBtn.disabled = !canDelete || !isExisting || isDeleted || isViewing;
      deleteBtn.title = isViewing
        ? 'Clique em Editar para excluir este negócio'
        : (isDeleted ? 'Negócio já está na lixeira' : (canDelete ? 'Excluir negócio' : 'Somente administradores podem excluir negócios'));
    }

    if (restoreBtn) {
      restoreBtn.disabled = !canDelete || !isDeleted;
      restoreBtn.classList.toggle('tfq-hidden', !isDeleted);
      restoreBtn.title = canDelete ? 'Restaurar negócio' : 'Somente administradores podem restaurar negócios';
    }
  }

  function setEditingState(id, item, mode = null) {
    editingId = id || 0;
    const isDeleted = Boolean(item && hasDeletedAtValue(item.deleted_at));

    if (editingId > 0 && item) {
      negocioLoadingLocked = false;
      negocioViewMode = mode === 'edit' ? 'edit' : 'view';
      businessEditUnlocked = negocioViewMode === 'edit';
      fillForm(item);
      if (getFormTitle()) {
        getFormTitle().textContent = isDeleted
          ? 'Negócio excluído'
          : (negocioViewMode === 'edit' ? 'Editando Negócio' : 'Mostrando Negócio');
      }
      if (getEditingBadge()) getEditingBadge().textContent = isDeleted ? `ID #${editingId} - na lixeira` : `ID #${editingId}`;
      applyNegocioMode(item);
    } else {
      negocioLoadingLocked = false;
      negocioViewMode = 'create';
      businessEditUnlocked = false;
      clearForm();
      if (getFormTitle())    getFormTitle().textContent    = 'Novo negócio';
      if (getEditingBadge()) getEditingBadge().textContent = '';
      applyNegocioMode(null);
    }
    markFormPristine();
  }

  function editSelectedNegocio() {
    if (!editingId) return;
    const item = negociosCache.find(n => Number(n.id) === Number(editingId));
    if (!item) return;
    setEditingState(editingId, item, 'edit');
    setStatus('Edição liberada para este negócio.', '');
  }

  function cancelNegocioEdit() {
    if (editingId > 0 && businessEditUnlocked) {
      const item = negociosCache.find(n => Number(n.id) === Number(editingId));
      if (item) {
        setEditingState(editingId, item, 'view');
        setStatus('Edição cancelada. Negócio voltou para visualização.', '');
        return;
      }
    }

    if (!confirmDiscardChanges()) return;
    setEditingState(0);
    const dd = getNegociosDropdown();
    if (dd) dd.value = '';
    setStatus('Formulário limpo.', '');
  }

  function updateConversationIdUI() {
    const el = getConversationIdDisplay();
    if (!el) return;

    const context = getCurrentContext();
    if (!context.isValid) {
      el.textContent = 'Não encontrado';
      return;
    }

    const platformLabel = context.platform === 'whatsapp_web' ? 'WhatsApp Web' : 'Travel Flow';
    const identifier = context.leadPhone || context.conversationId || context.sourceConversationId;
    el.textContent = `${platformLabel}: ${identifier}`;
  }

  /**
   * Atualiza o título h2 do painel com o nome do lead lido do DOM.
   *
   * O Travel Flow é um SPA e pode demorar alguns ms para atualizar o elemento
   * h3.font-semibold:not(.truncate) após a troca de conversa. Por isso, tenta ler o nome
   * em até 5 tentativas com intervalos crescentes (100ms, 300ms, 600ms, 1000ms, 1500ms)
   * antes de desistir e exibir o texto genérico.
   *
   * @param {string} [knownName] - Nome já conhecido (vindo do page-bridge.js).
   *                               Se fornecido, atualiza imediatamente sem retentativas.
   */
  function updatePanelTitle(knownName) {
    const titleEl = document.getElementById('tfq-title');
    if (!titleEl) return;

    // Se o nome já foi capturado pelo page-bridge, usa diretamente
    if (knownName) {
      titleEl.textContent = knownName;
      return;
    }

    // Tenta ler do DOM com retentativas para aguardar o SPA atualizar
    const delays = [0, 100, 300, 600, 1000, 1500];
    let attempt  = 0;

    function tryUpdate() {
      const name = getLeadNameFromDom();

      if (name) {
        titleEl.textContent = name;
        return;
      }

      attempt++;
      if (attempt < delays.length) {
        setTimeout(tryUpdate, delays[attempt]);
      } else {
        // Todas as tentativas falharam — mantém genérico
        titleEl.textContent = 'Negócios do Lead';
      }
    }

    tryUpdate();
  }

  function renderNegociosDropdown() {
    const dropdown = getNegociosDropdown();
    if (!dropdown) return;

    const options = ['<option value="">-- Novo negócio --</option>'];
    negociosCache.forEach(item => {
      const deletedPrefix = hasDeletedAtValue(item.deleted_at) ? '[Excluído] ' : '';
      const label = `${deletedPrefix}#${item.id} - ${item.destino || item.nome_lead || 'Sem destino'}`;
      options.push(`<option value="${item.id}">${escapeHtml(label)}</option>`);
    });
    dropdown.innerHTML = options.join('');
    dropdown.value = editingId > 0 ? editingId : '';
  }

  function onNegocioSelected() {
    const dropdown = getNegociosDropdown();
    if (!dropdown) return;

    if (!confirmDiscardChanges('Há alterações não salvas. Deseja trocar de negócio e descartá-las?')) {
      dropdown.value = editingId > 0 ? String(editingId) : '';
      return;
    }

    const selectedId = Number(dropdown.value);
    if (selectedId > 0) {
      const item = negociosCache.find(n => Number(n.id) === selectedId);
      if (item) {
        setEditingState(selectedId, item, 'view');
        setStatus('Negócio selecionado para visualização.', '');
      }
    } else {
      setEditingState(0);
      setStatus('Pronto para criar um novo negócio.', '');
    }
  }

  function shouldIncludeDeletedNegocios() {
    const checkbox = document.getElementById('tfq-include-deleted');
    return (canDeleteNegocio() || canRestoreNegocio()) && Boolean(checkbox && checkbox.checked);
  }

  async function fetchNegociosForContext(context) {
    const params = new URLSearchParams({
      _t: Date.now().toString()
    });
    appendLeadContextParams(params, context);
    if (shouldIncludeDeletedNegocios()) {
      params.set('include_deleted', '1');
    }

    const result = await fetchJson(
      `${API_BASE}/get_negocios.php?${params.toString()}`,
      { headers: apiHeaders() }
    );

    if (!result.success) {
      throw new Error(result.message || 'Erro ao buscar negócios.');
    }

    return Array.isArray(result.data) ? result.data : [];
  }

  async function syncLeadIdentityForNegocios(context, items) {
    if (!canEdit() || context.platform !== 'travel_flow' || !context.leadPhone || !Array.isArray(items)) {
      return { updated: 0, error: '' };
    }

    const missingPhone = items.some(item => normalizePhone(item.lead_phone) === '');
    if (!missingPhone) {
      return { updated: 0, error: '' };
    }

    try {
      const result = await fetchJson(`${API_BASE}/sync_lead_identity.php`, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(getLeadContextPayload())
      });

      return {
        updated: Number(result.updated || 0),
        error: ''
      };
    } catch (error) {
      return {
        updated: 0,
        error: `Telefone detectado, mas não consegui sincronizar automaticamente: ${error.message}`
      };
    }
  }

  /**
   * Busca todos os negócios do contexto atual na API e atualiza o cache.
   *
   * @param {boolean} force      - Se true, ignora cache e recarrega do servidor.
   * @param {boolean} autoSelect - Se true, seleciona automaticamente o negócio
   *                               ativo de maior ID ao terminar de carregar.
   *                               Deve ser true apenas em trocas de conversa,
   *                               não em recarregamentos manuais ou pós-salvar.
   */
  async function loadNegocios(force = false, autoSelect = false) {
    const context = getCurrentContext();
    const contextKey = getContextKey(context);
    updateConversationIdUI();
    updatePanelTitle();

    if (autoSelect) {
      beginNegocioLoadingState();
    }

    if (!context.isValid) {
      negociosRequestSeq++;
      currentConversationId = '';
      negociosCache         = [];
      renderNegociosDropdown();
      setEditingState(0);
      setStatus('Aguardando seleção de conversa...', '');
      return;
    }

    if (!force && contextKey === currentConversationId && negociosCache.length) {
      renderNegociosDropdown();
      const active = editingId > 0 ? negociosCache.find(item => Number(item.id) === Number(editingId)) : null;
      if (active) setEditingState(Number(active.id), active, 'view');
      return;
    }

    currentConversationId = contextKey;
    const requestSeq = ++negociosRequestSeq;
    const isCurrentRequest = () => requestSeq === negociosRequestSeq && getContextKey() === contextKey;
    setStatus('Carregando negócios...', '');

    try {
      negociosCache = await fetchNegociosForContext(context);
      if (!isCurrentRequest()) return;
      const syncResult = await syncLeadIdentityForNegocios(context, negociosCache);
      if (!isCurrentRequest()) return;
      if (syncResult.updated > 0) {
        negociosCache = await fetchNegociosForContext(context);
        if (!isCurrentRequest()) return;
      }

      renderNegociosDropdown();
      renderTaskNegocioOptions();

      const selectLatestActive = () => {
        const latestActive = negociosCache
          .filter(item => !hasDeletedAtValue(item.deleted_at))
          .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
        if (!latestActive) {
          setEditingState(0);
          return false;
        }

        const latestId = Number(latestActive.id);
        setEditingState(latestId, latestActive, 'view');
        const dropdown = getNegociosDropdown();
        if (dropdown) dropdown.value = String(latestId);
        return true;
      };

      if (autoSelect) {
        // Troca de conversa: nunca reaproveita modo de edição da conversa anterior.
        selectLatestActive();
        scheduleCurrentNegocioViewModeLock();
      } else if (editingId > 0) {
        // Qualquer carga vinda do servidor volta para visualização.
        // Edição só é liberada por clique explícito em Editar.
        const active = negociosCache.find(item => Number(item.id) === editingId);
        if (active) {
          setEditingState(Number(active.id), active, 'view');
          const dropdown = getNegociosDropdown();
          if (dropdown) dropdown.value = String(active.id);
        } else {
          setEditingState(0);
        }
      } else {
        // Recarregamento manual, pós-salvar sem ID ou sem negócios: formulário limpo
        clearForm();
        markFormPristine();
      }

      const count = negociosCache.length;
      if (syncResult.error) {
        setStatus(syncResult.error, 'error');
      } else {
        const syncSuffix = syncResult.updated > 0 ? ` Telefone sincronizado em ${syncResult.updated} negócio(s).` : '';
        setStatus(
          count > 0 ? `${count} negócio(s) encontrado(s).${syncSuffix}` : 'Nenhum negócio salvo ainda.',
          'success'
        );
      }

    } catch (error) {
      if (!isCurrentRequest()) return;
      negociosCache = [];
      renderNegociosDropdown();
      setStatus(`Erro ao carregar: ${error.message}`, 'error');
    }
  }

  async function saveNegocio() {
    if (editingId > 0 && !businessEditUnlocked) {
      setStatus('Clique em Editar antes de alterar este negócio.', 'error');
      return;
    }

    const payload = getFormData();

    if (!canEdit()) {
      setStatus('Seu usuário não tem permissão para salvar negócios.', 'error');
      return;
    }
    if (!getCurrentContext().isValid) {
      setStatus('Selecione uma conversa primeiro.', 'error');
      return;
    }
    if (!formFieldsLoadedFromServer) {
      const details = formFieldsLoadError ? ` Detalhe: ${formFieldsLoadError}` : '';
      setStatus(`Não salvei para evitar perda de campos personalizados. Recarregue os campos ou verifique o servidor.${details}`, 'error');
      return;
    }
    if (!payload.nome_lead) {
      setStatus('Preencha o nome do lead.', 'error');
      return;
    }

    const saveBtn = document.getElementById('tfq-save');
    if (saveBtn) saveBtn.disabled = true;

    try {
      setStatus(editingId > 0 ? 'Atualizando negócio...' : 'Salvando negócio...', '');

      const result = await fetchJson(`${API_BASE}/save_negocio.php`, {
        method:  'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify(payload)
      });

      if (!result.success) {
        throw new Error(result.message || 'Erro ao salvar negócio.');
      }

      const savedId = Number(result.id || payload.id || 0);

      negociosCache         = [];
      currentConversationId = '';

      await new Promise(resolve => setTimeout(resolve, 100));
      await loadNegocios(true);

      if (savedId > 0) {
        const active = negociosCache.find(item => Number(item.id) === savedId);
        if (active) {
          setEditingState(savedId, active, 'view');
        } else {
          setEditingState(0);
        }
      }
      markFormPristine();

      setStatus(result.message || 'Negócio salvo com sucesso.', 'success');

    } catch (error) {
      setStatus(`Erro ao salvar: ${error.message}`, 'error');
    } finally {
      const active = editingId > 0 ? negociosCache.find(item => Number(item.id) === Number(editingId)) : null;
      applyNegocioMode(active || null);
    }
  }

  async function deleteNegocio() {
    const context = getCurrentContext();
    const leadPhone = context.leadPhone || getFormLeadPhoneValue();
    if (!canDeleteNegocio()) {
      setStatus('Seu usuário não tem permissão para excluir negócios.', 'error');
      return;
    }
    if (!editingId || !context.isValid) {
      setStatus('Selecione um negócio para excluir.', 'error');
      return;
    }
    if (!businessEditUnlocked) {
      setStatus('Clique em Editar antes de excluir este negócio.', 'error');
      return;
    }

    const ok = window.confirm('Deseja excluir este negócio?');
    if (!ok) return;

    try {
      setStatus('Excluindo negócio...', '');

      const payload = {
        id:                     editingId,
        conversation_id:        context.conversationId,
        lead_phone:             leadPhone,
        source_platform:        context.platform,
        source_conversation_id: context.sourceConversationId
      };
      const request = body => fetchJson(`${API_BASE}/delete_negocio.php`, {
        method:  'POST',
        headers: adminApiHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify(body)
      });
      let result;

      try {
        result = await request(payload);
      } catch (error) {
        if (!error.payload || !error.payload.requires_force) throw error;
        const forceOk = window.confirm(`${error.message}\n\nDeseja continuar mesmo assim?`);
        if (!forceOk) {
          setStatus('Exclusão cancelada.', '');
          return;
        }
        result = await request({ ...payload, force_by_id: true });
      }

      if (!result.success) {
        throw new Error(result.message || 'Erro ao excluir negócio.');
      }

      setEditingState(0);
      negociosCache         = [];
      currentConversationId = '';

      await new Promise(resolve => setTimeout(resolve, 100));
      await loadNegocios(true, true);

      setStatus(result.message || 'Negócio excluído com sucesso.', 'success');

    } catch (error) {
      setStatus(`Erro ao excluir: ${error.message}`, 'error');
    }
  }

  async function restoreNegocio() {
    const context = getCurrentContext();
    const leadPhone = context.leadPhone || getFormLeadPhoneValue();

    if (!canRestoreNegocio()) {
      setStatus('Seu usuário não tem permissão para restaurar negócios.', 'error');
      return;
    }
    if (!editingId || !context.isValid) {
      setStatus('Selecione um negócio excluído para restaurar.', 'error');
      return;
    }

    const ok = window.confirm('Deseja restaurar este negócio?');
    if (!ok) return;

    try {
      setStatus('Restaurando negócio...', '');

      const payload = {
        id: editingId,
        conversation_id: context.conversationId,
        lead_phone: leadPhone,
        source_platform: context.platform,
        source_conversation_id: context.sourceConversationId
      };
      const request = body => fetchJson(`${API_BASE}/restore_negocio.php`, {
        method: 'POST',
        headers: adminApiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      });
      let result;

      try {
        result = await request(payload);
      } catch (error) {
        if (!error.payload || !error.payload.requires_force) throw error;
        const forceOk = window.confirm(`${error.message}\n\nDeseja continuar mesmo assim?`);
        if (!forceOk) {
          setStatus('Restauração cancelada.', '');
          return;
        }
        result = await request({ ...payload, force_by_id: true });
      }

      setEditingState(0);
      negociosCache = [];
      currentConversationId = '';

      await new Promise(resolve => setTimeout(resolve, 100));
      await loadNegocios(true);

      setStatus(result.message || 'Negócio restaurado com sucesso.', 'success');
    } catch (error) {
      setStatus(`Erro ao restaurar: ${error.message}`, 'error');
    }
  }

  function removePanel() {
    const panel  = getPanel();
    const toggle = getToggle();
    if (panel)  panel.remove();
    if (toggle) toggle.remove();

    panelInitialized      = false;
    currentConversationId = '';
    negociosCache         = [];
    tasksCache            = [];
    taskOverviewCache     = [];
    editingId             = 0;
    negocioViewMode       = 'create';
    businessEditUnlocked  = false;
    negocioLoadingLocked  = false;
    editingTaskId         = 0;
    lastFormSignature     = '';
  }

  function rebuildOpenPanelForConversation(contextKey) {
    if (!contextKey) return false;

    const panel = getPanel();
    if (!panel || !panel.classList.contains('tfq-open')) return false;
    if (panelRebuildContextKey === contextKey) return true;

    panelRebuildContextKey = contextKey;
    if (panelRebuildTimer) window.clearTimeout(panelRebuildTimer);

    panel.classList.remove('tfq-open');
    const toggle = getToggle();
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    lastCheckedConversationId = contextKey;

    const closeDelay = Math.max(0, panelSettings.slideMs);
    const rebuildDelay = Math.max(0, panelSettings.rebuildDelayMs);
    panelRebuildTimer = window.setTimeout(() => {
      panelRebuildTimer = null;
      removePanel();

      if (getContextKey() !== contextKey || !hasValidConversation()) {
        panelRebuildContextKey = '';
        return;
      }

      renderPanel();
      const nextToggle = getToggle();
      const nextPanel = getPanel();
      if (nextToggle && nextPanel && !nextPanel.classList.contains('tfq-open')) {
        nextToggle.click();
      }
    }, closeDelay + rebuildDelay);

    return true;
  }


  async function loadFields() {
    const statusEl = document.getElementById('tfq-fields-status');
    if (statusEl) { statusEl.textContent = 'Carregando campos...'; statusEl.className = ''; }

    try {
      const result = await fetchJson(`${API_BASE}/get_fields.php?_t=${Date.now()}`, {
        headers: adminHeaders()
      });

      const dbFields = Array.isArray(result.fields) ? result.fields : [];
      await renderFieldsList(dbFields);
      if (statusEl) { statusEl.textContent = `${dbFields.length} campo(s) encontrado(s).`; statusEl.className = 'success'; }

    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  function fieldOptionsToText(options) {
    return Array.isArray(options) ? options.filter(option => option !== '').join('\n') : '';
  }

  function collectFieldConfigsFromList(container, orderedFields) {
    return orderedFields.map(field => {
      const name = field.name;
      const labelInput = container.querySelector(`.tfq-field-label-input[data-name="${name}"]`);
      const typeSelect = container.querySelector(`.tfq-field-type-select[data-name="${name}"]`);
      const optionsInput = container.querySelector(`.tfq-field-options-input[data-name="${name}"]`);
      const type = typeSelect ? typeSelect.value : field.type || 'text';
      const options = optionsInput
        ? optionsInput.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
        : [];

      if (type === 'select') {
        options.unshift('');
      }

      return {
        name,
        label: labelInput ? labelInput.value.trim() : field.label || name,
        type,
        options: type === 'select' ? options : []
      };
    });
  }

  async function saveFieldConfigs(configs) {
    const result = await fetchJson(`${API_BASE}/save_field_config.php`, {
      method:  'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({ fields: configs })
    });
    return result;
  }

  async function renderFieldsList(fieldsList) {
    const container = document.getElementById('tfq-fields-list');
    if (!container) return;

    if (fieldsList.length === 0) {
      container.innerHTML = '<div class="tfq-empty">Nenhum campo encontrado.</div>';
      return;
    }

    container.innerHTML = fieldsList.map((field, index) => {
      const label     = field.label || field.name;
      const isFirst   = index === 0;
      const isLast    = index === fieldsList.length - 1;
      const removable = field.removable;
      const type      = field.type || 'text';
      const optionsText = fieldOptionsToText(field.options);

      return `
        <div class="tfq-field-item" data-name="${escapeHtml(field.name)}" data-index="${index}">
          <div class="tfq-field-item-left">
            <div class="tfq-field-order-btns">
              <button class="tfq-mini-btn tfq-field-up"   data-index="${index}" ${isFirst ? 'disabled' : ''} title="Mover para cima">↑</button>
              <button class="tfq-mini-btn tfq-field-down" data-index="${index}" ${isLast  ? 'disabled' : ''} title="Mover para baixo">↓</button>
            </div>
            <div class="tfq-field-info">
              <input class="tfq-field-label-input" data-name="${escapeHtml(field.name)}" value="${escapeHtml(label)}" type="text" placeholder="Rótulo do campo" />
              <span class="tfq-field-key">${escapeHtml(field.name)}${field.is_default ? ' <em>padrão</em>' : ''}</span>
              <select class="tfq-field-type-select" data-name="${escapeHtml(field.name)}">
                <option value="text" ${type === 'text' ? 'selected' : ''}>Texto</option>
                <option value="textarea" ${type === 'textarea' ? 'selected' : ''}>Texto longo</option>
                <option value="select" ${type === 'select' ? 'selected' : ''}>Lista</option>
                <option value="date" ${type === 'date' ? 'selected' : ''}>Data</option>
                <option value="number" ${type === 'number' ? 'selected' : ''}>Número</option>
                <option value="currency" ${type === 'currency' ? 'selected' : ''}>Valor</option>
              </select>
              <textarea class="tfq-field-options-input ${type === 'select' ? '' : 'tfq-hidden'}" data-name="${escapeHtml(field.name)}" rows="3" placeholder="Uma opção por linha">${escapeHtml(optionsText)}</textarea>
            </div>
          </div>
          <div class="tfq-item-actions">
            <button class="tfq-mini-btn tfq-field-save-config" data-name="${escapeHtml(field.name)}" title="Salvar configuração">✓</button>
            ${removable
              ? `<button class="tfq-mini-btn tfq-mini-btn-danger tfq-field-remove" data-name="${escapeHtml(field.name)}" title="Remover campo">✕</button>`
              : ''}
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.tfq-field-up').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.index);
        if (idx <= 0) return;
        const reordered = [...fieldsList];
        [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
        await persistFieldConfig(container, reordered);
        await renderFieldsList(reordered);
        applyFieldOrderToForm(reordered.map(field => field.name));
      });
    });

    container.querySelectorAll('.tfq-field-down').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.index);
        if (idx >= fieldsList.length - 1) return;
        const reordered = [...fieldsList];
        [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
        await persistFieldConfig(container, reordered);
        await renderFieldsList(reordered);
        applyFieldOrderToForm(reordered.map(field => field.name));
      });
    });

    container.querySelectorAll('.tfq-field-type-select').forEach(select => {
      select.addEventListener('change', () => {
        const optionsInput = container.querySelector(`.tfq-field-options-input[data-name="${select.dataset.name}"]`);
        if (!optionsInput) return;
        optionsInput.classList.toggle('tfq-hidden', select.value !== 'select');
      });
    });

    container.querySelectorAll('.tfq-field-save-config').forEach(btn => {
      btn.addEventListener('click', async () => {
        const statusEl = document.getElementById('tfq-fields-status');
        try {
          if (statusEl) { statusEl.textContent = 'Salvando configuração...'; statusEl.className = ''; }
          const currentData = getFormData();
          const wasDirty = hasUnsavedChanges();
          await persistFieldConfig(container, fieldsList);
          await loadFormFields();
          renderFormFields();
          fillForm(currentData);
          if (!wasDirty) markFormPristine();
          if (statusEl) { statusEl.textContent = 'Configuração salva.'; statusEl.className = 'success'; }
        } catch (error) {
          if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
        }
      });
    });

    container.querySelectorAll('.tfq-field-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        const ok   = window.confirm(`Remover o campo "${name}"?\n\nATENÇÃO: todos os dados armazenados neste campo serão apagados permanentemente.`);
        if (!ok) return;

        const statusEl = document.getElementById('tfq-fields-status');
        if (statusEl) { statusEl.textContent = 'Removendo campo...'; statusEl.className = ''; }

        try {
          const result = await fetchJson(`${API_BASE}/remove_field.php`, {
            method:  'POST',
            headers: adminHeaders({ 'Content-Type': 'application/json' }),
            body:    JSON.stringify({ field_name: name })
          });

          if (statusEl) { statusEl.textContent = result.message; statusEl.className = 'success'; }
          const currentData = getFormData();
          const wasDirty = hasUnsavedChanges();
          await loadFormFields();
          renderFormFields();
          fillForm(currentData);
          if (!wasDirty) markFormPristine();
          await loadFields();

        } catch (error) {
          if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
        }
      });
    });
  }

  async function persistFieldConfig(container, orderedFields) {
    const configs = collectFieldConfigsFromList(container, orderedFields);
    await saveFieldConfigs(configs);
  }

  async function addField() {
    const input        = document.getElementById('tfq-new-field-name');
    const labelInput   = document.getElementById('tfq-new-field-label');
    const typeInput    = document.getElementById('tfq-new-field-type');
    const optionsInput = document.getElementById('tfq-new-field-options');
    const statusEl     = document.getElementById('tfq-fields-status');
    const fieldName    = input ? input.value.trim().toLowerCase().replace(/\s+/g, '_') : '';
    const fieldLabel   = labelInput ? labelInput.value.trim() : '';
    const fieldType    = typeInput ? typeInput.value : 'text';
    const fieldOptions = optionsInput
      ? optionsInput.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      : [];

    if (!fieldName) {
      if (statusEl) { statusEl.textContent = 'Informe um nome para o campo.'; statusEl.className = 'error'; }
      return;
    }

    if (fieldType === 'select' && fieldOptions.length === 0) {
      if (statusEl) { statusEl.textContent = 'Informe ao menos uma opção para campos do tipo lista.'; statusEl.className = 'error'; }
      return;
    }

    const addBtn = document.getElementById('tfq-add-field-btn');
    if (addBtn) addBtn.disabled = true;

    try {
      if (statusEl) { statusEl.textContent = 'Adicionando campo...'; statusEl.className = ''; }

      const result = await fetchJson(`${API_BASE}/add_field.php`, {
        method:  'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({
          field_name:    fieldName,
          field_label:   fieldLabel,
          field_type:    fieldType,
          field_options: fieldOptions
        })
      });

      if (input) input.value = '';
      if (labelInput) labelInput.value = '';
      if (optionsInput) optionsInput.value = '';
      if (statusEl) { statusEl.textContent = result.message; statusEl.className = 'success'; }
      const currentData = getFormData();
      const wasDirty = hasUnsavedChanges();
      await loadFormFields();
      renderFormFields();
      fillForm(currentData);
      if (!wasDirty) markFormPristine();
      await loadFields();

    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    } finally {
      if (addBtn) addBtn.disabled = false;
    }
  }

  function roleLabel(role) {
    return {
      viewer: 'Viewer',
      editor: 'Editor',
      admin: 'Admin',
      owner: 'Owner'
    }[role] || role;
  }

  function getAllowedRoleOptions(selectedRole = 'editor') {
    const roles = ['viewer', 'editor'];

    return roles.map(role =>
      `<option value="${role}" ${role === selectedRole ? 'selected' : ''}>${roleLabel(role)}</option>`
    ).join('');
  }

  function updateUserRoleOptions() {
    const roleSelect = document.getElementById('tfq-new-user-role');
    if (roleSelect) roleSelect.innerHTML = getAllowedRoleOptions();
  }

  function manageablePermissionRoles() {
    return ['viewer', 'editor'];
  }

  function renderRolePermissionEditor() {
    const listEl = document.getElementById('tfq-role-permissions-list');
    if (!listEl) return;

    if (!canManageUsers()) {
      listEl.innerHTML = '<div class="tfq-empty">Seu usuário não tem permissão para alterar grupos.</div>';
      return;
    }

    const catalog = permissionCatalog.length ? permissionCatalog : [
      { key: 'negocio.view', label: 'Ver negócios' },
      { key: 'negocio.edit', label: 'Criar e editar negócios' },
      { key: 'admin.access', label: 'Admin: acessar aba' }
    ];

    listEl.innerHTML = manageablePermissionRoles().map(role => {
      const permissions = rolePermissionMap[role] || [];
      const disabled = !canManageUsers();
      return `
        <div class="tfq-permission-role-card" data-role="${escapeHtml(role)}">
          <div class="tfq-permission-role-head">
            <strong>${escapeHtml(roleLabel(role))}</strong>
            <button class="tfq-btn tfq-btn-primary tfq-save-role-permissions" data-role="${escapeHtml(role)}" type="button" ${disabled ? 'disabled' : ''}>Salvar permissões do grupo</button>
          </div>
          <div class="tfq-permission-grid">
            ${catalog.map(item => `
              <label class="tfq-permission-check" for="tfq-perm-${escapeHtml(role)}-${escapeHtml(item.key).replace(/\./g, '-')}">
                <input
                  id="tfq-perm-${escapeHtml(role)}-${escapeHtml(item.key).replace(/\./g, '-')}"
                  type="checkbox"
                  value="${escapeHtml(item.key)}"
                  ${permissions.includes(item.key) || permissions.includes('*') ? 'checked' : ''}
                  ${disabled ? 'disabled' : ''}
                />
                <span>${escapeHtml(item.label || item.key)}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.tfq-save-role-permissions').forEach(btn => {
      btn.addEventListener('click', () => saveRolePermissionsFromForm(btn.dataset.role || 'viewer'));
    });
  }

  async function saveRolePermissionsFromForm(role) {
    const statusEl = document.getElementById('tfq-role-permissions-status');
    const card = document.querySelector(`.tfq-permission-role-card[data-role="${role}"]`);
    if (!card) return;

    const permissions = [...card.querySelectorAll('input[type="checkbox"]')]
      .filter(input => input.checked)
      .map(input => input.value);

    try {
      if (statusEl) { statusEl.textContent = 'Salvando permissões do grupo...'; statusEl.className = ''; }
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'update_role_permissions', role, permissions })
      });
      rolePermissionMap = result.role_permissions || { ...rolePermissionMap, [role]: result.permissions || permissions };
      if (CURRENT_USER && CURRENT_USER.role === role) {
        CURRENT_USER.permissions = rolePermissionMap[role] || CURRENT_USER.permissions || [];
        await chrome.storage.local.set({ tfq_user: CURRENT_USER });
      }
      renderRolePermissionEditor();
      applyAdminSectionPermissions();
      if (statusEl) { statusEl.textContent = result.message || 'Permissões atualizadas.'; statusEl.className = 'success'; }
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  function getAdminEditPermission(viewPermission) {
    return {
      'admin.appearance.view': 'admin.appearance.edit',
      'admin.window.view': 'admin.window.edit',
      'admin.notifications.view': 'admin.notifications.edit',
      'admin.fields.view': 'admin.fields.edit',
      'admin.users.view': 'admin.users.edit',
      'admin.audit.view': 'admin.backup.edit'
    }[viewPermission] || viewPermission;
  }

  function applyAdminSectionPermissions() {
    const tabAdmin = document.querySelector(`#${PANEL_ID} .tfq-tab[data-tab="usuarios"]`);
    if (tabAdmin) {
      tabAdmin.classList.toggle('tfq-hidden', !canAccessAdmin());
    }

    document.querySelectorAll(`#${PANEL_ID} [data-admin-permission]`).forEach(section => {
      const permission = section.getAttribute('data-admin-permission') || '';
      const canView = hasPermission(permission, 'admin');
      const canEditSection = hasPermission(getAdminEditPermission(permission), 'admin');
      section.classList.toggle('tfq-hidden', !canView);
      section.classList.toggle('tfq-admin-readonly', canView && !canEditSection);
      section.querySelectorAll('input, select, textarea, button').forEach(control => {
        if (control.closest('summary')) return;
        if (control.id === 'tfq-reload-audit') return;
        control.disabled = canView && !canEditSection;
      });
    });
  }

  async function loadUsers() {
    const statusEl = document.getElementById('tfq-users-status');
    const listEl = document.getElementById('tfq-users-list');
    if (!statusEl || !listEl) return;

    if (!canViewUsersAdmin()) {
      renderRolePermissionEditor();
      listEl.innerHTML = '<div class="tfq-empty">Seu usuário não tem permissão para ver usuários.</div>';
      statusEl.textContent = '';
      return;
    }

    statusEl.textContent = 'Carregando usuários...';
    statusEl.className = '';

    try {
      const result = await fetchJson(`${API_BASE}/users.php?_t=${Date.now()}`, {
        headers: adminHeaders()
      });
      const users = Array.isArray(result.users) ? result.users : [];
      rolePermissionMap = result.role_permissions || rolePermissionMap || {};
      userPermissionMap = result.user_permissions || userPermissionMap || {};
      permissionCatalog = Array.isArray(result.permission_catalog) ? result.permission_catalog : permissionCatalog;
      renderRolePermissionEditor();
      renderUsersList(users);
      taskAssigneesCache = users.filter(user => Number(user.is_active) === 1);
      renderTaskAssigneeOptions();
      statusEl.textContent = `${users.length} usuário(s) encontrado(s).`;
      statusEl.className = 'success';
    } catch (error) {
      listEl.innerHTML = '';
      statusEl.textContent = `Erro: ${error.message}`;
      statusEl.className = 'error';
    }
  }

  function getUserEffectivePermissions(user) {
    const override = userPermissionMap[Number(user.id)] || null;
    return Array.isArray(override) ? override : (rolePermissionMap[user.role] || []);
  }

  function renderUserPermissionChecks(user, disabled) {
    const catalog = permissionCatalog.length ? permissionCatalog : [];
    const permissions = getUserEffectivePermissions(user);
    return `
      <div class="tfq-permission-grid tfq-user-permission-grid">
        ${catalog.map(item => `
          <label class="tfq-permission-check">
            <input type="checkbox" value="${escapeHtml(item.key)}" ${permissions.includes(item.key) || permissions.includes('*') ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
            <span>${escapeHtml(item.label || item.key)}</span>
          </label>
        `).join('')}
      </div>
    `;
  }

  function renderUsersList(users) {
    const listEl = document.getElementById('tfq-users-list');
    if (!listEl) return;

    if (users.length === 0) {
      listEl.innerHTML = '<div class="tfq-empty">Nenhum usuário encontrado.</div>';
      return;
    }

    listEl.innerHTML = users.map(user => {
      const isSelf = CURRENT_USER && Number(CURRENT_USER.id) === Number(user.id);
      const active = Number(user.is_active) === 1;
      const canTouch = !isSelf && canManageTargetRole(user.role);
      const canEditEmail = isSelf || canTouch;
      const statusLabel = active ? 'ativo' : 'inativo';
      const override = Array.isArray(userPermissionMap[Number(user.id)]);
      const protectedRole = !['viewer', 'editor'].includes(user.role);
      const roleControl = protectedRole
        ? `<div class="tfq-protected-user-note">Grupo protegido</div>`
        : `<select class="tfq-select tfq-user-role-select" id="tfq-user-role-${Number(user.id)}" data-id="${Number(user.id)}" ${canTouch ? '' : 'disabled'}>
            ${getAllowedRoleOptions(user.role)}
          </select>`;

      return `
        <div class="tfq-field-item tfq-user-item" data-user-id="${Number(user.id)}">
          <div class="tfq-field-info">
            <strong>${escapeHtml(user.full_name || user.username)}</strong>
            <span class="tfq-field-key">${escapeHtml(user.username)} • ${escapeHtml(roleLabel(user.role))} • ${statusLabel}${override ? ' • permissões próprias' : ''}</span>
            <div class="tfq-user-controls">
              <label class="tfq-label" for="tfq-user-email-${Number(user.id)}">Email</label>
              <input class="tfq-input tfq-user-email-input" id="tfq-user-email-${Number(user.id)}" data-id="${Number(user.id)}" type="email" value="${escapeHtml(user.email || '')}" placeholder="email do usuário" ${canEditEmail ? '' : 'disabled'} />
            </div>
            <div class="tfq-user-controls">
              <label class="tfq-label" for="tfq-user-role-${Number(user.id)}">Grupo</label>
              ${roleControl}
            </div>
            ${renderUserPermissionChecks(user, !canTouch)}
          </div>
          <div class="tfq-item-actions">
            <button class="tfq-mini-btn tfq-user-save-email" data-id="${Number(user.id)}" ${canEditEmail ? '' : 'disabled'} title="Salvar email do usuário">Salvar email</button>
            <button class="tfq-mini-btn tfq-user-save-role" data-id="${Number(user.id)}" ${canTouch ? '' : 'disabled'} title="Salvar grupo do usuário">Salvar grupo</button>
            <button class="tfq-mini-btn tfq-user-save-permissions" data-id="${Number(user.id)}" ${canTouch ? '' : 'disabled'} title="Salvar permissões próprias">Salvar permissões</button>
            <button class="tfq-mini-btn tfq-user-reset-permissions" data-id="${Number(user.id)}" ${canTouch && override ? '' : 'disabled'} title="Voltar para permissões do grupo">Usar grupo</button>
            <button class="tfq-mini-btn tfq-user-reset" data-id="${Number(user.id)}" ${canTouch ? '' : 'disabled'} title="Redefinir senha">Senha</button>
            <button class="tfq-mini-btn ${active ? 'tfq-mini-btn-danger' : ''} tfq-user-toggle" data-id="${Number(user.id)}" data-active="${active ? '0' : '1'}" ${canTouch ? '' : 'disabled'} title="${active ? 'Desativar' : 'Reativar'} usuário">${active ? 'Desativar' : 'Reativar'}</button>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.tfq-user-toggle').forEach(btn => {
      btn.addEventListener('click', () => setUserStatus(Number(btn.dataset.id), btn.dataset.active === '1'));
    });

    listEl.querySelectorAll('.tfq-user-reset').forEach(btn => {
      btn.addEventListener('click', () => resetUserPassword(Number(btn.dataset.id)));
    });

    listEl.querySelectorAll('.tfq-user-save-role').forEach(btn => {
      btn.addEventListener('click', () => saveUserRole(Number(btn.dataset.id)));
    });

    listEl.querySelectorAll('.tfq-user-save-email').forEach(btn => {
      btn.addEventListener('click', () => saveUserEmail(Number(btn.dataset.id)));
    });

    listEl.querySelectorAll('.tfq-user-save-permissions').forEach(btn => {
      btn.addEventListener('click', () => saveUserPermissionsFromForm(Number(btn.dataset.id)));
    });

    listEl.querySelectorAll('.tfq-user-reset-permissions').forEach(btn => {
      btn.addEventListener('click', () => resetUserPermissions(Number(btn.dataset.id)));
    });
  }

  function canManageTargetRole(role) {
    if (!canManageUsers()) return false;
    return ['viewer', 'editor'].includes(role);
  }

  async function addUser() {
    const usernameInput = document.getElementById('tfq-new-user-username');
    const nameInput = document.getElementById('tfq-new-user-name');
    const emailInput = document.getElementById('tfq-new-user-email');
    const passwordInput = document.getElementById('tfq-new-user-password');
    const roleInput = document.getElementById('tfq-new-user-role');
    const statusEl = document.getElementById('tfq-users-status');
    const addBtn = document.getElementById('tfq-add-user-btn');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const fullName = nameInput ? nameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const role = roleInput ? roleInput.value : 'editor';

    if (!username || !password) {
      if (statusEl) { statusEl.textContent = 'Informe usuário e senha temporária.'; statusEl.className = 'error'; }
      return;
    }

    if (addBtn) addBtn.disabled = true;
    if (statusEl) { statusEl.textContent = 'Criando usuário...'; statusEl.className = ''; }

    try {
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'create', username, full_name: fullName, email, password, role })
      });

      if (usernameInput) usernameInput.value = '';
      if (nameInput) nameInput.value = '';
      if (emailInput) emailInput.value = '';
      if (passwordInput) passwordInput.value = '';
      if (statusEl) { statusEl.textContent = result.message || 'Usuário criado.'; statusEl.className = 'success'; }
      await loadUsers();
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    } finally {
      if (addBtn) addBtn.disabled = false;
    }
  }

  async function saveUserRole(id) {
    const statusEl = document.getElementById('tfq-users-status');
    const select = document.querySelector(`.tfq-user-role-select[data-id="${id}"]`);
    if (!select) return;

    try {
      if (statusEl) { statusEl.textContent = 'Salvando grupo do usuário...'; statusEl.className = ''; }
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'update_role', id, role: select.value })
      });
      if (statusEl) { statusEl.textContent = result.message || 'Grupo atualizado.'; statusEl.className = 'success'; }
      await loadUsers();
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  async function saveUserEmail(id) {
    const statusEl = document.getElementById('tfq-users-status');
    const input = document.querySelector(`.tfq-user-email-input[data-id="${id}"]`);
    if (!input) return;

    try {
      if (statusEl) { statusEl.textContent = 'Salvando email do usuário...'; statusEl.className = ''; }
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'update_email', id, email: input.value.trim() })
      });
      if (statusEl) { statusEl.textContent = result.message || 'Email salvo.'; statusEl.className = 'success'; }
      await loadUsers();
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  async function saveUserPermissionsFromForm(id) {
    const statusEl = document.getElementById('tfq-users-status');
    const item = document.querySelector(`.tfq-user-item[data-user-id="${id}"]`);
    if (!item) return;
    const permissions = [...item.querySelectorAll('.tfq-user-permission-grid input[type="checkbox"]')]
      .filter(input => input.checked)
      .map(input => input.value);

    try {
      if (statusEl) { statusEl.textContent = 'Salvando permissões do usuário...'; statusEl.className = ''; }
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'update_user_permissions', id, permissions })
      });
      userPermissionMap = result.user_permissions || { ...userPermissionMap, [id]: result.permissions || permissions };
      if (statusEl) { statusEl.textContent = result.message || 'Permissões do usuário atualizadas.'; statusEl.className = 'success'; }
      await loadUsers();
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  async function resetUserPermissions(id) {
    const statusEl = document.getElementById('tfq-users-status');
    try {
      if (statusEl) { statusEl.textContent = 'Removendo permissões próprias...'; statusEl.className = ''; }
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'reset_user_permissions', id })
      });
      userPermissionMap = result.user_permissions || {};
      if (statusEl) { statusEl.textContent = result.message || 'Usuário voltou ao grupo.'; statusEl.className = 'success'; }
      await loadUsers();
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  async function setUserStatus(id, isActive) {
    const statusEl = document.getElementById('tfq-users-status');
    const ok = window.confirm(isActive ? 'Reativar este usuário?' : 'Desativar este usuário e encerrar suas sessões?');
    if (!ok) return;

    try {
      if (statusEl) { statusEl.textContent = 'Atualizando usuário...'; statusEl.className = ''; }
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'set_status', id, is_active: isActive })
      });
      if (statusEl) { statusEl.textContent = result.message || 'Usuário atualizado.'; statusEl.className = 'success'; }
      await loadUsers();
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  async function resetUserPassword(id) {
    const statusEl = document.getElementById('tfq-users-status');
    const password = window.prompt('Informe a nova senha temporária para este usuário:');
    if (password == null) return;
    if (password.length < 8) {
      if (statusEl) { statusEl.textContent = 'A senha deve ter pelo menos 8 caracteres.'; statusEl.className = 'error'; }
      return;
    }

    try {
      if (statusEl) { statusEl.textContent = 'Redefinindo senha...'; statusEl.className = ''; }
      const result = await fetchJson(`${API_BASE}/users.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'reset_password', id, password })
      });
      if (statusEl) { statusEl.textContent = result.message || 'Senha redefinida.'; statusEl.className = 'success'; }
      await loadUsers();
    } catch (error) {
      if (statusEl) { statusEl.textContent = `Erro: ${error.message}`; statusEl.className = 'error'; }
    }
  }

  function setAuditStatus(message, type = '') {
    const el = document.getElementById('tfq-audit-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  async function downloadBackup() {
    if (!hasPermission('admin.backup.edit', 'admin')) {
      setAuditStatus('Seu usuário não tem permissão para baixar backup.', 'error');
      return;
    }

    const btn = document.getElementById('tfq-download-backup');
    if (btn) btn.disabled = true;
    setAuditStatus('Gerando backup...', '');

    try {
      const result = await fetchJson(`${API_BASE}/export_backup.php?_t=${Date.now()}`, {
        headers: adminHeaders()
      }, 30000);

      const json = JSON.stringify(result, null, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `zap-negocios-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setAuditStatus('Backup JSON gerado.', 'success');
      await loadAuditLog();
    } catch (error) {
      setAuditStatus(`Erro: ${error.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function downloadAuditLog() {
    if (!hasPermission('admin.audit.view', 'admin')) {
      setAuditStatus('Seu usuário não tem permissão para baixar auditoria.', 'error');
      return;
    }

    const btn = document.getElementById('tfq-download-audit');
    if (btn) btn.disabled = true;
    setAuditStatus('Gerando log de auditoria...', '');

    try {
      const result = await fetchJson(`${API_BASE}/audit_log.php?download=1&_t=${Date.now()}`, {
        headers: adminHeaders()
      }, 30000);

      const json = JSON.stringify(result, null, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `zap-negocios-auditoria-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setAuditStatus('Log de auditoria gerado.', 'success');
      await loadAuditLog(auditPage);
    } catch (error) {
      setAuditStatus(`Erro: ${error.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadAuditLog(page = auditPage) {
    const listEl = document.getElementById('tfq-audit-list');
    if (!listEl || !hasPermission('admin.audit.view', 'admin')) return;

    listEl.innerHTML = '<div class="tfq-empty">Carregando auditoria...</div>';

    try {
      auditPage = Math.max(1, Number(page) || 1);
      const result = await fetchJson(`${API_BASE}/audit_log.php?limit=7&page=${auditPage}&_t=${Date.now()}`, {
        headers: adminHeaders()
      });

      auditPagination = result.pagination || { page: auditPage, pages: 1, total: 0, limit: 7 };
      auditPage = Number(auditPagination.page || auditPage);
      renderAuditLog(Array.isArray(result.logs) ? result.logs : []);
    } catch (error) {
      listEl.innerHTML = `<div class="tfq-empty">Erro: ${escapeHtml(error.message)}</div>`;
    }
  }

  async function deleteAuditItem(id) {
    if (!hasPermission('admin.backup.edit', 'admin')) {
      setAuditStatus('Seu usuário não tem permissão para apagar auditoria.', 'error');
      return;
    }
    if (!window.confirm('Apagar este evento de auditoria?')) return;

    try {
      setAuditStatus('Apagando evento de auditoria...', '');
      const result = await fetchJson(`${API_BASE}/audit_log.php`, {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'delete', id })
      });
      setAuditStatus(result.message || 'Evento apagado.', 'success');
      await loadAuditLog(auditPage);
    } catch (error) {
      setAuditStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function formatAuditDate(value) {
    if (!value) return '-';
    const date = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function actionLabel(action) {
    return {
      'negocio.create': 'Negócio criado',
      'negocio.update': 'Negócio alterado',
      'negocio.delete_soft': 'Negócio excluído',
      'negocio.restore': 'Negócio restaurado',
      'task.create': 'Tarefa criada',
      'task.update': 'Tarefa alterada',
      'task.complete': 'Tarefa concluída',
      'task.reopen': 'Tarefa reaberta',
      'task.cancel': 'Tarefa cancelada',
      'task.archive': 'Tarefa arquivada',
      'task.delete_hard': 'Tarefa excluída',
      'field.create': 'Campo criado',
      'field.delete_hard': 'Campo removido',
      'field_config.update': 'Campos reordenados/configurados',
      'user.create': 'Usuário criado',
      'user.set_status': 'Status de usuário alterado',
      'user.reset_password': 'Senha redefinida',
      'user.update_role': 'Permissão alterada',
      'role_permissions.update': 'Permissões do grupo alteradas',
      'user_permissions.update': 'Permissões do usuário alteradas',
      'user_permissions.reset': 'Permissões do usuário restauradas',
      'backup.export': 'Backup exportado',
      'audit.export': 'Auditoria exportada'
    }[action] || action || '-';
  }

  function auditDetailText(log) {
    if (log.details) return log.details;
    const data = log.after_data && typeof log.after_data === 'object' ? log.after_data : log.before_data;
    if (!data || typeof data !== 'object') return '';
    return Object.entries(data)
      .filter(([key, value]) => ['title', 'nome_lead', 'lead_name', 'destino', 'status', 'due_at', 'priority', 'username', 'role'].includes(key) && value)
      .map(([key, value]) => `${key}: ${value}`)
      .join(' · ');
  }

  function renderAuditLog(logs) {
    const listEl = document.getElementById('tfq-audit-list');
    if (!listEl) return;

    if (logs.length === 0) {
      listEl.innerHTML = `${renderAuditPagination()}<div class="tfq-empty">Nenhum evento de auditoria encontrado.</div>`;
      bindAuditPagination();
      return;
    }

    const canDelete = hasPermission('admin.backup.edit', 'admin');
    listEl.innerHTML = `
      ${renderAuditPagination()}
      ${logs.map(log => `
        <div class="tfq-audit-item" data-audit-id="${Number(log.id)}">
          <div class="tfq-audit-main">
            <strong>${escapeHtml(actionLabel(log.action))}</strong>
            <span>${escapeHtml(formatAuditDate(log.created_at))} • ${escapeHtml(log.actor_full_name || log.actor_username || 'sistema')} • ${escapeHtml(log.entity_type || '-')}${log.entity_id ? ` #${escapeHtml(log.entity_id)}` : ''}</span>
            ${auditDetailText(log) ? `<em>${escapeHtml(auditDetailText(log))}</em>` : ''}
          </div>
          <button class="tfq-mini-btn tfq-mini-btn-danger tfq-audit-delete" data-id="${Number(log.id)}" type="button" ${canDelete ? '' : 'disabled'}>Apagar</button>
        </div>
      `).join('')}
      ${renderAuditPagination()}
    `;

    bindAuditPagination();
    listEl.querySelectorAll('.tfq-audit-delete').forEach(btn => {
      btn.addEventListener('click', () => deleteAuditItem(Number(btn.dataset.id)));
    });
  }

  function renderAuditPagination() {
    const page = Number(auditPagination.page || 1);
    const pages = Number(auditPagination.pages || 1);
    const total = Number(auditPagination.total || 0);
    return `
      <div class="tfq-audit-pagination">
        <button class="tfq-mini-btn tfq-audit-page-prev" type="button" ${page <= 1 ? 'disabled' : ''}>Anterior</button>
        <span>Página ${page} de ${pages} • ${total} evento(s)</span>
        <button class="tfq-mini-btn tfq-audit-page-next" type="button" ${page >= pages ? 'disabled' : ''}>Próxima</button>
      </div>
    `;
  }

  function bindAuditPagination() {
    document.querySelectorAll(`#${PANEL_ID} .tfq-audit-page-prev`).forEach(btn => {
      btn.addEventListener('click', () => loadAuditLog(Math.max(1, auditPage - 1)));
    });
    document.querySelectorAll(`#${PANEL_ID} .tfq-audit-page-next`).forEach(btn => {
      btn.addEventListener('click', () => loadAuditLog(auditPage + 1));
    });
  }

  function priorityLabel(priority) {
    return {
      baixa: 'Baixa',
      normal: 'Normal',
      alta: 'Alta'
    }[priority] || 'Normal';
  }

  function statusLabel(status) {
    return {
      pendente: 'Pendente',
      concluida: 'Concluída',
      cancelada: 'Cancelada',
      arquivada: 'Arquivada'
    }[status] || status || '-';
  }

  function getTaskStatusEl() {
    return document.getElementById('tfq-task-status');
  }

  function setTaskStatus(message, type = '') {
    const el = getTaskStatusEl();
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  function parseTaskDate(value) {
    if (!value) return null;
    const date = new Date(String(value).replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTaskDue(value) {
    const date = parseTaskDate(value);
    if (!date) return 'Sem prazo';

    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function toDateTimeLocalValue(value) {
    if (!value) return '';
    return String(value).replace(' ', 'T').slice(0, 16);
  }

  function isTaskOverdue(task) {
    const date = parseTaskDate(task.due_at);
    return task.status === 'pendente' && date && date.getTime() < Date.now();
  }

  function isTaskToday(task) {
    const date = parseTaskDate(task.due_at);
    if (!date) return false;
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
  }

  function getUserDisplayName(user) {
    return (user && (user.full_name || user.username)) || '';
  }

  function getCurrentUserAssignee() {
    if (!CURRENT_USER) return null;
    return {
      id: Number(CURRENT_USER.id || 0),
      username: CURRENT_USER.username || '',
      full_name: CURRENT_USER.full_name || '',
      is_active: 1
    };
  }

  function getTaskAssigneeLabel(task) {
    return task.assigned_full_name
      || task.assigned_username
      || task.responsavel
      || 'Sem responsável';
  }

  function getSelectedTaskAssignee() {
    const select = document.getElementById('tfq-task-assigned-user');
    const selectedId = select ? Number(select.value || 0) : 0;
    return taskAssigneesCache.find(user => Number(user.id) === selectedId)
      || getCurrentUserAssignee();
  }

  function renderTaskAssigneeOptions(selectedId = '') {
    const select = document.getElementById('tfq-task-assigned-user');
    if (!select) return;

    const currentUser = getCurrentUserAssignee();
    const users = taskAssigneesCache.length
      ? taskAssigneesCache
      : (currentUser ? [currentUser] : []);
    const currentValue = selectedId || select.value || (currentUser ? String(currentUser.id) : '');

    select.innerHTML = users.map(user => {
      const id = Number(user.id || 0);
      const label = getUserDisplayName(user) || user.username || `Usuário #${id}`;
      return `<option value="${id}">${escapeHtml(label)}</option>`;
    }).join('');

    if ([...select.options].some(option => option.value === String(currentValue))) {
      select.value = String(currentValue);
    } else if (currentUser) {
      select.value = String(currentUser.id);
    }

    select.disabled = !canAdminTasks();
    select.title = canAdminTasks()
      ? 'Selecione o responsável pela tarefa'
      : 'Seu usuário só pode criar tarefas para si';
  }

  async function loadTaskAssignees(force = false) {
    const currentUser = getCurrentUserAssignee();
    if (!canAdminTasks()) {
      taskAssigneesCache = currentUser ? [currentUser] : [];
      renderTaskAssigneeOptions();
      return;
    }

    if (!force && taskAssigneesCache.length) {
      renderTaskAssigneeOptions();
      return;
    }

    try {
      const result = await fetchJson(`${API_BASE}/users.php?_t=${Date.now()}`, {
        headers: adminHeaders()
      });
      taskAssigneesCache = (Array.isArray(result.users) ? result.users : [])
        .filter(user => Number(user.is_active) === 1);
      if (currentUser && !taskAssigneesCache.some(user => Number(user.id) === Number(currentUser.id))) {
        taskAssigneesCache.unshift(currentUser);
      }
    } catch {
      taskAssigneesCache = currentUser ? [currentUser] : [];
    }

    renderTaskAssigneeOptions();
  }

  function getTaskLeadLabel(task) {
    return task.lead_name
      || task.negocio_nome_lead
      || task.lead_phone
      || task.source_conversation_id
      || task.conversation_id
      || 'Lead';
  }

  function getDefaultTaskDueValue() {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T09:00`;
  }

  function getTaskConversationUrl(task) {
    if (!task) return '';

    const platform = task.source_platform || getPlatform();
    if (platform === 'travel_flow') {
      const conversationId = task.conversation_id || task.source_conversation_id || '';
      if (!conversationId) return '';

      const baseUrl = window.location.hostname === TRAVEL_FLOW_HOST
        ? window.location.href
        : `https://${TRAVEL_FLOW_HOST}/atendimento-web`;
      const url = new URL(baseUrl);
      url.searchParams.set('conversationId', conversationId);
      return url.toString();
    }

    if (platform === 'whatsapp_web' && task.lead_phone) {
      return `https://web.whatsapp.com/send?phone=${encodeURIComponent(normalizePhone(task.lead_phone))}`;
    }

    return '';
  }

  function openTaskConversation(task) {
    const url = getTaskConversationUrl(task);
    if (!url) return false;
    window.location.href = url;
    return true;
  }

  function openTasksTab() {
    const tab = document.querySelector(`#${PANEL_ID} .tfq-tab[data-tab="tarefas"]`);
    if (tab) tab.click();
  }

  function setTaskSectionsState(activeSection = 'overview') {
    const sections = {
      overview: document.getElementById('tfq-task-overview-section'),
      lead: document.getElementById('tfq-current-tasks-section'),
      form: document.getElementById('tfq-task-form-section')
    };

    Object.entries(sections).forEach(([key, section]) => {
      if (section) section.open = key === activeSection;
    });
  }

  function scrollFocusedTaskIntoView() {
    if (!focusedTaskId) return;

    window.setTimeout(() => {
      const item = document.querySelector(`#${PANEL_ID} .tfq-task-item[data-task-id="${focusedTaskId}"]`);
      if (item) item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  }

  function focusTaskInPanel(task) {
    if (!task) return;

    focusedTaskId = Number(task.id || 0);
    focusTaskNavigationPending = true;
    openTasksTab();
    setTaskSectionsState('lead');
    renderTasksList();
    scrollFocusedTaskIntoView();
  }

  function focusNewTaskForm() {
    focusedTaskId = 0;
    clearTaskForm();
    openTasksTab();
    setTaskSectionsState('form');

    window.setTimeout(() => {
      const title = document.getElementById('tfq-task-title');
      if (title) {
        title.scrollIntoView({ behavior: 'smooth', block: 'center' });
        title.focus();
      }
    }, 120);
  }

  function getTaskIdentityPayload(task) {
    return {
      conversation_id: task.conversation_id || '',
      source_platform: task.source_platform || getPlatform(),
      source_conversation_id: task.source_conversation_id || '',
      lead_name: task.lead_name || task.negocio_nome_lead || '',
      lead_phone: task.lead_phone || ''
    };
  }

  function taskMatchesCurrentContext(task) {
    const context = getCurrentContext();
    const taskPhone = normalizePhone(task.lead_phone || '');
    const contextPhone = normalizePhone(context.leadPhone || getFormLeadPhoneValue());

    if (taskPhone && contextPhone && taskPhone === contextPhone) return true;
    if (context.conversationId && task.conversation_id === context.conversationId) return true;
    return Boolean(
      context.sourceConversationId
      && task.source_platform === context.platform
      && task.source_conversation_id === context.sourceConversationId
    );
  }

  function renderTaskNegocioOptions() {
    const select = document.getElementById('tfq-task-negocio');
    if (!select) return;

    const current = select.value;
    const options = ['<option value="">Nenhum negócio específico</option>'];
    negociosCache.forEach(item => {
      const label = `#${item.id} - ${item.destino || item.nome_lead || 'Sem destino'}`;
      options.push(`<option value="${Number(item.id)}">${escapeHtml(label)}</option>`);
    });

    select.innerHTML = options.join('');
    if ([...select.options].some(option => option.value === current)) {
      select.value = current;
    }
  }

  function getTaskFormData() {
    const data = editingTaskId > 0 && editingTaskSource
      ? getTaskIdentityPayload(editingTaskSource)
      : getLeadContextPayload();
    const negocioSelect = document.getElementById('tfq-task-negocio');
    const assignedUser = getSelectedTaskAssignee();

    return {
      ...data,
      action: editingTaskId > 0 ? 'update' : 'create',
      id: editingTaskId,
      negocio_id: negocioSelect && negocioSelect.value ? Number(negocioSelect.value) : 0,
      title: (document.getElementById('tfq-task-title')?.value || '').trim(),
      due_at: (document.getElementById('tfq-task-due')?.value || '').trim(),
      priority: document.getElementById('tfq-task-priority')?.value || 'normal',
      assigned_user_id: assignedUser ? Number(assignedUser.id || 0) : 0,
      responsavel: getUserDisplayName(assignedUser),
      notes: (document.getElementById('tfq-task-notes')?.value || '').trim()
    };
  }

  function clearTaskForm() {
    editingTaskId = 0;
    editingTaskSource = null;

    const title = document.getElementById('tfq-task-title');
    const negocio = document.getElementById('tfq-task-negocio');
    const due = document.getElementById('tfq-task-due');
    const priority = document.getElementById('tfq-task-priority');
    const responsavel = document.getElementById('tfq-task-assigned-user');
    const notes = document.getElementById('tfq-task-notes');
    const formTitle = document.getElementById('tfq-task-form-title');
    const badge = document.getElementById('tfq-task-editing-badge');
    const saveBtn = document.getElementById('tfq-task-save');

    if (title) title.value = '';
    if (negocio) negocio.value = editingId > 0 ? String(editingId) : '';
    if (due) due.value = getDefaultTaskDueValue();
    if (priority) priority.value = 'normal';
    if (responsavel) renderTaskAssigneeOptions(CURRENT_USER ? String(CURRENT_USER.id || '') : '');
    if (notes) notes.value = '';
    if (formTitle) formTitle.textContent = 'Nova tarefa';
    if (badge) badge.textContent = '';
    if (saveBtn) saveBtn.textContent = 'Salvar tarefa';
  }

  function fillTaskForm(task) {
    clearTaskForm();
    editingTaskId = Number(task.id || 0);
    editingTaskSource = task;

    const title = document.getElementById('tfq-task-title');
    const negocio = document.getElementById('tfq-task-negocio');
    const due = document.getElementById('tfq-task-due');
    const priority = document.getElementById('tfq-task-priority');
    const responsavel = document.getElementById('tfq-task-assigned-user');
    const notes = document.getElementById('tfq-task-notes');
    const formTitle = document.getElementById('tfq-task-form-title');
    const badge = document.getElementById('tfq-task-editing-badge');
    const saveBtn = document.getElementById('tfq-task-save');

    if (title) title.value = task.title || '';
    if (negocio) negocio.value = task.negocio_id ? String(task.negocio_id) : '';
    if (due) due.value = toDateTimeLocalValue(task.due_at);
    if (priority) priority.value = task.priority || 'normal';
    if (responsavel) renderTaskAssigneeOptions(task.assigned_user_id ? String(task.assigned_user_id) : '');
    if (notes) notes.value = task.notes || '';
    if (formTitle) formTitle.textContent = 'Editando tarefa';
    if (badge) badge.textContent = `ID #${editingTaskId}`;
    if (saveBtn) saveBtn.textContent = 'Atualizar tarefa';
  }

  function editTaskInPanel(task) {
    if (!task) return;

    focusedTaskId = Number(task.id || 0);
    fillTaskForm(task);
    openTasksTab();
    setTaskSectionsState('form');

    window.setTimeout(() => {
      const title = document.getElementById('tfq-task-title');
      if (title) {
        title.scrollIntoView({ behavior: 'smooth', block: 'center' });
        title.focus();
        title.select();
      }
    }, 120);
  }

  function updateTaskSummary() {
    const pending = tasksCache.filter(task => task.status === 'pendente');
    const overdue = pending.filter(isTaskOverdue);
    const today = pending.filter(isTaskToday);
    const summaryEl = document.getElementById('tfq-task-summary');
    updateTaskTabOverdueBadge();

    if (!summaryEl) return;

    let message = 'Nenhuma tarefa pendente para este lead.';
    let tone = 'ok';

    if (overdue.length > 0) {
      message = `${overdue.length} tarefa(s) atrasada(s).`;
      tone = 'danger';
    } else if (today.length > 0) {
      message = `${today.length} tarefa(s) para hoje.`;
      tone = 'warning';
    } else if (pending.length > 0) {
      message = `${pending.length} tarefa(s) pendente(s).`;
      tone = 'info';
    }

    summaryEl.innerHTML = `
      <div class="tfq-task-summary-btn tfq-task-summary-label tfq-task-summary-${tone}" id="tfq-open-tasks-tab">
        ${escapeHtml(message)}
      </div>
      ${pending.length > 0 ? `
        <div class="tfq-business-task-list">
          ${pending.slice(0, 3).map(task => `
            <button class="tfq-business-task-link" data-task-id="${Number(task.id)}" type="button">
              <strong>${escapeHtml(task.title || 'Tarefa sem título')}</strong>
              <span>${escapeHtml(formatTaskDue(task.due_at))}</span>
            </button>
          `).join('')}
        </div>
      ` : `
        <button class="tfq-btn tfq-btn-primary tfq-create-task-from-business" type="button" ${canEditTasks() ? '' : 'disabled'}>
          Criar nova tarefa
        </button>
      `}
    `;

    const createTaskBtn = summaryEl.querySelector('.tfq-create-task-from-business');
    if (createTaskBtn) createTaskBtn.addEventListener('click', focusNewTaskForm);

    summaryEl.querySelectorAll('.tfq-business-task-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const task = tasksCache.find(item => Number(item.id) === Number(btn.dataset.taskId));
        if (task) focusTaskInPanel(task);
      });
    });
  }

  function setTaskOverviewStatus(message, type = '') {
    const el = document.getElementById('tfq-task-overview-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = type ? type : '';
  }

  function getTaskOverviewScopeText() {
    return canAdminTasks() ? 'na visão geral' : 'nas suas tarefas';
  }

  function getTaskOverviewStats() {
    const pending = taskOverviewCache.filter(task => task.status === 'pendente');
    const overdue = pending.filter(isTaskOverdue);
    const today = pending.filter(isTaskToday);
    const upcoming = pending.filter(task => {
      const due = parseTaskDate(task.due_at);
      return due && !isTaskOverdue(task) && !isTaskToday(task);
    });
    const noDue = pending.filter(task => !parseTaskDate(task.due_at));

    return { pending, overdue, today, upcoming, noDue };
  }

  function updateTaskTabOverdueBadge() {
    const countEl = document.getElementById('tfq-task-tab-count');
    const overviewOverdue = taskOverviewCache.filter(isTaskOverdue).length;
    const leadOverdue = tasksCache
      .filter(task => task.status === 'pendente')
      .filter(isTaskOverdue).length;
    const count = overviewOverdue || leadOverdue;
    const scopeText = overviewOverdue ? getTaskOverviewScopeText() : 'neste lead';

    if (countEl) {
      countEl.textContent = count > 0 ? String(count) : '';
      countEl.classList.toggle('tfq-hidden', count === 0);
      countEl.title = count > 0 ? `${count} tarefa(s) atrasada(s) ${scopeText}` : '';
    }

    updateFloatingOverdueBadge(count, scopeText);
    updateOverdueAlert(count, scopeText);
    handleOverdueReminderEffects(count, scopeText);
  }

  function updateFloatingOverdueBadge(count, scopeText) {
    const badge = document.getElementById('tfq-toggle-count');
    if (!badge) return;
    badge.textContent = count > 0 ? String(count) : '';
    badge.classList.toggle('tfq-hidden', count === 0);
    badge.title = count > 0 ? `${count} tarefa(s) atrasada(s) ${scopeText}` : '';
  }

  function updateOverdueAlert(count, scopeText) {
    const alertEl = document.getElementById('tfq-overdue-alert');
    const textEl = document.getElementById('tfq-overdue-alert-text');
    if (!alertEl || !textEl) return;

    alertEl.classList.toggle('tfq-hidden', count === 0);
    textEl.textContent = count > 0
      ? `Você tem ${count} tarefa(s) atrasada(s) ${scopeText}.`
      : '';
  }

  function playOverdueSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.32);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.34);
    } catch {
      // Som opcional: falhas de permissão do navegador são ignoradas.
    }
  }

  function getLocalStorage(keys) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch {
        resolve({});
      }
    });
  }

  function setLocalStorage(values) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.set(values, resolve);
      } catch {
        resolve();
      }
    });
  }

  async function sendOverdueEmailSummary(settings) {
    if (!isConfigured()) return;
    const stored = await getLocalStorage(['tfq_last_overdue_email_at']);
    const lastSentAt = Number(stored.tfq_last_overdue_email_at || 0);
    const intervalMs = settings.emailIntervalMinutes * 60 * 1000;
    if (Date.now() - lastSentAt < intervalMs) return;

    await fetchJson(`${API_BASE}/notify_overdue_email.php`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'send_overdue_summary' })
    });
    await setLocalStorage({ tfq_last_overdue_email_at: Date.now() });
  }

  function handleOverdueReminderEffects(count, scopeText) {
    if (count <= 0) return;
    const settings = normalizeNotificationSettings(notificationSettings);
    if (!settings.enabled) return;

    const now = Date.now();
    const inAppInterval = settings.inAppAlertMinutes * 60 * 1000;
    if (settings.soundEnabled && now - lastOverdueSoundAt >= inAppInterval) {
      lastOverdueSoundAt = now;
      playOverdueSound();
    }

    if (settings.emailEnabled) {
      sendOverdueEmailSummary(settings).catch(error => {
        setTaskOverviewStatus(`Erro ao enviar email: ${error.message}`, 'error');
      });
    }
  }

  function getTaskOverviewGroups() {
    const stats = getTaskOverviewStats();

    if (taskOverviewFilter === 'pending') {
      return [{ title: 'Pendentes', tasks: stats.pending }];
    }
    if (taskOverviewFilter === 'overdue') {
      return [{ title: 'Atrasadas', tasks: stats.overdue }];
    }
    if (taskOverviewFilter === 'today') {
      return [{ title: 'Hoje', tasks: stats.today }];
    }
    if (taskOverviewFilter === 'upcoming') {
      return [{ title: 'Próximas', tasks: stats.upcoming }];
    }
    if (taskOverviewFilter === 'no_due') {
      return [{ title: 'Sem prazo', tasks: stats.noDue }];
    }

    taskOverviewFilter = 'overdue';
    return [{ title: 'Atrasadas', tasks: stats.overdue }];
  }

  function renderTaskOverview() {
    const titleEl = document.getElementById('tfq-task-overview-title');
    const statsEl = document.getElementById('tfq-task-overview-stats');
    const listEl = document.getElementById('tfq-task-overview-list');
    if (!statsEl || !listEl) return;

    if (titleEl) titleEl.textContent = canAdminTasks() ? 'Visão geral de tarefas' : 'Minhas tarefas';

    const stats = getTaskOverviewStats();
    updateTaskTabOverdueBadge();
    const filters = [
      { key: 'overdue', label: 'Atrasadas', count: stats.overdue.length, tone: 'danger' },
      { key: 'upcoming', label: 'Próximas', count: stats.upcoming.length, tone: 'info' },
      { key: 'pending', label: 'Pendentes', count: stats.pending.length, tone: 'info' },
      { key: 'today', label: 'Hoje', count: stats.today.length, tone: 'warning' },
      { key: 'no_due', label: 'Sem prazo', count: stats.noDue.length, tone: 'ok' }
    ];

    statsEl.innerHTML = filters.map(filter => `
      <button
        class="tfq-task-overview-filter tfq-task-overview-${filter.tone} ${taskOverviewFilter === filter.key ? 'tfq-task-overview-active' : ''}"
        data-filter="${escapeHtml(filter.key)}"
        type="button"
      >
        <strong>${Number(filter.count)}</strong>
        <span>${escapeHtml(filter.label)}</span>
      </button>
    `).join('');

    statsEl.querySelectorAll('.tfq-task-overview-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        taskOverviewFilter = btn.dataset.filter || 'overdue';
        renderTaskOverview();
      });
    });

    if (stats.pending.length === 0) {
      listEl.innerHTML = '<div class="tfq-empty">Nenhuma tarefa pendente encontrada.</div>';
      return;
    }

    const groups = getTaskOverviewGroups().filter(group => group.tasks.length > 0);
    if (groups.length === 0) {
      listEl.innerHTML = '<div class="tfq-empty">Nenhuma tarefa neste filtro.</div>';
      return;
    }

    listEl.innerHTML = groups.map(group => `
      <div class="tfq-task-group">
        <h4>${escapeHtml(group.title)}</h4>
        ${group.tasks.map(task => renderTaskItem(task, { showLead: true, source: 'overview' })).join('')}
      </div>
    `).join('');

    listEl.querySelectorAll('.tfq-task-overview-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const task = taskOverviewCache.find(item => Number(item.id) === Number(btn.dataset.id));
        if (task) editTaskInPanel(task);
      });
    });

    listEl.querySelectorAll('.tfq-task-overview-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const task = taskOverviewCache.find(item => Number(item.id) === Number(btn.dataset.id));
        runTaskAction(btn.dataset.action, Number(btn.dataset.id), task || null);
      });
    });

    listEl.querySelectorAll('.tfq-task-lead-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const task = taskOverviewCache.find(item => Number(item.id) === Number(btn.dataset.taskId));
        if (task) openTaskConversation(task);
      });
    });
  }

  async function loadTaskOverview(force = false) {
    if (!isConfigured()) {
      taskOverviewRequestSeq++;
      taskOverviewCache = [];
      renderTaskOverview();
      return;
    }

    if (!force && taskOverviewCache.length) {
      renderTaskOverview();
      return;
    }

    const requestSeq = ++taskOverviewRequestSeq;
    const listEl = document.getElementById('tfq-task-overview-list');
    if (listEl) listEl.innerHTML = '<div class="tfq-empty">Carregando tarefas...</div>';
    setTaskOverviewStatus('Carregando visão geral...', '');

    try {
      const params = new URLSearchParams({
        _t: Date.now().toString(),
        action: 'overview',
        status: 'pendente',
        limit: '300'
      });

      const result = await fetchJson(`${API_BASE}/tasks.php?${params.toString()}`, {
        headers: apiHeaders()
      });

      if (requestSeq !== taskOverviewRequestSeq) return;
      taskOverviewCache = Array.isArray(result.tasks) ? result.tasks : [];
      renderTaskOverview();

      const overdueCount = taskOverviewCache.filter(isTaskOverdue).length;
      const scopeText = getTaskOverviewScopeText();
      setTaskOverviewStatus(
        overdueCount > 0
          ? `${overdueCount} tarefa(s) atrasada(s) ${scopeText}.`
          : `${taskOverviewCache.length} tarefa(s) pendente(s) ${scopeText}.`,
        overdueCount > 0 ? 'error' : 'success'
      );
    } catch (error) {
      if (requestSeq !== taskOverviewRequestSeq) return;
      taskOverviewCache = [];
      renderTaskOverview();
      setTaskOverviewStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function refreshOverdueBadgesOnPageLoad() {
    if (!isConfigured() || !canViewTasks()) {
      updateTaskTabOverdueBadge();
      return;
    }
    loadTaskOverview(true).catch(() => {
      updateTaskTabOverdueBadge();
    });
  }

  async function loadTasks(force = false) {
    const context = getCurrentContext();
    const contextKey = getContextKey(context);

    if (!context.isValid || !isConfigured()) {
      tasksRequestSeq++;
      tasksCache = [];
      renderTasksList();
      updateTaskSummary();
      return;
    }

    if (!force && tasksCache.length && contextKey === currentConversationId) {
      renderTasksList();
      updateTaskSummary();
      return;
    }

    const listEl = document.getElementById('tfq-tasks-list');
    const requestSeq = ++tasksRequestSeq;
    const isCurrentRequest = () => requestSeq === tasksRequestSeq && getContextKey() === contextKey;
    if (listEl) listEl.innerHTML = '<div class="tfq-empty">Carregando tarefas...</div>';
    setTaskStatus('Carregando tarefas...', '');

    try {
      const params = new URLSearchParams({
        _t: Date.now().toString(),
        action: 'list'
      });
      appendLeadContextParams(params, context);

      const result = await fetchJson(`${API_BASE}/tasks.php?${params.toString()}`, {
        headers: apiHeaders()
      });

      if (!isCurrentRequest()) return;
      tasksCache = Array.isArray(result.tasks) ? result.tasks : [];
      renderTasksList();
      updateTaskSummary();

      const pendingCount = tasksCache.filter(task => task.status === 'pendente').length;
      setTaskStatus(
        pendingCount > 0 ? `${pendingCount} tarefa(s) pendente(s).` : 'Nenhuma tarefa pendente.',
        'success'
      );
    } catch (error) {
      if (!isCurrentRequest()) return;
      tasksCache = [];
      renderTasksList();
      updateTaskSummary();
      setTaskStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function loadPanelSecondaryData() {
    loadTaskAssignees(true);
    loadTasks(true);

    const activeTab = document.querySelector(`#${PANEL_ID} .tfq-tab.tfq-tab-active`);
    if (activeTab && activeTab.dataset.tab === 'tarefas') {
      loadTaskOverview(true);
    }
  }

  function getTaskGroups() {
    return [
      {
        title: 'Atrasadas',
        tasks: tasksCache.filter(task => task.status === 'pendente' && isTaskOverdue(task))
      },
      {
        title: 'Hoje',
        tasks: tasksCache.filter(task => task.status === 'pendente' && !isTaskOverdue(task) && isTaskToday(task))
      },
      {
        title: 'Próximas',
        tasks: tasksCache.filter(task => {
          const due = parseTaskDate(task.due_at);
          return task.status === 'pendente' && due && !isTaskOverdue(task) && !isTaskToday(task);
        })
      },
      {
        title: 'Sem prazo',
        tasks: tasksCache.filter(task => task.status === 'pendente' && !parseTaskDate(task.due_at))
      },
      {
        title: 'Concluídas',
        tasks: tasksCache.filter(task => task.status === 'concluida')
      },
      {
        title: 'Canceladas',
        tasks: tasksCache.filter(task => task.status === 'cancelada')
      }
    ];
  }

  function renderTasksList() {
    const listEl = document.getElementById('tfq-tasks-list');
    if (!listEl) return;

    if (tasksCache.length === 0) {
      listEl.innerHTML = '<div class="tfq-empty">Nenhuma tarefa cadastrada para este lead.</div>';
      return;
    }

    listEl.innerHTML = getTaskGroups()
      .filter(group => group.tasks.length > 0)
      .map(group => `
        <div class="tfq-task-group">
          <h4>${escapeHtml(group.title)}</h4>
          ${group.tasks.map(task => renderTaskItem(task, { showLead: true })).join('')}
        </div>
      `).join('');

    listEl.querySelectorAll('.tfq-task-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const task = tasksCache.find(item => Number(item.id) === Number(btn.dataset.id));
        if (task) editTaskInPanel(task);
      });
    });

    listEl.querySelectorAll('.tfq-task-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const task = tasksCache.find(item => Number(item.id) === Number(btn.dataset.id));
        runTaskAction(btn.dataset.action, Number(btn.dataset.id), task || null);
      });
    });

    listEl.querySelectorAll('.tfq-task-lead-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const task = tasksCache.find(item => Number(item.id) === Number(btn.dataset.taskId));
        if (task) openTaskConversation(task);
      });
    });

    scrollFocusedTaskIntoView();
  }

  function renderTaskItem(task, options = {}) {
    const source = options.source || 'lead';
    const showLead = Boolean(options.showLead);
    const actionClass = source === 'overview' ? 'tfq-task-overview-action' : 'tfq-task-action';
    const editClass = source === 'overview' ? 'tfq-task-overview-edit' : 'tfq-task-edit';
    const negocioLabel = task.negocio_id
      ? `Negócio #${task.negocio_id}${task.negocio_destino ? ` - ${task.negocio_destino}` : ''}`
      : 'Lead';
    const overdue = isTaskOverdue(task);
    const priority = task.priority || 'normal';
    const canWrite = canEditTasks();
    const canAdminTask = canAdminTasks();
    const status = task.status || 'pendente';
    const canEditTask = canWrite;
    const editTitle = canEditTask ? 'Editar tarefa' : 'Seu usuário não tem permissão para editar tarefas';
    const metaItems = [
      statusLabel(status),
      formatTaskDue(task.due_at),
      getTaskAssigneeLabel(task),
      negocioLabel
    ];
    const conversationUrl = getTaskConversationUrl(task);
    const leadLabel = getTaskLeadLabel(task);
    const leadLink = showLead
      ? `<button class="tfq-task-lead-link" data-task-id="${Number(task.id)}" type="button" ${conversationUrl ? '' : 'disabled'}>${escapeHtml(leadLabel)}</button>`
      : '';

    const isFocusedTask = focusedTaskId > 0 && Number(task.id) === Number(focusedTaskId);

    const primaryAction = status === 'pendente'
      ? `<button class="tfq-mini-btn ${actionClass}" data-action="complete" data-id="${Number(task.id)}" ${canWrite ? '' : 'disabled'}>Concluir</button>`
      : `<button class="tfq-mini-btn ${actionClass}" data-action="reopen" data-id="${Number(task.id)}" ${canWrite ? '' : 'disabled'}>Reabrir</button>`;

    const cancelAction = status === 'pendente'
      ? `<button class="tfq-mini-btn ${actionClass}" data-action="cancel" data-id="${Number(task.id)}" ${canWrite ? '' : 'disabled'}>Cancelar</button>`
      : '';

    return `
      <div class="tfq-task-item tfq-task-priority-${escapeHtml(priority)} ${overdue ? 'tfq-task-overdue' : ''} ${isFocusedTask ? 'tfq-task-focused' : ''}" data-task-id="${Number(task.id)}">
        <div class="tfq-task-main">
          ${leadLink}
          <div class="tfq-task-title-row">
            <strong>${escapeHtml(task.title || 'Tarefa sem título')}</strong>
            <span class="tfq-task-pill">${escapeHtml(priorityLabel(priority))}</span>
          </div>
          <div class="tfq-task-meta">
            ${escapeHtml(metaItems.join(' • '))}
          </div>
          ${task.notes ? `<div class="tfq-task-notes">${escapeHtml(task.notes)}</div>` : ''}
        </div>
        <div class="tfq-item-actions tfq-task-actions">
          <button class="tfq-mini-btn ${editClass}" data-id="${Number(task.id)}" title="${escapeHtml(editTitle)}" ${canEditTask ? '' : 'disabled'}>Editar</button>
          ${primaryAction}
          ${cancelAction}
          <button class="tfq-mini-btn ${actionClass}" data-action="archive" data-id="${Number(task.id)}" ${canAdminTask ? '' : 'disabled'}>Arquivar</button>
          <button class="tfq-mini-btn tfq-mini-btn-danger ${actionClass}" data-action="delete" data-id="${Number(task.id)}" ${canAdminTask ? '' : 'disabled'}>Excluir</button>
        </div>
      </div>
    `;
  }

  async function saveTask() {
    if (!canEditTasks()) {
      setTaskStatus('Seu usuário não tem permissão para salvar tarefas.', 'error');
      return;
    }

    const context = getCurrentContext();
    if (editingTaskId === 0 && !context.isValid) {
      setTaskStatus('Selecione uma conversa primeiro.', 'error');
      return;
    }

    const payload = getTaskFormData();
    if (!payload.title) {
      setTaskStatus('Informe o título da tarefa.', 'error');
      return;
    }

    const saveBtn = document.getElementById('tfq-task-save');
    if (saveBtn) saveBtn.disabled = true;
    setTaskStatus(editingTaskId > 0 ? 'Atualizando tarefa...' : 'Salvando tarefa...', '');

    try {
      const result = await fetchJson(`${API_BASE}/tasks.php`, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });

      clearTaskForm();
      await loadTasks(true);
      await loadTaskOverview(true);
      setTaskStatus(result.message || 'Tarefa salva.', 'success');
      sendRuntimeMessageSafe({ type: 'TFQ_REFRESH_REMINDERS' });
    } catch (error) {
      setTaskStatus(`Erro: ${error.message}`, 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function runTaskAction(action, id, task = null) {
    const labels = {
      complete: 'concluir esta tarefa?',
      reopen: 'reabrir esta tarefa?',
      cancel: 'cancelar esta tarefa?',
      archive: 'arquivar esta tarefa?',
      delete: 'excluir permanentemente esta tarefa?'
    };

    if (!id || !labels[action]) return;
    if (['archive', 'delete'].includes(action) && !canAdminTasks()) {
      setTaskStatus('Somente administradores podem arquivar ou excluir tarefas.', 'error');
      return;
    }
    if (!['archive', 'delete'].includes(action) && !canEditTasks()) {
      setTaskStatus('Seu usuário não tem permissão para alterar tarefas.', 'error');
      return;
    }

    const ok = window.confirm(`Deseja ${labels[action]}`);
    if (!ok) return;

    try {
      setTaskStatus('Atualizando tarefa...', '');
      const result = await fetchJson(`${API_BASE}/tasks.php`, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          action,
          id,
          ...(task ? getTaskIdentityPayload(task) : getLeadContextPayload())
        })
      });

      if (editingTaskId === id) clearTaskForm();
      if (action === 'complete' || action === 'cancel' || action === 'archive' || action === 'delete') {
        tasksCache = tasksCache.filter(item => Number(item.id) !== Number(id));
        updateTaskSummary();
        renderTasksList();
      }
      await loadTasks(true);
      await loadTaskOverview(true);
      setTaskStatus(result.message || 'Tarefa atualizada.', 'success');
      sendRuntimeMessageSafe({ type: 'TFQ_REFRESH_REMINDERS' });
    } catch (error) {
      setTaskStatus(`Erro: ${error.message}`, 'error');
    }
  }

  function setTaskDueInHours(hours) {
    const due = document.getElementById('tfq-task-due');
    if (!due) return;

    const date = new Date(Date.now() + hours * 60 * 60 * 1000);
    date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0);
    const pad = value => String(value).padStart(2, '0');
    due.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function applyTaskTemplate(title, hours = 24) {
    const titleEl = document.getElementById('tfq-task-title');
    if (titleEl) titleEl.value = title;
    setTaskDueInHours(hours);
    const notes = document.getElementById('tfq-task-notes');
    if (notes) notes.focus();
  }

  function renderPanel() {
    if (document.getElementById(PANEL_ID) || document.getElementById(TOGGLE_ID)) return;

    const toggle       = document.createElement('button');
    toggle.id          = TOGGLE_ID;
    toggle.type        = 'button';
    toggle.textContent = 'Negócios';
    toggle.setAttribute('aria-expanded', 'false');
    setupToggleDragging(toggle);

    const panel = document.createElement('aside');
    panel.id    = PANEL_ID;
    panel.setAttribute('aria-label', 'Painel de negócios do lead');

    panel.innerHTML = `
      <div id="tfq-header">
        <div>
          <h2 id="tfq-title">Zap Negócios</h2>
          <div id="tfq-subtitle">Origem: <span id="tfq-conversation-id">-</span></div>
        </div>
        <button id="tfq-close" type="button" aria-label="Fechar painel">×</button>
      </div>

      <div id="tfq-not-configured" class="tfq-not-configured tfq-hidden">
        <p>⚠️ Login necessário.</p>
        <p>Clique com o botão direito no ícone da extensão → <strong>Opções</strong>, configure o servidor e faça login.</p>
        <button class="tfq-btn tfq-btn-primary tfq-btn-small" id="tfq-open-options" type="button">Abrir configurações</button>
      </div>

      <div id="tfq-tabs">
        <button class="tfq-tab tfq-tab-active" data-tab="negocios" type="button">📋 Negócios</button>
        <button class="tfq-tab" data-tab="tarefas" type="button">✅ Tarefas <span id="tfq-task-tab-count" class="tfq-tab-count tfq-hidden"></span></button>
        <button class="tfq-tab" data-tab="preferencias" type="button">⚙️ Preferências</button>
        <button class="tfq-tab" data-tab="usuarios" type="button">🛡️ Admin</button>
      </div>

      <div id="tfq-overdue-alert" class="tfq-overdue-alert tfq-hidden">
        <span id="tfq-overdue-alert-text"></span>
        <button class="tfq-mini-btn" id="tfq-overdue-alert-open" type="button">Ver tarefas</button>
      </div>

      <div id="tfq-body">

        <!-- ABA NEGÓCIOS -->
        <div id="tfq-tab-negocios" class="tfq-tab-pane">
          <section class="tfq-card">
            <h3>Selecione ou crie um negócio</h3>
            <div class="tfq-row">
              <label class="tfq-label" for="tfq-negocios-dropdown">Negócios desta conversa</label>
              <select class="tfq-select" id="tfq-negocios-dropdown">
                <option value="">-- Novo negócio --</option>
              </select>
            </div>
            <label class="tfq-check-row tfq-admin-only" for="tfq-include-deleted">
              <input id="tfq-include-deleted" type="checkbox" />
              <span>Mostrar negócios excluídos</span>
            </label>
            <div id="tfq-task-summary" class="tfq-task-summary"></div>
          </section>

          <section class="tfq-card">
            <div class="tfq-section-head">
              <div>
                <h3 id="tfq-form-title">Novo negócio</h3>
                <div id="tfq-editing-badge" class="tfq-editing-badge"></div>
              </div>
              <button class="tfq-mini-btn tfq-hidden" id="tfq-edit-negocio" type="button">Editar</button>
            </div>
            <div class="tfq-grid" id="tfq-negocio-form-grid">
              ${fields.map(createField).join('')}
            </div>
            <div class="tfq-actions">
              <button class="tfq-btn tfq-btn-primary"   id="tfq-save"   type="button">Salvar</button>
              <button class="tfq-btn tfq-btn-danger"    id="tfq-delete" type="button" disabled>Excluir</button>
              <button class="tfq-btn tfq-btn-secondary tfq-hidden" id="tfq-restore" type="button" disabled>Restaurar</button>
              <button class="tfq-btn tfq-btn-secondary" id="tfq-cancel" type="button">Limpar</button>
              <button class="tfq-btn tfq-btn-secondary" id="tfq-reload" type="button">Recarregar</button>
            </div>
            <div id="tfq-status"></div>
          </section>
        </div>

        <!-- ABA TAREFAS -->
        <div id="tfq-tab-tarefas" class="tfq-tab-pane tfq-tab-pane-hidden">
          <details class="tfq-card tfq-admin-section tfq-task-section" id="tfq-task-overview-section" open>
            <summary class="tfq-admin-summary">
              <span id="tfq-task-overview-title">Visão geral de tarefas</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div id="tfq-task-overview-stats" class="tfq-task-overview-stats"></div>
              <div id="tfq-task-overview-list" class="tfq-task-overview-list"></div>
              <div id="tfq-task-overview-status"></div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section tfq-task-section" id="tfq-current-tasks-section">
            <summary class="tfq-admin-summary">
              <span>Tarefas do lead atual</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div id="tfq-tasks-list"></div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section tfq-task-section" id="tfq-task-form-section">
            <summary class="tfq-admin-summary">
              <span id="tfq-task-form-title">Nova tarefa</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div id="tfq-task-editing-badge" class="tfq-editing-badge"></div>

              <div class="tfq-task-templates">
                <button class="tfq-mini-btn tfq-task-template" data-title="Retornar contato" data-hours="4" type="button">Retornar</button>
                <button class="tfq-mini-btn tfq-task-template" data-title="Enviar cotação" data-hours="24" type="button">Cotação</button>
                <button class="tfq-mini-btn tfq-task-template" data-title="Confirmar pagamento" data-hours="24" type="button">Pagamento</button>
                <button class="tfq-mini-btn tfq-task-template" data-title="Solicitar documentos" data-hours="24" type="button">Documentos</button>
                <button class="tfq-mini-btn tfq-task-template" data-title="Fazer follow-up" data-hours="48" type="button">Follow-up</button>
              </div>

              <div class="tfq-grid">
                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-task-title">Título da tarefa</label>
                  <input class="tfq-input" id="tfq-task-title" type="text" placeholder="ex: Retornar contato" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-task-negocio">Negócio relacionado</label>
                  <select class="tfq-select" id="tfq-task-negocio">
                    <option value="">Nenhum negócio específico</option>
                  </select>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-task-due">Lembrete</label>
                  <input class="tfq-input" id="tfq-task-due" type="datetime-local" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-task-priority">Prioridade</label>
                  <select class="tfq-select" id="tfq-task-priority">
                    <option value="baixa">Baixa</option>
                    <option value="normal" selected>Normal</option>
                    <option value="alta">Alta</option>
                  </select>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-task-assigned-user">Responsável</label>
                  <select class="tfq-select" id="tfq-task-assigned-user">
                    <option value="">Carregando usuários...</option>
                  </select>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-task-notes">Observação</label>
                  <textarea class="tfq-textarea" id="tfq-task-notes" rows="3"></textarea>
                </div>
              </div>

              <div class="tfq-actions">
                <button class="tfq-btn tfq-btn-primary" id="tfq-task-save" type="button">Salvar tarefa</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-task-clear" type="button">Limpar</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-task-reload" type="button">Recarregar</button>
              </div>
              <div id="tfq-task-status"></div>
            </div>
          </details>
        </div>

        <!-- ABA PREFERÊNCIAS -->
        <div id="tfq-tab-preferencias" class="tfq-tab-pane tfq-tab-pane-hidden">
          <details class="tfq-card tfq-admin-section" open>
            <summary class="tfq-admin-summary">
              <span>Tema da janela</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div class="tfq-grid">
                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-theme-mode">Tema</label>
                  <select class="tfq-select" id="tfq-theme-mode">
                    <option value="auto">Automático</option>
                    <option value="light">Claro</option>
                    <option value="dark">Escuro</option>
                  </select>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-theme-night-start">Início do modo noite</label>
                  <input class="tfq-input" id="tfq-theme-night-start" type="time" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-theme-night-end">Fim do modo noite</label>
                  <input class="tfq-input" id="tfq-theme-night-end" type="time" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-theme-day-primary">Cor principal do tema claro</label>
                  <input class="tfq-color-input" id="tfq-theme-day-primary" type="color" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-theme-night-primary">Cor principal do tema escuro</label>
                  <input class="tfq-color-input" id="tfq-theme-night-primary" type="color" />
                </div>

                <label class="tfq-check-row" for="tfq-theme-apply-crm">
                  <input id="tfq-theme-apply-crm" type="checkbox" />
                  Aplicar tema também no CRM
                </label>
              </div>

              <div class="tfq-actions">
                <button class="tfq-btn tfq-btn-primary" id="tfq-save-theme-settings" type="button">Salvar tema</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-reset-theme-settings" type="button">Restaurar padrão</button>
              </div>
              <div id="tfq-theme-settings-status"></div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section">
            <summary class="tfq-admin-summary">
              <span>Botão flutuante</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div class="tfq-grid">
                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-toggle-label">Texto do botão</label>
                  <input class="tfq-input" id="tfq-toggle-label" type="text" maxlength="24" placeholder="ex: Negócios" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-toggle-x">Posição horizontal</label>
                  <div class="tfq-range-row">
                    <input id="tfq-toggle-x" type="range" min="8" max="1200" step="1" />
                    <input class="tfq-input" id="tfq-toggle-x-number" type="number" min="8" max="1200" step="1" />
                  </div>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-toggle-y">Posição vertical</label>
                  <div class="tfq-range-row">
                    <input id="tfq-toggle-y" type="range" min="8" max="720" step="1" />
                    <input class="tfq-input" id="tfq-toggle-y-number" type="number" min="8" max="720" step="1" />
                  </div>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-toggle-color">Cor do botão</label>
                  <input class="tfq-color-input" id="tfq-toggle-color" type="color" />
                </div>
              </div>

              <div class="tfq-actions">
                <button class="tfq-btn tfq-btn-primary" id="tfq-save-toggle-appearance" type="button">Salvar botão</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-reset-toggle-appearance" type="button">Restaurar padrão</button>
              </div>
              <div id="tfq-toggle-appearance-status"></div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section">
            <summary class="tfq-admin-summary">
              <span>Janela do Zap Negócios</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div class="tfq-grid">
                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-panel-slide-ms">Tempo do slide da janela (ms)</label>
                  <div class="tfq-range-row">
                    <input id="tfq-panel-slide-ms" type="range" min="0" max="800" step="10" />
                    <input class="tfq-input" id="tfq-panel-slide-ms-number" type="number" min="0" max="800" step="10" />
                  </div>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-panel-rebuild-delay-ms">Pausa ao trocar conversa (ms)</label>
                  <div class="tfq-range-row">
                    <input id="tfq-panel-rebuild-delay-ms" type="range" min="0" max="600" step="10" />
                    <input class="tfq-input" id="tfq-panel-rebuild-delay-ms-number" type="number" min="0" max="600" step="10" />
                  </div>
                </div>
              </div>

              <div class="tfq-actions">
                <button class="tfq-btn tfq-btn-primary" id="tfq-save-panel-settings" type="button">Salvar janela</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-reset-panel-settings" type="button">Restaurar padrão</button>
              </div>
              <div id="tfq-panel-settings-status"></div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section">
            <summary class="tfq-admin-summary">
              <span>Notificações</span>
            </summary>
            <div class="tfq-admin-section-body">
              <label class="tfq-check-row" for="tfq-notifications-enabled">
                <input id="tfq-notifications-enabled" type="checkbox" />
                Ativar lembretes de tarefas
              </label>

              <div class="tfq-grid">
                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-notification-interval">Verificar tarefas a cada (minutos)</label>
                  <input class="tfq-input" id="tfq-notification-interval" type="number" min="1" max="120" step="1" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-notification-lookahead">Avisar com antecedência de (minutos)</label>
                  <input class="tfq-input" id="tfq-notification-lookahead" type="number" min="0" max="1440" step="5" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-notification-history-days">Evitar repetição por (dias)</label>
                  <input class="tfq-input" id="tfq-notification-history-days" type="number" min="1" max="60" step="1" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-notification-in-app-minutes">Repetir alerta interno a cada (minutos)</label>
                  <input class="tfq-input" id="tfq-notification-in-app-minutes" type="number" min="5" max="240" step="5" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-notification-normal-priority">Prioridade da notificação normal</label>
                  <select class="tfq-select" id="tfq-notification-normal-priority">
                    <option value="0">Baixa</option>
                    <option value="1">Normal</option>
                    <option value="2">Alta</option>
                  </select>
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-notification-high-priority">Prioridade para tarefas altas</label>
                  <select class="tfq-select" id="tfq-notification-high-priority">
                    <option value="0">Baixa</option>
                    <option value="1">Normal</option>
                    <option value="2">Alta</option>
                  </select>
                </div>

                <label class="tfq-check-row" for="tfq-notification-sound-enabled">
                  <input id="tfq-notification-sound-enabled" type="checkbox" />
                  Tocar som quando houver tarefa atrasada
                </label>

                <label class="tfq-check-row" for="tfq-notification-email-enabled">
                  <input id="tfq-notification-email-enabled" type="checkbox" />
                  Enviar resumo por email
                </label>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-notification-email-interval">Repetir email a cada (minutos)</label>
                  <input class="tfq-input" id="tfq-notification-email-interval" type="number" min="15" max="1440" step="15" />
                </div>
              </div>

              <div class="tfq-actions">
                <button class="tfq-btn tfq-btn-primary" id="tfq-save-notification-settings" type="button">Salvar notificações</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-reset-notification-settings" type="button">Restaurar padrão</button>
              </div>
              <div id="tfq-notification-settings-status"></div>
            </div>
          </details>
        </div>

        <!-- ABA ADMIN -->
        <div id="tfq-tab-usuarios" class="tfq-tab-pane tfq-tab-pane-hidden">
          <details class="tfq-card tfq-admin-section" data-admin-permission="tasks.admin" open>
            <summary class="tfq-admin-summary">
              <span>Tarefas</span>
            </summary>
            <div class="tfq-admin-section-body">
              <label class="tfq-check-row" for="tfq-auto-followup-enabled">
                <input id="tfq-auto-followup-enabled" type="checkbox" />
                Criar nova tarefa automaticamente ao concluir
              </label>

              <div class="tfq-grid">
                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-auto-followup-title">Título da nova tarefa</label>
                  <input class="tfq-input" id="tfq-auto-followup-title" type="text" maxlength="80" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-auto-followup-hours">Prazo padrão (horas)</label>
                  <input class="tfq-input" id="tfq-auto-followup-hours" type="number" min="1" max="720" step="1" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-auto-followup-start">Início do horário comercial</label>
                  <input class="tfq-input" id="tfq-auto-followup-start" type="time" />
                </div>

                <div class="tfq-row">
                  <label class="tfq-label" for="tfq-auto-followup-end">Fim do horário comercial</label>
                  <input class="tfq-input" id="tfq-auto-followup-end" type="time" />
                </div>
              </div>

              <div class="tfq-actions">
                <button class="tfq-btn tfq-btn-primary" id="tfq-save-task-automation" type="button">Salvar tarefas</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-reset-task-automation" type="button">Restaurar padrão</button>
              </div>
              <div id="tfq-task-automation-status"></div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section" data-admin-permission="admin.fields.view">
            <summary class="tfq-admin-summary">
              <span>Campos personalizados</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div class="tfq-admin-block">
                <h3>Adicionar campo personalizado</h3>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-field-name">Nome do campo (snake_case)</label>
                  <input class="tfq-input" id="tfq-new-field-name" type="text" placeholder="ex: numero_voo" />
                </div>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-field-label">Rótulo exibido</label>
                  <input class="tfq-input" id="tfq-new-field-label" type="text" placeholder="ex: Número do voo" />
                </div>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-field-type">Tipo do campo</label>
                  <select class="tfq-select" id="tfq-new-field-type">
                    <option value="text">Texto</option>
                    <option value="textarea">Texto longo</option>
                    <option value="select">Lista</option>
                    <option value="date">Data</option>
                    <option value="number">Número</option>
                    <option value="currency">Valor</option>
                  </select>
                </div>
                <div class="tfq-row tfq-hidden" id="tfq-new-field-options-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-field-options">Opções da lista</label>
                  <textarea class="tfq-textarea" id="tfq-new-field-options" rows="3" placeholder="Uma opção por linha"></textarea>
                </div>
                <div class="tfq-actions">
                  <button class="tfq-btn tfq-btn-primary" id="tfq-add-field-btn" type="button">Adicionar campo</button>
                </div>
              </div>

              <div class="tfq-admin-block">
                <h3>Campos do formulário</h3>
                <p class="tfq-fields-hint">Use ↑↓ para reordenar. Edite rótulo, tipo e opções e clique ✓ para salvar no servidor. Campos padrão não podem ser removidos.</p>
                <div id="tfq-fields-list" style="margin-top:10px;"></div>
                <div id="tfq-fields-status" style="margin-top:10px; font: 600 13px/1.4 Arial, sans-serif;"></div>
              </div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section" data-admin-permission="admin.users.view">
            <summary class="tfq-admin-summary">
              <span>Usuários e permissões</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div class="tfq-admin-block">
                <h3>Adicionar usuário</h3>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-user-username">Usuário</label>
                  <input class="tfq-input" id="tfq-new-user-username" type="text" placeholder="ex: maria" />
                </div>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-user-name">Nome</label>
                  <input class="tfq-input" id="tfq-new-user-name" type="text" placeholder="ex: Maria Silva" />
                </div>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-user-email">Email</label>
                  <input class="tfq-input" id="tfq-new-user-email" type="email" placeholder="ex: maria@empresa.com" />
                </div>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-user-password">Senha temporária</label>
                  <input class="tfq-input" id="tfq-new-user-password" type="password" />
                </div>
                <div class="tfq-row" style="margin-top:10px;">
                  <label class="tfq-label" for="tfq-new-user-role">Permissão</label>
                  <select class="tfq-select" id="tfq-new-user-role">
                    <option value="viewer">Viewer - só consulta</option>
                    <option value="editor" selected>Editor - consulta e salva</option>
                    <option value="admin">Admin - campos, usuários e exclusões</option>
                    <option value="owner">Owner - controle total</option>
                  </select>
                </div>
                <div class="tfq-actions">
                  <button class="tfq-btn tfq-btn-primary" id="tfq-add-user-btn" type="button">Adicionar usuário</button>
                </div>
              </div>

              <div class="tfq-admin-block">
                <h3>Permissões por grupo</h3>
                <div id="tfq-role-permissions-list" class="tfq-role-permissions-list" style="margin-top:10px;"></div>
                <div id="tfq-role-permissions-status" style="margin-top:10px; font: 600 13px/1.4 Arial, sans-serif;"></div>
              </div>

              <div class="tfq-admin-block">
                <h3>Usuários</h3>
                <div id="tfq-users-list" style="margin-top:10px;"></div>
                <div id="tfq-users-status" style="margin-top:10px; font: 600 13px/1.4 Arial, sans-serif;"></div>
              </div>
            </div>
          </details>

          <details class="tfq-card tfq-admin-section" data-admin-permission="admin.audit.view">
            <summary class="tfq-admin-summary">
              <span>Backup e auditoria</span>
            </summary>
            <div class="tfq-admin-section-body">
              <div class="tfq-actions">
                <button class="tfq-btn tfq-btn-primary" id="tfq-download-backup" type="button">Baixar backup JSON</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-download-audit" type="button">Baixar log</button>
                <button class="tfq-btn tfq-btn-secondary" id="tfq-reload-audit" type="button">Recarregar auditoria</button>
              </div>
              <div id="tfq-audit-status" style="margin-top:10px; font: 600 13px/1.4 Arial, sans-serif;"></div>
              <div id="tfq-audit-list" class="tfq-audit-list" style="margin-top:10px;"></div>
            </div>
          </details>
        </div>

      </div>
      <footer id="tfq-footer">Zap Negócios - Por <a href="https://macari.com.br" target="_blank" rel="noopener noreferrer">Ricardo Macari</a>.</footer>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);
    installNegocioEditGuard(panel);
    Promise.resolve()
      .then(() => userConfigLoaded ? undefined : loadUserConfig())
      .then(() => toggleSettingsLoaded ? applyToggleSettings() : loadToggleSettings())
      .then(() => panelSettingsLoaded ? applyPanelSettings() : loadPanelSettings())
      .then(() => notificationSettingsLoaded ? undefined : loadNotificationSettings())
      .then(() => taskAutomationSettingsLoaded ? undefined : loadTaskAutomationSettings())
      .then(() => themeSettingsLoaded ? applyThemeSettings() : loadThemeSettings())
      .then(() => {
        renderThemeSettingsForm();
        renderToggleAppearanceForm();
        renderPanelSettingsForm();
        renderNotificationSettingsForm();
        renderTaskAutomationSettingsForm();
        refreshOverdueBadgesOnPageLoad();
      });

    async function openPanel() {
      panel.classList.add('tfq-open');
      toggle.setAttribute('aria-expanded', 'true');

      if (!userConfigLoaded) await loadUserConfig();
      if (!toggleSettingsLoaded) {
        await loadToggleSettings();
      } else {
        applyToggleSettings();
      }
      if (!panelSettingsLoaded) {
        await loadPanelSettings();
      } else {
        applyPanelSettings();
      }
      if (!notificationSettingsLoaded) await loadNotificationSettings();
      if (!taskAutomationSettingsLoaded) await loadTaskAutomationSettings();
      renderTaskAutomationSettingsForm();
      if (!themeSettingsLoaded) {
        await loadThemeSettings();
      } else {
        applyThemeSettings();
      }

      const notConfiguredEl = document.getElementById('tfq-not-configured');
      const tabsEl          = document.getElementById('tfq-tabs');
      const bodyEl          = document.getElementById('tfq-body');
      const tabAdmin        = panel.querySelector('.tfq-tab[data-tab="usuarios"]');
      const tabTasks        = panel.querySelector('.tfq-tab[data-tab="tarefas"]');
      const saveBtn         = document.getElementById('tfq-save');
      const taskSaveBtn     = document.getElementById('tfq-task-save');
      const includeDeletedRow = document.querySelector('label[for="tfq-include-deleted"]');

      if (!isConfigured()) {
        panelRebuildContextKey = '';
        if (notConfiguredEl) notConfiguredEl.classList.remove('tfq-hidden');
        if (tabsEl)          tabsEl.classList.add('tfq-hidden');
        if (bodyEl)          bodyEl.classList.add('tfq-hidden');
        return;
      }

      if (notConfiguredEl) notConfiguredEl.classList.add('tfq-hidden');
      if (tabsEl)          tabsEl.classList.remove('tfq-hidden');
      if (bodyEl)          bodyEl.classList.remove('tfq-hidden');

      if (saveBtn) {
        saveBtn.disabled = !canEdit();
        saveBtn.title = canEdit() ? 'Salvar negócio' : 'Seu usuário não tem permissão para salvar negócios';
      }
      if (taskSaveBtn) {
        taskSaveBtn.disabled = !canEditTasks();
        taskSaveBtn.title = canEditTasks() ? 'Salvar tarefa' : 'Seu usuário não tem permissão para salvar tarefas';
      }

      if (tabTasks) tabTasks.classList.toggle('tfq-hidden', !canViewTasks());
      applyAdminSectionPermissions();
      if (tabAdmin && !canAccessAdmin()) {
        const tabNegocios = panel.querySelector('.tfq-tab[data-tab="negocios"]');
        if (tabNegocios) tabNegocios.click();
      }

      const deleteBtn = document.getElementById('tfq-delete');
      if (deleteBtn && !canDeleteNegocio()) {
        deleteBtn.disabled = true;
        deleteBtn.title = 'Seu usuário não tem permissão para excluir negócios';
      }
      if (includeDeletedRow) {
        includeDeletedRow.classList.toggle('tfq-hidden', !(canDeleteNegocio() || canRestoreNegocio()));
      }

      updateUserRoleOptions();
      renderThemeSettingsForm();
      renderToggleAppearanceForm();
      renderPanelSettingsForm();
      renderNotificationSettingsForm();

      if (!formFieldsLoadedFromServer) await loadFormFields();
      negocioLoadingLocked = true;
      renderFormFields();
      clearTaskForm();
      await loadNegocios(true, true);
      loadPanelSecondaryData();
      panelRebuildContextKey = '';
    }

    function closePanel() {
      panel.classList.remove('tfq-open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', event => {
      if (suppressNextToggleClick) {
        event.preventDefault();
        return;
      }
      panel.classList.contains('tfq-open') ? closePanel() : openPanel();
    });

    // ✅ CORRIGIDO: querySelector com template literal correta
    panel.querySelectorAll('.tfq-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.tfq-tab').forEach(t => t.classList.remove('tfq-tab-active'));
        tab.classList.add('tfq-tab-active');

        const target = tab.dataset.tab;
        panel.querySelectorAll('.tfq-tab-pane').forEach(pane => pane.classList.add('tfq-tab-pane-hidden'));

        const activePane = document.getElementById(`tfq-tab-${target}`);
        if (activePane) activePane.classList.remove('tfq-tab-pane-hidden');

        if (target === 'tarefas' && !canViewTasks()) return;
        if (target === 'tarefas') {
          if (focusTaskNavigationPending && focusedTaskId > 0) {
            setTaskSectionsState('lead');
          } else {
            focusedTaskId = 0;
            setTaskSectionsState('overview');
          }
          loadTaskAssignees();
          loadTasks(true).finally(() => {
            if (focusTaskNavigationPending && focusedTaskId > 0) {
              setTaskSectionsState('lead');
              scrollFocusedTaskIntoView();
              focusTaskNavigationPending = false;
            }
          });
          loadTaskOverview(true);
        }
        if (target === 'usuarios') {
          applyAdminSectionPermissions();
          if (hasPermission('admin.fields.view', 'admin') || hasPermission('admin.fields.edit', 'admin')) loadFields();
          if (canViewUsersAdmin()) loadUsers();
          if (hasPermission('admin.audit.view', 'admin')) loadAuditLog();
        }
        if (target === 'preferencias') {
          renderThemeSettingsForm();
          renderToggleAppearanceForm();
          renderPanelSettingsForm();
          renderNotificationSettingsForm();
        }
      });
    });

    const dropdown = panel.querySelector('#tfq-negocios-dropdown');
    if (dropdown) dropdown.addEventListener('change', onNegocioSelected);

    const openOptionsBtn = panel.querySelector('#tfq-open-options');
    if (openOptionsBtn) {
      openOptionsBtn.addEventListener('click', () => {
        sendRuntimeMessageSafe({ type: 'TFQ_OPEN_OPTIONS' });
      });
    }

    panel.querySelector('#tfq-close').addEventListener('click', closePanel);
    panel.querySelector('#tfq-save').addEventListener('click', saveNegocio);
    panel.querySelector('#tfq-edit-negocio').addEventListener('click', editSelectedNegocio);
    panel.querySelector('#tfq-delete').addEventListener('click', deleteNegocio);
    panel.querySelector('#tfq-restore').addEventListener('click', restoreNegocio);
    panel.querySelector('#tfq-include-deleted').addEventListener('change', () => {
      if (!confirmDiscardChanges('Há alterações não salvas. Deseja recarregar e descartá-las?')) {
        const checkbox = document.getElementById('tfq-include-deleted');
        if (checkbox) checkbox.checked = !checkbox.checked;
        return;
      }
      negociosCache = [];
      currentConversationId = '';
      setEditingState(0);
      loadNegocios(true);
    });
    panel.querySelector('#tfq-task-save').addEventListener('click', saveTask);
    panel.querySelector('#tfq-task-clear').addEventListener('click', () => {
      clearTaskForm();
      setTaskStatus('Formulário de tarefa limpo.', '');
    });
    panel.querySelector('#tfq-task-reload').addEventListener('click', () => {
      loadTasks(true);
      loadTaskOverview(true);
    });
    panel.querySelector('#tfq-overdue-alert-open').addEventListener('click', () => {
      openTasksTab();
      setTaskSectionsState('overview');
      loadTaskOverview(true);
    });
    panel.querySelector('#tfq-reload').addEventListener('click', () => {
      if (!confirmDiscardChanges('Há alterações não salvas. Deseja recarregar e descartá-las?')) return;
      negociosCache         = [];
      currentConversationId = '';
      loadNegocios(true);
      loadTasks(true);
      loadTaskOverview(true);
    });
    panel.querySelector('#tfq-cancel').addEventListener('click', cancelNegocioEdit);

    panel.querySelector('#tfq-add-field-btn').addEventListener('click', addField);
    panel.querySelector('#tfq-add-user-btn').addEventListener('click', addUser);
    panel.querySelector('#tfq-download-backup').addEventListener('click', downloadBackup);
    panel.querySelector('#tfq-download-audit').addEventListener('click', downloadAuditLog);
    panel.querySelector('#tfq-reload-audit').addEventListener('click', loadAuditLog);
    panel.querySelector('#tfq-save-theme-settings').addEventListener('click', saveThemeSettingsFromForm);
    panel.querySelector('#tfq-reset-theme-settings').addEventListener('click', resetThemeSettings);
    panel.querySelector('#tfq-save-toggle-appearance').addEventListener('click', saveToggleAppearance);
    panel.querySelector('#tfq-reset-toggle-appearance').addEventListener('click', resetToggleAppearance);
    panel.querySelector('#tfq-save-panel-settings').addEventListener('click', savePanelSettingsFromForm);
    panel.querySelector('#tfq-reset-panel-settings').addEventListener('click', resetPanelSettings);
    panel.querySelector('#tfq-save-notification-settings').addEventListener('click', saveNotificationSettingsFromForm);
    panel.querySelector('#tfq-reset-notification-settings').addEventListener('click', resetNotificationSettings);
    panel.querySelector('#tfq-save-task-automation').addEventListener('click', saveTaskAutomationSettingsFromForm);
    panel.querySelector('#tfq-reset-task-automation').addEventListener('click', resetTaskAutomationSettings);
    panel.querySelector('#tfq-theme-mode').addEventListener('change', previewThemeSettings);
    panel.querySelector('#tfq-theme-night-start').addEventListener('input', previewThemeSettings);
    panel.querySelector('#tfq-theme-night-end').addEventListener('input', previewThemeSettings);
    panel.querySelector('#tfq-theme-day-primary').addEventListener('input', previewThemeSettings);
    panel.querySelector('#tfq-theme-night-primary').addEventListener('input', previewThemeSettings);
    panel.querySelector('#tfq-theme-apply-crm').addEventListener('change', toggleCrmThemeFromForm);
    panel.querySelector('#tfq-toggle-label').addEventListener('input', previewToggleAppearance);
    panel.querySelector('#tfq-toggle-color').addEventListener('input', previewToggleAppearance);
    panel.querySelector('#tfq-toggle-x').addEventListener('input', e => {
      const numberInput = panel.querySelector('#tfq-toggle-x-number');
      if (numberInput) numberInput.value = e.target.value;
      previewToggleAppearance();
    });
    panel.querySelector('#tfq-toggle-x-number').addEventListener('input', e => {
      const rangeInput = panel.querySelector('#tfq-toggle-x');
      if (rangeInput) rangeInput.value = e.target.value;
      previewToggleAppearance();
    });
    panel.querySelector('#tfq-toggle-y').addEventListener('input', e => {
      const numberInput = panel.querySelector('#tfq-toggle-y-number');
      if (numberInput) numberInput.value = e.target.value;
      previewToggleAppearance();
    });
    panel.querySelector('#tfq-toggle-y-number').addEventListener('input', e => {
      const rangeInput = panel.querySelector('#tfq-toggle-y');
      if (rangeInput) rangeInput.value = e.target.value;
      previewToggleAppearance();
    });
    panel.querySelector('#tfq-panel-slide-ms').addEventListener('input', e => {
      const numberInput = panel.querySelector('#tfq-panel-slide-ms-number');
      if (numberInput) numberInput.value = e.target.value;
      previewPanelSettings();
    });
    panel.querySelector('#tfq-panel-slide-ms-number').addEventListener('input', e => {
      const rangeInput = panel.querySelector('#tfq-panel-slide-ms');
      if (rangeInput) rangeInput.value = e.target.value;
      previewPanelSettings();
    });
    panel.querySelector('#tfq-panel-rebuild-delay-ms').addEventListener('input', e => {
      const numberInput = panel.querySelector('#tfq-panel-rebuild-delay-ms-number');
      if (numberInput) numberInput.value = e.target.value;
      previewPanelSettings();
    });
    panel.querySelector('#tfq-panel-rebuild-delay-ms-number').addEventListener('input', e => {
      const rangeInput = panel.querySelector('#tfq-panel-rebuild-delay-ms');
      if (rangeInput) rangeInput.value = e.target.value;
      previewPanelSettings();
    });
    panel.querySelector('#tfq-new-field-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') addField();
    });
    panel.querySelector('#tfq-new-user-username').addEventListener('keydown', e => {
      if (e.key === 'Enter') addUser();
    });
    panel.querySelector('#tfq-new-field-type').addEventListener('change', e => {
      const row = panel.querySelector('#tfq-new-field-options-row');
      if (row) row.classList.toggle('tfq-hidden', e.target.value !== 'select');
    });
    panel.querySelectorAll('.tfq-task-template').forEach(btn => {
      btn.addEventListener('click', () => applyTaskTemplate(btn.dataset.title || '', Number(btn.dataset.hours || 24)));
    });

    updateConversationIdUI();
    updateTaskSummary();
    panelInitialized = true;
  }

  function checkVisibility() {
    const context = getCurrentContext();
    const currentId = getContextKey(context);

    if (currentId !== lastCheckedConversationId) {
      lastCheckedConversationId = currentId;

      const panel = getPanel();
      if (panel && panel.classList.contains('tfq-open') && context.isValid) {
        if (rebuildOpenPanelForConversation(currentId)) return;
      }
    }

    if (hasValidConversation()) {
      if (panelRebuildContextKey) return;
      if (!panelInitialized) renderPanel();
    } else {
      if (panelInitialized)  removePanel();
    }
  }

  function ensurePanel() {
    if (!hasValidConversation()) {
      removePanel();
      return;
    }
    if (panelInitialized || panelRebuildContextKey) return;
    renderPanel();
  }

  function syncConversation(force = false) {
    const context = getCurrentContext();
    const contextKey = getContextKey(context);

    if (!context.isValid) {
      removePanel();
      return;
    }

    ensurePanel();
    if (panelRebuildContextKey) return;

    if (getConversationIdDisplay()) updateConversationIdUI();
    updatePanelTitle();

    const isConversationChange = contextKey !== currentConversationId;
    if (isConversationChange && rebuildOpenPanelForConversation(contextKey)) return;

    if (force || isConversationChange) {
      currentConversationId = '';
      negociosCache         = [];
      tasksCache            = [];
      beginNegocioLoadingState();
      clearTaskForm();
      loadNegocios(true, isConversationChange).finally(() => {
        if (isConversationChange) scheduleCurrentNegocioViewModeLock();
      }); // autoSelect só em troca real de conversa
      loadTasks(true);
    }
  }

  function scheduleSync(force = false) {
    if (syncScheduled && !force) return;
    syncScheduled = true;
    window.setTimeout(() => {
      syncScheduled = false;
      syncConversation(force);
    }, force ? 30 : 120);
  }

  function startVisibilityCheck() {
    if (visibilityCheckInterval) clearInterval(visibilityCheckInterval);
    const intervalMs = getPlatform() === 'whatsapp_web' ? 1000 : 300;
    visibilityCheckInterval = setInterval(checkVisibility, intervalMs);
  }

  function stopVisibilityCheck() {
    if (visibilityCheckInterval) {
      clearInterval(visibilityCheckInterval);
      visibilityCheckInterval = null;
    }
  }

  function togglePanelFromAction() {
    if (!hasValidConversation()) {
      return false;
    }

    ensurePanel();
    const toggle = getToggle();
    if (!toggle) return false;
    toggle.click();
    return true;
  }

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'TFQ_TOGGLE_PANEL') {
        sendResponse({ ok: togglePanelFromAction() });
        return true;
      }
      return false;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      lastCheckedConversationId = getContextKey();
      checkVisibility();
      startVisibilityCheck();
      if (!panelRebuildContextKey) scheduleSync(true);
    });
  } else {
    lastCheckedConversationId = getContextKey();
    checkVisibility();
    startVisibilityCheck();
    scheduleSync(true);
  }

  // Evento customizado disparado pelo page-bridge.js ao detectar troca de URL.
  // O detail pode conter leadName capturado pelo bridge no momento da troca.
  window.addEventListener('tfq:conversation-change', (e) => {
    const leadName = e.detail && e.detail.leadName ? e.detail.leadName : null;
    checkVisibility();
    window.setTimeout(markActiveCrmConversation, 120);
    window.setTimeout(markReadableCrmBubbles, 160);
    window.setTimeout(markCrmThemeSurfaces, 180);
    if (!panelRebuildContextKey) scheduleSync(true);
    // Atualiza o título imediatamente com o nome capturado pelo bridge,
    // antes mesmo do loadNegocios terminar
    if (leadName) updatePanelTitle(leadName);
  });

  window.addEventListener('focus', () => {
    checkVisibility();
    if (!panelRebuildContextKey) scheduleSync(false);
  });

  window.addEventListener('beforeunload', event => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const observer = new MutationObserver(() => {
    if (observerDebounceTimer) clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      if (!panelInitialized && !hasValidConversation()) return;
      checkVisibility();
      markActiveCrmConversation();
      markReadableCrmBubbles();
      markCrmThemeSurfaces();
    }, 200);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree:   true
  });

})();
