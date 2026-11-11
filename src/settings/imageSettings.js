import { node } from './dom.js';
import { validateBaseUrl, withSecret } from './viewModel.js';

export const CLOUD_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';
export const IMAGE_PROVIDER_LABELS = {
  comfyui: 'images.comfyui', 'comfyui-managed': 'images.managed', sdcpp: 'images.sdcpp', cloud: 'images.cloud',
};
const JOB_LABELS = {
  queued: 'images.queued', running: 'images.running', completed: 'images.completed', failed: 'images.failed',
  cancelled: 'images.cancelled', cancelling: 'images.cancelling', interrupted: 'images.interrupted',
};
const PHASE_LABELS = {
  queued: 'images.queued', preparing: 'images.preparing', downloading: 'images.downloading', download: 'images.downloading',
  verifying: 'images.verifying', verify: 'images.verifying', extracting: 'images.extracting', extract: 'images.extracting',
  dependencies: 'images.dependencies', installing: 'images.dependencies', checking: 'images.verifying',
  completed: 'images.completed', cancelled: 'images.cancelled', failed: 'images.failed', interrupted: 'images.interrupted',
};
const ACTIVE_STATES = new Set(['queued', 'running', 'cancelling']);

export function imageSettingsInput(value) {
  if (!Object.hasOwn(IMAGE_PROVIDER_LABELS, value.provider)
    || !['cepat', 'kualitas', 'hemat'].includes(value.preset)
    || !['auto', 'cuda12', 'vulkan'].includes(value.variant)) {
    throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
  }
  const comfyuiUrl = String(value.comfyuiUrl || '').trim();
  if (comfyuiUrl) validateBaseUrl(comfyuiUrl);
  if (value.provider === 'comfyui' && !comfyuiUrl) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
  const accountId = String(value.cloud?.accountId || '').trim();
  const validAccount = /^[a-fA-F0-9]{32}$/.test(accountId);
  if (value.provider === 'cloud' && !validAccount) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
  return { provider: value.provider, preset: value.preset, ...(comfyuiUrl && { comfyuiUrl }), variant: value.variant,
    ...(value.provider === 'cloud' || validAccount ? { cloud: { accountId, model: CLOUD_IMAGE_MODEL } } : {}) };
}

