import id from '../i18n/id.json';
import en from '../i18n/en.json';
import presets from './presets.json';
import setupGuide from '../../docs/setup.md?url';
import { translator, detectLanguage } from './i18n.js';
import { createSettingsClient } from './apiClient.js';
import { node } from './dom.js';
import { mountImageSettings } from './imageSettings.js';
import { TAB_LABELS, SLOT_LABELS, STATUS_WARNING_KEYS, DEFAULT_TTS_PARAMS, FISH_EMOTION_GROUPS, FISH_EMOTION_TAGS, emotionMapSelections, updateEmotionSelection, friendlyError, validateBaseUrl, originNeedsConfirmation, parseAdvanced, makeSlot, privacyFlows, withSecret } from './viewModel.js';
import { WIZARD_STEPS, WIZARD_LABELS, WIZARD_STORAGE_KEY, needsWizard, readWizard, moveWizard, saveWizard } from './wizard.js';
import './settings.css';

export async function mountSettings({ document = window.document, api = createSettingsClient(), storage = window.localStorage,
  navigatorLanguage = navigator.language, confirm = message => window.confirm(message) } = {}) {
  let language = detectLanguage(navigatorLanguage);
  let t = translator(language, { id, en });
  let effective;
  let status;
  let tab = 'connections';
  let selected = null;
  let busy = false;
  let fieldId = 0;
  let wizard;
  let imageController;
  try { wizard = readWizard(storage.getItem(WIZARD_STORAGE_KEY)); } catch { wizard = readWizard(null); }
  let showWizard = !wizard.completed;
  const root = node(document, 'main', undefined, { id: 'settings-page' });
  const toast = node(document, 'p', '', { role: 'status', 'aria-live': 'polite', class: 'settings-toast' });
  document.body.replaceChildren(root);
  root.append(node(document, 'h1', t('app.loading')));
  const el = (tag, text, attributes) => node(document, tag, text, attributes);
  const message = (key, vars) => { toast.textContent = t(key, vars); };
  const fail = error => { toast.textContent = t(friendlyError(error.code)) + ' (' + (error.code || 'BAD_RESPONSE') + ')'; };
  const button = (label, action, parent) => {
    const item = el('button', label, { type: 'button' });
    item.addEventListener('click', () => { if (!busy) Promise.resolve().then(action).catch(fail); });
    parent?.append(item); return item;
  };
  const field = (parent, key, value = '', { type = 'text', options, ...attrs } = {}) => {
    const label = el('label', t(key), { class: 'settings-field' });
    const input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input', undefined, { id: 'settings-field-' + ++fieldId, ...attrs });
    label.setAttribute('for', input.id);
    if (options) for (const [optionValue, text] of options) input.append(el('option', text, { value: optionValue }));
    else if (type !== 'textarea') input.type = type;
    input.value = value ?? '';
    label.append(input); parent.append(label); return input;
  };
  const checkbox = (parent, key, checked = false) => {
    const input = field(parent, key, '', { type: 'checkbox' }); input.checked = checked; return input;
  };
  const details = (parent, key) => { const box = el('details'); box.append(el('summary', t(key))); parent.append(box); return box; };
  const submit = (form, action) => {
    const item = el('button', t('action.save'), { type: 'submit' }); form.append(item);
    form.addEventListener('submit', event => { event.preventDefault(); if (!busy) Promise.resolve().then(action).catch(fail); });
  };
  async function load() {
    [effective, status] = await Promise.all([api.get('/'), api.get('/status')]);
    language = effective.sources['ui.language'] === 'default' ? detectLanguage(navigatorLanguage) : effective.settings.ui.language;
    t = translator(language, { id, en });
    if (needsWizard(status, effective.settings)) { showWizard = true; if (wizard.completed) wizard = readWizard(null); }
  }
  async function write(path, body, method = 'PUT') {
    const result = await api.write(path, { version: effective.version, ...body }, method);
    effective.version = result.version;
    return result;
  }
  async function change(operation) {
    busy = true; root.setAttribute('aria-busy', 'true');
    try { await operation(); await load(); render(); message('toast.saved'); }
    finally { busy = false; root.removeAttribute('aria-busy'); }
  }
  function providers(parent) {
    parent.append(el('h2', t('provider.title')));
    const list = el('div', undefined, { class: 'settings-actions' }); parent.append(list);
    for (const [name, profile] of Object.entries(effective.settings.profiles)) if (profile) button(name, () => { selected = name; render(); }, list);
    button(t('action.add'), () => { selected = null; render(); }, list);
    const previous = effective.settings.profiles[selected];
    const form = el('form', undefined, { autocomplete: 'off', class: 'settings-card' }); parent.append(form);
    const preset = field(form, 'provider.preset', 'custom', { options: presets.map(item => [item.id, t(item.labelKey)]) });
    const identifier = field(form, 'provider.id', selected || '', { required: '', maxlength: 64, pattern: '[A-Za-z0-9][A-Za-z0-9_-]*' });
    identifier.disabled = Boolean(selected);
    const adapter = field(form, 'provider.adapter', previous?.adapter || 'openaiCompatible', { options: [
      ['openaiCompatible', t('preset.compatible')], ['anthropicNative', t('preset.anthropic')], ['fishAudio', t('preset.fish')],
    ] });
    const url = field(form, 'provider.url', previous?.baseUrl?.startsWith('REPLACE_WITH_') ? '' : previous?.baseUrl || '', { required: '' });
    const environment = field(form, 'provider.environment', previous?.apiKeyEnv || '', { maxlength: 80 });
    const key = field(form, 'provider.key', '', { type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: 8192 });
    form.append(el('p', t('provider.keyHelp')));
    const metadata = effective.secrets[selected];
    form.append(el('p', t(metadata?.apiKey.has ? 'provider.present' : 'provider.absent', { suffix: metadata?.apiKey.last4 ? ' …' + metadata.apiKey.last4 : '' })));
    const deleteKey = checkbox(form, 'provider.deleteKey');
    const flagBox = details(form, 'provider.flags');
    const flags = Object.fromEntries([
      ['supportsImages', 'flag.images'], ['supportsStt', 'flag.stt'], ['supportsVerboseStt', 'flag.verbose'],
      ['supportsJsonMode', 'flag.json'], ['supportsStreamUsage', 'flag.usage'],
    ].map(([name, label]) => [name, checkbox(flagBox, label, previous?.flags?.[name] === true)]));
    const warning = el('p', '', { role: 'status' }); form.append(warning);
    const checkUrl = () => {
      try { warning.textContent = validateBaseUrl(url.value, { websocket: adapter.value === 'fishAudio' }).insecureTransport ? t('warning.http') : ''; }
      catch { warning.textContent = t('error.invalid'); }
    };
    url.addEventListener('change', checkUrl); adapter.addEventListener('change', checkUrl);
    preset.addEventListener('change', () => {
      const value = presets.find(item => item.id === preset.value);
      adapter.value = value.adapter; url.value = value.baseUrl; key.value = '';
      checkUrl(); if (value.maintainerVerificationRequired) warning.textContent += ' ' + t('warning.preset');
    });
    submit(form, () => withSecret(key, async apiKey => {
      validateBaseUrl(url.value, { websocket: adapter.value === 'fishAudio' });
      const name = identifier.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw { code: 'INVALID_SETTINGS' };
      const profile = { ...previous, adapter: adapter.value, baseUrl: url.value.trim(), apiKeyEnv: environment.value.trim() || null,
        flags: Object.fromEntries(Object.entries(flags).map(([name, input]) => [name, input.checked])) };
      const changed = originNeedsConfirmation(previous, profile, metadata);
      if (changed && !apiKey && !deleteKey.checked) throw { code: 'ORIGIN_CHANGE' };
      if (changed && !apiKey && !confirm(t('confirm.origin'))) return;
      await change(async () => {
        await write('/profiles/' + name, { profile, ...(apiKey && { secrets: { apiKey } }),
          ...(changed && !apiKey && { confirmDeleteSecrets: true }) }); selected = name;
      });
    }));
    if (selected) button(t('action.delete'), async () => {
      if (!confirm(t('confirm.delete', { id: selected }))) return;
      await change(async () => { await write('/profiles/' + selected, { force: true }, 'DELETE'); selected = null; });
      message('toast.deleted');
    }, form);
  }
  function resultView(parent, result, threshold) {
    parent.replaceChildren(el('p', t(result.ok ? 'test.success' : 'test.failure')));
    const table = el('table'); parent.append(table);
    for (const [label, value] of [['test.ttft', result.ttftMs], ['test.total', result.latencyMs],
      ['test.tokens', (result.tokens?.inputTokens ?? '—') + ' / ' + (result.tokens?.outputTokens ?? '—')]]) {
      const row = el('tr'); row.append(el('th', t(label), { scope: 'row' }), el('td', value ?? '—')); table.append(row);
    }
    if (result.error) parent.append(el('p', t(friendlyError(result.error.code)) + ' (' + result.error.code + ')'));
    if (result.ttftMs > threshold) parent.append(el('p', t('test.slow')));
  }
  function slotEditor(parent, name) {
    const current = effective.settings.slots[name];
    const previous = current?.followLlm ? effective.settings.slots.llm : current;
    const form = el('form', undefined, { class: 'settings-card', autocomplete: 'off' }); parent.append(form);
    form.append(el('h3', t(SLOT_LABELS[name])));
    if (['planner', 'visionFilter'].includes(name)) {
      const follow = checkbox(form, 'slot.follow', current?.followLlm || (!current && effective.sources['slots.' + name] === 'default'));
      follow.addEventListener('change', () => change(() => write('/slots/' + name, { slot: follow.checked ? { followLlm: true } : previous || null })).catch(fail));
    }
    const options = [['', t('slot.unassigned')], ...Object.entries(effective.settings.profiles).filter(([, value]) => value).map(([id]) => [id, id])];
    const profile = field(form, 'slot.profile', previous?.profile || selected || '', { options });
    const model = field(form, 'slot.model', previous?.model || '', { required: '', maxlength: 256 });
    const models = el('datalist', undefined, { id: 'settings-models-' + name }); form.append(models); model.setAttribute('list', models.id);
    const modelNotice = el('p', '', { 'aria-live': 'polite' }); form.append(modelNotice);
    const oneTimeKey = field(details(form, 'slot.advanced'), 'provider.key', '', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
    button(t('action.models'), () => withSecret(oneTimeKey, async apiKey => {
      busy = true;
      try {
        const response = await api.write('/models', { profile: profile.value, ...(apiKey && { apiKey }) }, 'POST');
        models.replaceChildren(...response.models.map(name => el('option', name, { value: name })));
        modelNotice.textContent = response.reason ? t('test.missingModels', { code: response.reason }) : '';
      } finally { busy = false; }
    }), form);
    const params = previous?.params || {};
    const temperature = field(form, 'slot.temperature', params.temperature ?? (name === 'tts' ? DEFAULT_TTS_PARAMS.temperature : ''), { type: 'number', min: 0, max: 2, step: name === 'tts' ? 'any' : 0.1 });
    const maxTokens = field(form, 'slot.maxTokens', params.maxTokens ?? '', { type: 'number', min: 1, max: 1000000 });
    const extra = {};
    const ttsFields = {};
    if (name === 'stt') extra.language = field(form, 'slot.language', params.language || 'id');
    if (name === 'tts') {
      extra.voice = field(form, 'slot.voice', params.voice || '');
      const formats = ['mp3', 'wav', 'opus', ...(params.format === 'pcm' ? ['pcm'] : [])];
      extra.format = field(form, 'slot.format', params.format || 'mp3', { options: formats.map(format => [format, format.toUpperCase()]) });
      const defaults = DEFAULT_TTS_PARAMS;
      const expression = { ...defaults.expression, ...params.expression,
        emotionTagMap: { ...defaults.expression.emotionTagMap, ...params.expression?.emotionTagMap } };
      const merge = { ...defaults.expression.mergeShortSentences, ...params.expression?.mergeShortSentences };
      const inline = { ...defaults.inlineTags, ...params.inlineTags };
      ttsFields.topP = field(form, 'tts.topP', params.topP ?? defaults.topP, { type: 'number', min: 0, max: 1, step: 'any' });
      ttsFields.latency = field(form, 'tts.latency', params.latency ?? defaults.latency, { options: [
        ['normal', t('tts.latencyNormal')], ['balanced', t('tts.latencyBalanced')], ['low', t('tts.latencyLow')],
      ] });
      ttsFields.speed = field(form, 'tts.speed', params.prosody?.speed ?? defaults.prosody.speed, { type: 'number', min: 0.5, max: 2, step: 'any' });
      ttsFields.volume = field(form, 'tts.volume', params.prosody?.volume ?? defaults.prosody.volume, { type: 'number', min: -20, max: 20, step: 'any' });
      const expressionBox = details(form, 'tts.expression');
      ttsFields.selection = field(expressionBox, 'tts.selection', expression.selection, { options: [
        ['native', t('tts.selectionNative')], ['mapped', t('tts.selectionMapped')],
      ] });
      expressionBox.append(el('p', t('tts.selectionHelp')));
      ttsFields.tagPlacement = field(expressionBox, 'tts.placement', expression.tagPlacement, { options: [
        ['every-sentence', t('tts.everySentence')], ['first-only', t('tts.firstOnly')],
      ] });
      ttsFields.maxTagsPerSentence = field(expressionBox, 'tts.tagCap', expression.maxTagsPerSentence, { type: 'number', min: 0, max: 2, step: 1 });
      ttsFields.earlyFirstSentence = checkbox(expressionBox, 'tts.earlyFirstSentence', expression.earlyFirstSentence);
      ttsFields.segmentPauseMs = field(expressionBox, 'tts.segmentPauseMs', expression.segmentPauseMs, { type: 'number', min: 0, max: 400, step: 1 });
      const catalogueBox = details(expressionBox, 'tts.emotionPresets');
      catalogueBox.append(el('p', t('tts.emotionPresetsHelp')));
      const mappingBox = details(expressionBox, 'tts.customEmotionMap');
      ttsFields.emotionTagMap = field(mappingBox, 'tts.emotionMap', JSON.stringify(expression.emotionTagMap, null, 2), { type: 'textarea', rows: 8, maxlength: 8192, spellcheck: 'false' });
      const selectors = new Map();
      const setTagOptions = (input, value) => {
        input.replaceChildren(el('option', t('tts.noTag'), { value: '' }));
        for (const group of FISH_EMOTION_GROUPS) {
          const options = el('optgroup', undefined, { label: t(group.labelKey) });
          for (const tag of group.tags) options.append(el('option', `${t(tag.labelKey)} ${tag.tag}`, { value: tag.tag }));
          input.append(options);
        }
        if (value && !FISH_EMOTION_TAGS.some(tag => tag.tag === value)) {
          input.append(el('option', t('tts.customTag', { tag: value }), { value }));
        }
        input.value = value;
      };
      const syncSelections = map => {
        for (const [emotion, inputs] of selectors) {
          const values = emotionMapSelections(map, emotion);
          inputs.forEach((input, index) => setTagOptions(input, values[index]));
        }
      };
      for (const emotion of Object.keys(defaults.expression.emotionTagMap)) {
        const row = el('fieldset', undefined, { class: 'settings-emotion-row', 'data-avatar-emotion': emotion });
        row.append(el('legend', t('tts.avatarEmotion', { emotion })));
        catalogueBox.append(row);
        const inputs = [field(row, 'tts.firstTag', '', { options: [] }), field(row, 'tts.secondTag', '', { options: [] })];
        selectors.set(emotion, inputs);
        inputs.forEach(input => input.addEventListener('change', () => {
          try {
            const map = JSON.parse(ttsFields.emotionTagMap.value);
            ttsFields.emotionTagMap.value = JSON.stringify(updateEmotionSelection(map, emotion, inputs[0].value, inputs[1].value), null, 2);
          } catch { fail({ code: 'INVALID_SETTINGS' }); }
        }));
      }
      syncSelections(expression.emotionTagMap);
      for (const event of ['input', 'change']) ttsFields.emotionTagMap.addEventListener(event, () => {
        try {
          const map = JSON.parse(ttsFields.emotionTagMap.value);
          if (!map || typeof map !== 'object' || Array.isArray(map)) return;
          syncSelections(map);
        } catch { /* Keep current selections until the JSON editor contains a valid map. */ }
      });
      expressionBox.append(el('p', t('tts.neutralExperimental')));
      ttsFields.mergeEnabled = checkbox(expressionBox, 'tts.mergeEnabled', merge.enabled);
      ttsFields.minChars = field(expressionBox, 'tts.minChars', merge.minChars, { type: 'number', min: 1, max: 1000, step: 1 });
      ttsFields.maxChars = field(expressionBox, 'tts.maxChars', merge.maxChars, { type: 'number', min: 1, max: 4000, step: 1 });
      const styleBox = details(form, 'tts.speechStyle');
      ttsFields.speechStyleEnabled = checkbox(styleBox, 'tts.speechStyleEnabled', params.speechStyle?.enabled ?? defaults.speechStyle.enabled);
      ttsFields.inlineEnabled = checkbox(styleBox, 'tts.inlineEnabled', inline.enabled);
      ttsFields.inlineAllowList = field(styleBox, 'tts.inlineAllowList', inline.allowList.join(', '), { maxlength: 2592 });
      ttsFields.inlineMaxPerSentence = field(styleBox, 'tts.inlineCap', inline.maxPerSentence, { type: 'number', min: 0, max: 2, step: 1 });
      ttsFields.debug = checkbox(styleBox, 'tts.debug', params.debug ?? defaults.debug);
      styleBox.append(el('p', t('tts.debugHelp')));
    }
    const advanced = details(form, 'slot.advanced');
    const timeouts = Object.fromEntries(['firstByteMs', 'idleMs', 'totalMs'].map((key, i) => [key,
      field(advanced, ['slot.firstByte', 'slot.idle', 'slot.total'][i], previous?.timeouts?.[key] ?? [20000, 20000, 60000][i], { type: 'number', min: 0, max: 300000 })]));
    const extras = field(advanced, 'slot.extras', JSON.stringify({ bodyExtras: params.bodyExtras || {}, omitParams: params.omitParams || [] }, null, 2), { type: 'textarea', rows: 5, spellcheck: 'false' });
    const extrasWarning = el('p', '', { 'aria-live': 'polite' }); advanced.append(extrasWarning);
    extras.addEventListener('input', () => {
      try { extrasWarning.textContent = parseAdvanced(extras.value).credentials ? t('warning.credentials') : ''; }
      catch { extrasWarning.textContent = t('error.invalid'); }
    });
    submit(form, async () => {
      const text = extras.value; extras.value = '';
      const slot = makeSlot({ profile: profile.value, model: model.value, temperature: temperature.value, maxTokens: maxTokens.value,
        advanced: text, ...Object.fromEntries(Object.entries(extra).map(([name, input]) => [name, input.value])),
        ...(name === 'tts' && { tts: Object.fromEntries(Object.entries(ttsFields).map(([key, input]) =>
          [key, input.type === 'checkbox' ? input.checked : input.value])) }),
        ...Object.fromEntries(Object.entries(timeouts).map(([name, input]) => [name, input.value])) }, previous || {});
      await change(async () => {
        await write('/slots/' + name, { slot });
        if (name === 'llm') for (const advancedName of ['planner', 'visionFilter']) {
          if (!effective.settings.slots[advancedName] && effective.sources['slots.' + advancedName] === 'default') {
            await write('/slots/' + advancedName, { slot: { followLlm: true } });
          }
        }
      });
    });
    button(t('action.unassign'), async () => { if (confirm(t('confirm.unassign'))) await change(() => write('/slots/' + name, { slot: null })); }, form);
    const timeout = field(form, 'slot.probeTimeout', 20000, { type: 'number', min: 1000, max: 60000 });
    const threshold = field(form, 'slot.threshold', 5000, { type: 'number', min: 100, max: 60000 });
    const result = el('div', '', { 'aria-live': 'polite', role: 'status' }); form.append(result);
    button(t('action.test'), async () => {
      busy = true;
      try {
        const phases = { connecting: 'test.connecting', first_byte: 'test.firstByte', done: 'test.done' };
        const response = await api.test({ slot: name, profile: profile.value, model: model.value, timeoutMs: Number(timeout.value) }, phase => { result.textContent = t(phases[phase]); });
        resultView(result, response, Number(threshold.value));
      } finally { busy = false; }
    }, form);
  }
  function statusView(parent) {
    parent.append(el('h2', t('tab.status')));
    parent.append(el('p', t('status.backend') + ': ' + status.backendName));
    parent.append(el('p', t('status.version') + ': ' + effective.version));
    for (const [name, value] of Object.entries(status.slots)) {
      const item = el('section', undefined, { class: 'settings-card' }); parent.append(item);
      item.append(el('h3', t(SLOT_LABELS[name])), el('p', t(value.available ? 'status.ready' : 'status.unavailable')));
      if (value.reason) item.append(el('p', t('status.reason', { reason: value.reason })));
    }
    let warning = false;
    for (const code of status.warningCodes || []) if (STATUS_WARNING_KEYS[code]) {
      parent.append(el('p', t(STATUS_WARNING_KEYS[code]))); warning = true;
    }
    if (status.backendName === 'plaintext-file') { parent.append(el('p', t('warning.plaintext'))); warning = true; }
    if (status.backendName === 'env') { parent.append(el('p', t('warning.windowsFirst'))); warning = true; }
    if (Object.values(status.slots).some(value => value.insecureTransport)) { parent.append(el('p', t('warning.http'))); warning = true; }
    if (!warning) parent.append(el('p', t('status.noWarnings')));
  }
  function privacy(parent) {
    parent.append(el('h2', t('tab.privacy')), el('p', t('privacy.intro')));
    for (const flow of privacyFlows(effective.settings)) {
      const item = el('section', undefined, { class: 'settings-card' }); parent.append(item);
      item.append(el('h3', t(flow.label)), el('p', flow.origin || t('slot.unassigned')), el('a', t('privacy.controls'), { href: '/' + flow.toggle }));
    }
    parent.append(el('h3', t('privacy.images')), el('p', t(effective.settings.images?.provider === 'cloud' ? 'images.privacyCloud' : 'privacy.local')));
  }
  function languages(parent) {
    const form = el('form'); parent.append(form);
    const input = field(form, 'language.choose', language, { options: [['id', t('language.id')], ['en', t('language.en')]] });
    submit(form, () => change(() => write('/ui', { ui: { language: input.value } })));
    return input;
  }
  function diagnostics(parent) {
    parent.append(el('h2', t('tab.diagnostics')), el('p', t('diagnostics.help')));
    const report = el('div', '', { 'aria-live': 'polite' });
    button(t('diagnostics.run'), async () => {
      busy = true;
      try {
        const data = await api.write('/diagnostics', {}, 'POST');
        report.replaceChildren(el('p', t('status.backend') + ': ' + data.backendName), el('p', t('status.version') + ': ' + data.version));
        report.append(el('h3', t('diagnostics.permissions')), el('p', t(data.permissionNote === 'WINDOWS_ACL_UNVERIFIED' ? 'diagnostics.acl' : 'diagnostics.owner')));
        if (data.writable) report.append(el('p', t('diagnostics.writable')));
        for (const [name, value] of Object.entries(data.locations)) report.append(el('p', name + ': ' + value));
        for (const [name, value] of Object.entries(data.locks)) report.append(el('p', name + ': ' + t('diagnostics.lock', { state: value.state })));
        report.append(el('p', t('diagnostics.backups', { count: data.corruptBackups })), el('p', t(data.selfTest.code === 'READ_ONLY' ? 'diagnostics.readOnly' : data.selfTest.ok ? 'test.success' : 'test.failure')));
        if (data.selfTest.code) report.append(el('code', data.selfTest.code));
      } finally { busy = false; }
    }, parent); parent.append(report);
  }
  function wizardView(parent) {
    const index = WIZARD_STEPS.indexOf(wizard.step);
    parent.append(el('h2', t('wizard.title')), el('p', t('wizard.step', { number: index + 1, total: WIZARD_STEPS.length })), el('h3', t(WIZARD_LABELS[index])));
    let languageChoice;
    if (wizard.step === 'language') languageChoice = languages(parent);
    else if (['llm', 'tts', 'stt', 'vision'].includes(wizard.step)) { providers(parent); slotEditor(parent, wizard.step); }
    else if (wizard.step === 'privacy') privacy(parent);
    else if (wizard.step === 'images') {
      imageController = mountImageSettings(parent, { document, api, t, fail, onVersion: version => { effective.version = version; } });
      parent.append(el('a', t('wizard.setupDocs'), { href: setupGuide, download: 'setup.md' }));
    } else parent.append(el('p', t('wizard.finished')));
    const nav = el('div', undefined, { class: 'settings-actions' }); parent.append(nav);
    if (index) button(t('action.back'), () => advance('back'), nav);
    if (wizard.step === 'finish') button(t('action.finish'), () => {
      wizard = moveWizard(wizard, 'finish'); saveWizard(storage, wizard); showWizard = false; render();
    }, nav);
    else {
      const next = button(t(['vision', 'images', 'tts', 'stt'].includes(wizard.step) && !effective.settings.slots[wizard.step]?.profile ? 'action.skip' : 'action.next'), async () => {
        if (languageChoice) await change(() => write('/ui', { ui: { language: languageChoice.value } }));
        advance('next');
      }, nav);
      if (wizard.step === 'llm' && !effective.settings.slots.llm?.profile) { next.disabled = true; parent.append(el('p', t('wizard.chatRequired'))); }
    }
  }
  function advance(action) { wizard = moveWizard(wizard, action); saveWizard(storage, wizard); render(); }
  function render() {
    imageController?.dispose(); imageController = undefined;
    document.documentElement.lang = language; document.title = t('app.title');
    root.replaceChildren(el('h1', t('app.title')), el('a', t('app.back'), { href: '/' }), toast);
    const controls = el('div', undefined, { class: 'settings-actions' }); root.append(controls);
    button(t('action.refresh'), async () => { await load(); render(); }, controls);
    button(t('wizard.restart'), () => { wizard = readWizard(null); showWizard = true; saveWizard(storage, wizard); render(); }, controls);
    const tabs = el('div', undefined, { role: 'tablist', 'aria-label': t('app.title'), class: 'settings-tabs' }); root.append(tabs);
    for (const [name, label] of Object.entries(TAB_LABELS)) {
      const item = button(t(label), () => { tab = name; showWizard = false; render(); document.getElementById('settings-content').focus(); }, tabs);
      item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(!showWizard && tab === name)); item.setAttribute('aria-controls', 'settings-content');
      item.addEventListener('keydown', event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const siblings = [...tabs.children]; const index = siblings.indexOf(item);
        siblings[event.key === 'Home' ? 0 : event.key === 'End' ? siblings.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + siblings.length) % siblings.length].focus();
      });
    }
    const content = el('section', undefined, { id: 'settings-content', role: 'tabpanel', tabindex: '-1' }); root.append(content);
    if (showWizard) wizardView(content);
    else if (tab === 'connections') {
      providers(content); content.append(el('h2', t('slot.title')));
      for (const name of ['llm', 'vision', 'stt', 'tts']) slotEditor(content, name);
      const advanced = details(content, 'slot.advanced'); for (const name of ['planner', 'visionFilter']) slotEditor(advanced, name);
    } else if (tab === 'images') imageController = mountImageSettings(content, { document, api, t, fail, onVersion: version => { effective.version = version; } });
    else if (tab === 'status') statusView(content);
    else if (tab === 'privacy') privacy(content);
    else if (tab === 'diagnostics') diagnostics(content);
    else languages(content);
  }
  try { await load(); showWizard = needsWizard(status, effective.settings) || !wizard.completed && wizard.step !== 'language'; render(); }
  catch (error) { root.replaceChildren(el('h1', t('app.title')), toast); fail(error); button(t('action.refresh'), () => window.location.reload(), root); }
}
