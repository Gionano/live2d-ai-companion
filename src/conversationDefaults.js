// Legacy schema metadata distinguishes the old default from a custom delay.
export function migrateConversationDefaults(config) {
  const migrated = structuredClone(config);
  const delay = migrated?.conversation?.proactiveDelaySeconds;
  if (delay?.default === 60) {
    if (delay.value === 60) delay.value = 30;
    delay.default = 30;
  }
  return migrated;
}