export function imageBytes(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

// This controller owns its polling lifetime and never keeps a token in draft state.
export function mountImageSettings(parent, { document, api, t, onVersion = () => {}, fail = () => {},
  onDirtyChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const el = (tag, text, attributes) => node(document, tag, text, attributes);
  let disposed = false;
  let busy = false;
  let snapshot;
  let draft;
  let plan;
  let job;
  let timer;
  let fieldId = 0;
  let statusNode;
  let progressNode;
  let testNode;
  let keyInput;
  let fields = [];
  let savedDraft;
  let dirty = false;
  let cancelChanges;
  const box = el('section', undefined, { class: 'settings-image-section', 'data-pap-settings': '' }); parent.append(box);
  box.append(el('p', t('app.loading')));
  const formatBytes = value => imageBytes(value) ?? t('images.unknownSize');
  const active = () => ACTIVE_STATES.has(job?.state);
  const isDirty = () => Boolean(draft && JSON.stringify(draft) !== JSON.stringify(savedDraft) || keyInput?.value);
  const updateDirty = () => {
    const next = isDirty();
    if (cancelChanges) cancelChanges.disabled = !next;
    if (next !== dirty) { dirty = next; onDirtyChange(next); }
  };
  const draftFromSnapshot = () => {
    const images = snapshot?.images || {};
    return { provider: images.provider || snapshot?.provider || 'auto', preset: images.preset || 'cepat',
      comfyuiUrl: images.comfyuiUrl || 'http://127.0.0.1:8188', variant: images.variant || 'auto',
      cloud: { accountId: images.cloud?.accountId || '', model: CLOUD_IMAGE_MODEL } };
  };
  function discardChanges() {
    if (disposed || busy || !snapshot) return;
    if (keyInput) keyInput.value = '';
    draft = draftFromSnapshot(); savedDraft = structuredClone(draft); plan = undefined;
    render(); updateDirty();
  }
  const action = async operation => {
    if (busy || disposed) return;
    busy = true; box.setAttribute('aria-busy', 'true');
    const disabled = fields.map(input => [input, input.disabled]);
    for (const [input] of disabled) input.disabled = true;
    try { await operation(); } catch (error) { if (!disposed) fail(error); }
    finally {
      for (const [input, previous] of disabled) input.disabled = previous;
      busy = false; box.removeAttribute('aria-busy'); if (!disposed) updateDirty();
    }
  };
  const button = (target, label, operation) => {
    const item = el('button', t(label), { type: 'button' }); target.append(item);
    item.addEventListener('click', () => action(operation)); return item;
  };
  const field = (target, labelKey, value, { type = 'text', options, ...attributes } = {}) => {
    const label = el('label', t(labelKey), { class: 'settings-field' });
    const input = el(options ? 'select' : 'input', undefined, { id: 'settings-image-' + ++fieldId, ...attributes });
    label.setAttribute('for', input.id);
    if (options) for (const [name, labelText] of options) input.append(el('option', labelText, { value: name }));
    else input.type = type;
    if (type === 'password') for (const event of ['input', 'change']) input.addEventListener(event, updateDirty);
    fields.push(input);
    input.value = value ?? ''; label.append(input); target.append(label); return input;
  };
  const externalLink = (target, label, href) => {
    try {
      if (new URL(href).protocol !== 'https:') return;
      target.append(el('a', label, { href, target: '_blank', rel: 'noopener noreferrer' }));
    } catch { /* Invalid upstream license links are not navigable. */ }
  };
  function updateStatus() {
    if (disposed || !statusNode) return;
    statusNode.replaceChildren(el('p', t(snapshot?.pending ? 'images.pending' : snapshot?.ready ? 'status.ready' : 'status.unavailable')));
    const current = snapshot?.readiness?.active || snapshot?.provider;
    if (current) statusNode.append(el('p', t('images.active', { provider: IMAGE_PROVIDER_LABELS[current] ? t(IMAGE_PROVIDER_LABELS[current]) : current })));
    const reasons = snapshot?.readiness?.reasons || {};
    const reason = reasons[draft?.provider];
    if (reason) statusNode.append(el('p', String(reason)));
    if (!progressNode) return;
    progressNode.replaceChildren();
    if (!job) return;
    progressNode.append(el('h3', t('images.installation')), el('p', t(JOB_LABELS[job.state] || 'images.preparing')));
    if (job.phase && active()) progressNode.append(el('p', t(PHASE_LABELS[job.phase] || 'images.preparing')));
    if (job.component || job.componentId) progressNode.append(el('p', String(job.component || job.componentId)));
    if (Number.isFinite(job.downloadedBytes)) {
      progressNode.append(el('p', `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`));
      if (job.totalBytes > 0) progressNode.append(el('progress', undefined, { value: Math.min(job.totalBytes, job.downloadedBytes), max: job.totalBytes, 'aria-label': t('images.downloading') }));
    }
    if (job.error) progressNode.append(el('p', String(job.error.message || job.error.code || job.error)));
    if (active()) button(progressNode, 'images.cancel', async () => {
      job = await api.write('/images/install/' + job.id + '/cancel', {}, 'POST'); updateStatus(); schedule();
    });
    if (job.state === 'interrupted') progressNode.append(el('p', t('images.retryHelp')));
  }
  async function readSnapshot() {
    const value = await api.get('/images');
    if (disposed) return;
    snapshot = value; job = value.installation || job;
    if (Number.isSafeInteger(value.version)) onVersion(value.version);
  }
  function schedule() {
    if (timer) clearTimer(timer);
    timer = undefined;
    if (disposed || !active() && !snapshot?.pending) return;
    timer = setTimer(async () => {
      timer = undefined;
      if (disposed) return;
      if (document.visibilityState !== 'hidden' && !busy) {
        try {
          const wasActive = active();
          if (job?.id && wasActive) job = await api.get('/images/install/' + job.id);
          if (!disposed && (snapshot?.pending || wasActive && !active())) await readSnapshot();
          updateStatus();
        } catch (error) { if (!disposed) fail(error); }
      }
      schedule();
    }, 1000);
  }
  function renderPlan(target) {
    if (!plan) return;
    const review = el('section', undefined, { class: 'settings-image-plan' }); target.append(review);
    review.append(el('h3', t('images.review')), el('p', t('images.downloadSize', { size: formatBytes(plan.downloadBytes) })),
      el('p', t('images.diskSize', { size: formatBytes(plan.requiredDiskBytes) })));
    if (Number.isFinite(plan.freeBytes)) review.append(el('p', t('images.freeDisk', { size: formatBytes(plan.freeBytes) })));
    const table = el('table'); const head = el('tr');
    for (const key of ['images.component', 'images.size', 'images.componentStatus']) head.append(el('th', t(key), { scope: 'col' }));
    table.append(head);
    for (const component of plan.components || []) {
      const row = el('tr'); row.append(el('td', component.name), el('td', formatBytes(component.sizeBytes)),
        el('td', t(component.installed || component.status === 'installed' ? 'images.reused' : component.status === 'blocked' ? 'images.blocked' : 'images.missing'))); table.append(row);
    }
    review.append(table);
    for (const blocker of plan.blockers || []) review.append(el('p', t('images.blocker', { reason: String(blocker.message || blocker.code || blocker) })));
    const consent = new Set(); const checkboxes = [];
    if (plan.licenses?.length) review.append(el('h3', t('images.licenses')));
    for (const license of plan.licenses || []) {
      const line = el('div'); review.append(line);
      externalLink(line, license.name, license.url);
      const checkbox = field(line, 'images.acceptLicense', '', { type: 'checkbox' });
      checkbox.checked = license.accepted === true;
      if (checkbox.checked) consent.add(license.key);
      checkboxes.push(checkbox);
      checkbox.addEventListener('change', () => { if (checkbox.checked) consent.add(license.key); else consent.delete(license.key); updateDownload(); });
    }
    const download = button(review, 'images.download', async () => {
      if ((plan.blockers || []).length || !checkboxes.every(input => input.checked) || active()) return;
      job = await api.write('/images/install', { planId: plan.planId, acceptedLicenses: [...consent] }, 'POST');
      plan = undefined; render(); schedule();
    });
    const updateDownload = () => { download.disabled = (plan.blockers || []).length > 0 || !checkboxes.every(input => input.checked) || active(); };
    updateDownload();
  }
  function render() {
    if (disposed) return;
    if (keyInput) keyInput.value = '';
    keyInput = undefined;
    fields = [];
    box.replaceChildren(el('h2', t('tab.images')), el('p', t('images.intro')));
    statusNode = el('div', undefined, { role: 'status', 'aria-live': 'polite' }); box.append(statusNode);
    const form = el('form', undefined, { autocomplete: 'off', class: 'settings-card', 'data-image-config': '' }); box.append(form);
    const provider = field(form, 'images.provider', draft.provider, { options: [
      ...(draft.provider === 'auto' ? [['auto', t('images.legacyAuto')]] : []),
      ...Object.entries(IMAGE_PROVIDER_LABELS).map(([name, label]) => [name, t(label)]),
    ] });
    if (draft.provider === 'auto') {
      provider.children[0].disabled = true; form.append(el('p', t('images.legacyHelp')));
    }
    provider.addEventListener('change', () => { draft.provider = provider.value; plan = undefined; render(); updateDirty(); });
    const preset = field(form, 'images.preset', draft.preset, { options: [['cepat', t('images.fast')], ['kualitas', t('images.quality')], ['hemat', t('images.economy')]] });
    preset.disabled = draft.provider === 'cloud';
    for (const event of ['input', 'change']) preset.addEventListener(event, () => { draft.preset = preset.value; updateDirty(); });
    if (draft.provider === 'comfyui') {
      const url = field(form, 'images.url', draft.comfyuiUrl, { required: '', maxlength: 2048 });
      for (const event of ['input', 'change']) url.addEventListener(event, () => { draft.comfyuiUrl = url.value; updateDirty(); });
      form.append(el('p', t('images.externalHelp')));
    } else if (draft.provider === 'comfyui-managed') form.append(el('p', t('images.managedHelp')));
    else if (draft.provider === 'sdcpp') {
      const variant = field(form, 'images.variant', draft.variant, { options: [['auto', t('images.detect')], ['cuda12', 'CUDA12'], ['vulkan', 'Vulkan']] });
      variant.addEventListener('change', () => { draft.variant = variant.value; plan = undefined; render(); updateDirty(); });
      form.append(el('p', t('images.sdcppHelp')));
    } else if (draft.provider === 'cloud') {
      const account = field(form, 'images.accountId', draft.cloud.accountId, { required: '', maxlength: 32, pattern: '[a-fA-F0-9]{32}', autocomplete: 'off', spellcheck: 'false' });
      for (const event of ['input', 'change']) account.addEventListener(event, () => { draft.cloud.accountId = account.value; updateDirty(); });
      keyInput = field(form, 'images.token', '', { type: 'password', maxlength: 8192, autocomplete: 'off', spellcheck: 'false' });
      form.append(el('p', t(snapshot.hasKey ? 'images.tokenPresent' : 'images.tokenAbsent')), el('p', t('images.cloudHelp')),
        el('p', t('images.cloudFixed')), el('p', t('images.cloudUpload')));
      externalLink(form, t('images.pricing'), 'https://developers.cloudflare.com/workers-ai/platform/pricing/');
      if (snapshot.hasKey) button(form, 'images.deleteToken', async () => {
        await api.write('/images/secret', { version: snapshot.version }, 'DELETE'); await readSnapshot(); render(); updateDirty();
      });
    }
    const save = el('button', t('images.save'), { type: 'submit' }); form.append(save); save.disabled = draft.provider === 'auto';
    cancelChanges = el('button', t('action.cancelChanges'), { type: 'button' }); form.append(cancelChanges);
    cancelChanges.addEventListener('click', discardChanges);
    cancelChanges.disabled = !isDirty();
    form.addEventListener('submit', event => {
      event.preventDefault();
      action(() => withSecret(keyInput || { value: '' }, async key => {
        const images = imageSettingsInput(draft);
        const result = await api.write('/images', { version: snapshot.version, images });
        snapshot.version = result.version;
        if (key && images.provider === 'cloud') await api.write('/images/secret', { version: result.version, key }, 'PUT');
        await readSnapshot();
        if (disposed) return;
        draft = draftFromSnapshot(); savedDraft = structuredClone(draft);
        render(); updateDirty(); schedule();
      }));
    });
    testNode = el('div', undefined, { role: 'status', 'aria-live': 'polite' }); box.append(testNode);
    button(box, 'images.test', async () => {
      testNode.textContent = t('images.checking');
      const result = await api.write('/images/test', {}, 'POST');
      await readSnapshot(); updateStatus();
      testNode.replaceChildren(el('p', t(result.ready ? 'status.ready' : 'status.unavailable')),
        el('p', result.message || result.code || ''), el('p', t('images.notGenerated')));
    });
    if (['comfyui-managed', 'sdcpp'].includes(draft.provider)) {
      box.append(el('p', t('images.setupHelp')));
      const preview = button(box, 'images.preview', async () => {
        const selection = { provider: draft.provider,
          ...(draft.provider === 'sdcpp' && draft.variant !== 'auto' && { variant: draft.variant }) };
        plan = await api.write('/images/install/plan', selection, 'POST'); render();
      }); preview.disabled = active();
      renderPlan(box);
    }
    progressNode = el('div', undefined, { role: 'status', 'aria-live': 'polite' }); box.append(progressNode);
    updateStatus();
  }
  const ready = (async () => {
    try {
      await readSnapshot();
      if (disposed) return;
      draft = draftFromSnapshot(); savedDraft = structuredClone(draft);
      render(); schedule();
    } catch (error) { if (!disposed) { box.replaceChildren(el('p', t('status.unavailable'))); fail(error); } }
  })();
  return { ready, isDirty, discardChanges, get savedProvider() { return snapshot?.images?.provider || snapshot?.provider; }, dispose() {
    disposed = true; if (timer) clearTimer(timer); if (keyInput) keyInput.value = '';
  } };
}
