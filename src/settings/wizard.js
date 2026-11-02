export const WIZARD_STEPS = ['language', 'llm', 'tts', 'stt', 'vision', 'images', 'privacy', 'finish'];
export const WIZARD_LABELS = ['tab.language', 'slot.llm', 'slot.tts', 'slot.stt', 'slot.vision', 'wizard.images', 'tab.privacy', 'wizard.finish'];
export const WIZARD_STORAGE_KEY = 'amika.settings.wizard.v1';
export function readWizard(value) {
  try {
    const state = JSON.parse(value);
    return { step: WIZARD_STEPS.includes(state.step) ? state.step : 'language', completed: state.completed === true };
  } catch { return { step: 'language', completed: false }; }
}
export function needsWizard(status, settings) { return status?.firstRun === true || !settings?.slots?.llm?.profile; }
export function moveWizard(state, action) {
  const index = Math.max(0, WIZARD_STEPS.indexOf(state.step));
  if (action === 'finish') return { step: 'finish', completed: true };
  return { step: WIZARD_STEPS[Math.max(0, Math.min(WIZARD_STEPS.length - 1, index + (action === 'back' ? -1 : 1)))], completed: false };
}
export function saveWizard(storage, state) {
  try { storage.setItem(WIZARD_STORAGE_KEY, JSON.stringify({ step: state.step, completed: state.completed === true })); } catch { /* Private browsing may disable persistence. */ }
}
