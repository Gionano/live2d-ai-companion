import id from './i18n/id.json';
import en from './i18n/en.json';
import { translator, detectLanguage } from './settings/i18n.js';
import { canOpenSettings } from './settings/viewModel.js';
import { createSettingsClient } from './settings/apiClient.js';
import { needsWizard } from './settings/wizard.js';
import { node } from './settings/dom.js';

const t = translator(detectLanguage(navigator.language), { id, en });
const allowed = canOpenSettings({ hostname: location.hostname, mobile: navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) });
const settingsPage = location.hash === '#settings';
const browserWorkspace = !window.desktopBridge && new URLSearchParams(location.search).get('mode') !== 'overlay';
window.addEventListener('hashchange', () => { if ((location.hash === '#settings') !== settingsPage) location.reload(); });
if (window.desktopBridge) document.documentElement.classList.add('electron-mode');
if (new URLSearchParams(location.search).get('mode') === 'overlay') document.documentElement.classList.add('overlay-mode');

async function boot() {
if (settingsPage) {
  document.documentElement.classList.remove('overlay-mode', 'electron-mode');
  if (allowed) { const { mountSettings } = await import('./settings/page.js'); await mountSettings(); }
  else document.body.replaceChildren(node(document, 'p', t('app.hostOnly')));
} else {
  let firstRun = false;
  if (allowed) {
    try {
      const api = createSettingsClient();
      const [effective, status] = await Promise.all([api.get('/'), api.get('/status')]);
      firstRun = needsWizard(status, effective.settings);
    } catch { /* Existing companion can start while the backend is unavailable. */ }
  }
  if (firstRun && window.desktopBridge?.openSettings) {
    await window.desktopBridge.openSettings(true);
    document.getElementById('status').textContent = t('wizard.title');
    await import('./main.js');
  }
  else if (firstRun) { location.hash = 'settings'; }
  else {
    if (browserWorkspace) {
      await import('./browserChat.css');
      const { mountBrowserChat } = await import('./browserChat.js');
      mountBrowserChat({ document, canOpenSettings: allowed, openSettings: () => { location.hash = 'settings'; } });
    }
    const panel = document.querySelector('#companion-panel .panel-head');
    if (allowed && !browserWorkspace) {
      const entry = node(document, 'button', '⚙', { type: 'button', 'aria-label': t('app.gear'), title: t('app.gear') });
      entry.addEventListener('click', () => {
        if (window.desktopBridge?.openSettings) void window.desktopBridge.openSettings();
        else location.hash = 'settings';
      }); panel?.append(entry);
    } else if (!allowed && !browserWorkspace) panel?.append(node(document, 'p', t('app.hostOnly')));
    await Promise.all([import('./main.js'), import('./companion.js')]);
  }
}
}
boot().catch(() => { document.body.replaceChildren(node(document, 'p', t('error.generic'))); });
