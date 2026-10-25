export function installSelfieFeatureControl({ socket, manager, send }) {
  if (typeof socket.selfieEnabled !== 'boolean') socket.selfieEnabled = true;
  const featureEvent = () => ({
    type: 'selfie_feature',
    enabled: socket.selfieEnabled,
    status: manager.getProviderStatus?.() || {
      active: null,
      reasons: { comfyui: 'Not checked.', sdcpp: 'Not checked.' },
    },
  });
  send(featureEvent());

  return (message) => {
    if (!message || message.type !== 'selfie_feature' || typeof message.enabled !== 'boolean') return false;
    socket.selfieEnabled = message.enabled;
    send(featureEvent());
    if (message.enabled) manager.sendSnapshot(send);
    return true;
  };
}

export function disabledSelfieResult(socket) {
  return socket.selfieEnabled === false ? {
    ok: false,
    reason: 'FEATURE_DISABLED',
    text: 'Fitur pap sedang dimatikan di tray, sayang.',
    emotion: 'netral',
  } : null;
}
