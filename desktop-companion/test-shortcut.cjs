const { app, globalShortcut } = require('electron');
app.whenReady().then(() => {
  for (const c of ['Control+Alt+Shift+M', 'Control+Alt+Shift+F9', 'Control+Alt+Shift+F10']) {
    const ok = globalShortcut.register(c, () => console.log('FIRED', c));
    console.log('register', c, '=>', ok, '| isRegistered:', globalShortcut.isRegistered(c));
  }
  console.log('Tekan kombinasinya. Ctrl+C untuk berhenti.');
});
app.on('will-quit', () => globalShortcut.unregisterAll());
