# Desktop selfie packaging

Development uses the root `selfie.config.json`. Installers contain a narrow local
output-directory snapshot written by the electron-builder `afterPack` hook in
`desktop-companion/scripts/packageSelfieConfig.js`.

Set the main-process `SELFIE_CONFIG_PATH` to an absolute backend configuration path
when an installed companion needs the external backend's current settings.

The snapshot contains only `outputDir`. Relative output paths retain the external
server root used during packaging; home-relative and default paths resolve for the
installed user when the desktop main process reads the configuration.

Validate the hook and path resolution with `npm test`. Build the frontend with
`npm run build`, then run `npm --prefix desktop-companion run dist` to produce the
Windows installer. Live installer validation remains unverified.
