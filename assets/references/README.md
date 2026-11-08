# Selfie reference images

`default.jpg` is the bundled character reference selected by `defaultReference` in
`selfie.config.json`. It is tracked in Git so fresh clones can generate selfies once
the image provider and models are ready.

The bundled image is a full-body capture of the current Witch (`魔女`) Live2D
model on a plain background, updated on 2026-11-08. The README header uses the
same model in the companion scene. This reference identifies the character;
generated PAP output still depends on the provider and workflow.

Add custom PNG/JPG/WebP references here, then set `defaultReference` in
`selfie.config.local.json` to the desired filename. Image filenames form the shared
whitelist used by the planner and providers. Custom references are ignored by Git;
only `default.jpg` and this README are tracked.
