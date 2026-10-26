# Local setup

Use Node.js 18 or newer and the repository's existing npm dependencies. Engine code,
model weights, generated images, and private references stay outside Git. Setup commands
do not download, install, extract, or write files unless `--yes` is supplied. Tests use
loopback HTTP fixtures and temporary directories; they never install engine dependencies.

```text
amika-live2d-companion/
  setup/
    manifest.json                  # Committed public download metadata
    manifest.schema.json
  selfie.config.json               # Shared settings
  selfie.config.local.json         # Ignored machine overrides
  assets/references/
    default.jpg                   # Bundled character reference tracked in Git
                                  # Custom PNG/JPG/WebP references are ignored
  local/                          # Ignored; WAIFU_LOCAL_DIR can replace this root
    accepted-licenses.json
    installed.json                # Verified download provenance and active runtime variant
    .downloads/                   # Verified archive cache and resumable .part files
    models/
      diffusion_models/
      vae/
      text_encoders/
    runtime/
      sdcpp/
        cuda12/                   # CUDA binary and matching REQUIRED cudart libraries
        vulkan/                   # Vulkan binary; kept separate from CUDA files
      comfyui/
        python_embeded/            # Portable's embedded interpreter
        ComfyUI/
          main.py
          extra_model_paths.yaml
          custom_nodes/ComfyUI-GGUF/
    outputs/
    logs/
```

`server/selfie/localPaths.js` owns path resolution. `${LOCAL}` expands to
`WAIFU_LOCAL_DIR`, or `<repo>/local` when unset. A relative `WAIFU_LOCAL_DIR` resolves
from the repository root. Absolute config paths and `~/` paths work. Local ComfyUI takes
priority only when its embedded Python and `ComfyUI/main.py` exist. Local sd-cli takes
priority only when the selected binary successfully runs `--help`. An incomplete or broken
local runtime falls back to an explicitly configured legacy path, with a prominent warning
in provider status and doctor. With no legacy path, diagnostics name the missing file or
failed probe. Setup never starts an engine automatically.

`local/installed.json.activeVariants.sdcpp` selects `cuda12` or `vulkan`. A single variant
directory can be discovered without a marker; multiple variant directories need an explicit
selection. The earlier `local/runtime/sd-cli/` layout remains readable when the canonical
`local/runtime/sdcpp/` root is absent. An invalid canonical root requires the explicit
legacy config fallback; it does not silently switch to another local build.

## Prepare verified metadata

1. Review the committed `setup/manifest.json`, which setup commands read by default.
   Run `npm run setup:plan`. It prints components, destination paths, download byte counts,
   totals by engine and variant, licenses, detected GPU adapters, free disk space, missing
   required model roles, and every unresolved field. This is always a dry run.
2. For custom metadata or unresolved fields, copy the manifest to ignored
   `local/manifest.json` and pass `--manifest local/manifest.json` to each setup command.
   Use upstream metadata for the exact archive/model revision and independently verified
   SHA-256 and byte count. Keep machine-specific or private URLs in that local copy.
3. Define every engine entry and list each model in `components.models`. Each component
   needs `name`, `version` or full `commit`, `url`, `sha256`, `sizeBytes`, `licenseName`,
   `licenseUrl`, `kind`, `destination`, `required`, `engines`, `role`, and `when`.
   Destinations are relative to the
   local root. Models name their exact destination file; engine archives name their
   installation directory. Archives may have one enclosing release directory.
4. Run the plan again and read each linked license. Selected download metadata and manifest
   structure must validate before real setup. `required: false` marks an optional component for
   diagnostics; its setup group still includes it, so supply verified metadata and
   consent if running that group. Use existing installations below to avoid downloads.

The committed public manifest contains upstream pins, artifact URLs,
published SHA-256 and exact byte counts. See [Pinned sources](setup-sources.md) for evidence,
compatibility and license inheritance. Model filenames match the current shared config
and ComfyUI workflow. The sd-cli CUDA12 build uses matching CUDA 12.8.1 libraries.

The publisher-recommended `leejet/ComfyUI-GGUF` fork is pinned for `qwen_image21` support,
but its generated source ZIP has no published SHA-256 or byte count. Only that entry's
`sha256` and `sizeBytes` remain TODO/null. `setup:comfyui --yes` refuses until those are
measured from a verified local copy, including when `--skip-pip` is used. Engine-filtered
model/sd-cli metadata validates independently. Do not replace missing information with
guessed values. A normal application start never fetches missing files.

Diffusion, VAE and the ComfyUI encoder use the Qwen Research License Agreement, which
permits non-commercial research/evaluation and requires separate commercial permission.
The official Qwen3-VL GGUF encoder/projector pair declares Apache-2.0. Review the pinned
license links before accepting them; this metadata update has accepted no licenses.

## Schema version 2 and engine selection

`schemaVersion: 2` adds these typed fields to every model/runtime entry:

```json
{
  "engines": ["comfyui", "sdcpp"],
  "role": "diffusion",
  "when": { "gpuVendor": "any", "os": "win32" }
}
```

Engine values are `comfyui` and `sdcpp`. Roles are `diffusion`, `vae`, `text_encoder`,
`vision_projector`, `node`, `runtime`, and `runtime_library`. `when.gpuVendor` is `nvidia`
or `any`; `when.os` is `win32`. Setup filters by the selected engine, operating system,
GPU condition, and runtime variant. An explicit `--variant` overrides automatic GPU
selection while preserving the operating-system condition.

V1 manifests remain readable and emit a migration message. To migrate, set schema version
2, add engines/roles/conditions to each entry, and replace the v1 `components.sd-cli`
object with an array of CUDA12 and Vulkan entries. Give each runtime its own variant
destination and add `variant: "cuda12"` to the matching required `cudart` entry. Keep
existing verified pins, URLs, hashes, licenses, and sizes; do not infer them during migration.

The v2 model roles describe diffusion GGUF and VAE shared by both engines,
Q4 GGUF text encoder and mmproj vision projector for sd.cpp, and a safetensors text encoder
for ComfyUI. Both engines require diffusion, VAE and text encoder roles; a GGUF sd.cpp
text encoder also requires the vision projector. Plan names any absent required role.

`setup:models` defaults to both engines; `setup:sdcli` defaults to sd.cpp;
`setup:comfyui` defaults to ComfyUI. Each accepts `--engine comfyui` or `--engine sdcpp`:

```sh
npm run setup:models -- --engine sdcpp
npm run setup:models -- --engine comfyui
npm run setup:plan -- --engine sdcpp --variant vulkan
```

NVIDIA adapters select CUDA12 by default; other or unknown adapters select Vulkan. Unknown
detection produces a visible warning. Use `--variant cuda12` or `--variant vulkan` for an
explicit choice. CUDA12 includes its matching `cudart` as a required component. Vulkan does
not install CUDA runtime libraries. Different variants cannot share an installation
destination, even with `--force`; installations are checked against saved provenance to
prevent mixing files. Physical destinations are checked too: junctions or symlinks cannot
alias two variant directories. V1 compatibility cannot overwrite a recorded typed variant
with an untyped runtime. Shared models remain in `local/models`.

## Install selected groups

First inspect each command without flags:

```sh
npm run setup:models
npm run setup:sdcli
npm run setup:comfyui
```

After reviewing the plan, run the chosen group with explicit consent. Replace the quoted
license names with the exact verified `licenseName` values; repeat the flag for distinct
licenses:

```sh
npm run setup:models -- --engine sdcpp --yes --accept-license "MODEL LICENSE NAME"
npm run setup:sdcli -- --engine sdcpp --variant cuda12 --yes --accept-license "ENGINE LICENSE NAME" --accept-license "RUNTIME LICENSE NAME"
npm run setup:comfyui -- --manifest local/manifest.json --engine comfyui --yes --accept-license "COMFYUI LICENSE NAME" --accept-license "GGUF NODE LICENSE NAME"
```

Consent is recorded in `local/accepted-licenses.json` by license name and URL. An already
recorded matching license can be reused; `--yes` remains necessary on every real run.
Changing the license identity requires fresh acceptance. Downloads resume `.part` files
using HTTP Range, validate size and SHA-256, and publish only verified files. An HTTP
server that ignores Range restarts the partial download safely. A checksum failure leaves
the final destination unpublished.

Existing installed files are preserved. Use `--force` only when you intend to replace
colliding files, including an existing `extra_model_paths.yaml`. Archives extract into
staging and are checked for unsafe paths and links. Allow disk space for both downloads
and extracted files; the plan's byte count is the compressed download size, so actual
extraction may require more space.

Portable ComfyUI `.7z` extraction requires an already installed 7-Zip (`7z`/`7zz`) or
`bsdtar`. Setup detects it and gives a clear error when absent; it does not install the
extractor. After installing the pinned ComfyUI-GGUF archive, setup uses the portable's
embedded Python for `-s -m pip install -r requirements.txt`. This pip step may access
the network, and runs only after the same explicit setup and license gates. The full pip
command is logged. `--skip-pip` suppresses this step; doctor still checks the runtime and
records show that pip was skipped. An optional `components.constraints` entry can download
a verified constraints file (using the same metadata, `engines: ["comfyui"]`,
`role: "runtime_library"`, `kind: "constraints"`, and an exact file destination).
Setup passes that file to pip with `-c`. Without constraints, transitive Python dependencies
are governed by the pinned node's requirements file.

Successful installs record component versions/commits, source SHA-256, byte counts,
destinations, engines, roles and variants in `local/installed.json`, with size/SHA-256
fingerprints for each installed file. After pip, bundled files are fingerprinted again to
describe the final installed runtime. Doctor compares source metadata to the current
manifest, checks runtime file presence and sizes, and reports drift with repair commands.
`npm run doctor -- --verify-hashes` also checks runtime file fingerprints and hashes models
against the manifest; hashing large collections can take time. Constraints are always
hashed. Source hashes describe downloaded artifacts; pip package versions and files added
by transitive dependencies are not individually pinned. Skipping pip is recorded and
reported by doctor.

Illustrative command to fingerprint an existing local download without accessing the network:

```sh
npm run setup:hash -- "X:/path/to/downloads/model.gguf"
```

This prints its byte count, SHA-256 and a manifest snippet containing the measured fields.
Fill the remaining metadata from verified upstream sources. The command writes no files.

Setup reads the installed `ComfyUI/extra_model_paths.yaml.example` and writes model keys
from that example with `base_path` pointing at `local/models`. It refuses to guess keys
when the example is missing or unusable. Keep your model destinations consistent with
those installed keys and your workflow loader filenames.

## Reuse an existing installation or model collection

No copying is required. Put absolute engine and model paths in
`selfie.config.local.json`, while leaving the corresponding local runtime directory absent:

```json
{
  "comfyuiManaged": {
    "installDir": "X:/path/to/ComfyUI",
    "pythonPath": "X:/path/to/ComfyUI/.venv/Scripts/python.exe",
    "mainScript": "X:/path/to/ComfyUI/main.py",
    "args": []
  },
  "sdcpp": {
    "binaryPath": "X:/path/to/sd-cli/sd-cli.exe",
    "diffusionModel": "X:/path/to/models/example.gguf",
    "vae": "X:/path/to/models/example-vae.safetensors",
    "llm": "X:/path/to/models/example-encoder.gguf",
    "llmVision": null
  }
}
```

These are illustrative paths, not downloadable model metadata. Choose the actual models
required by your workflow. For ComfyUI, add your existing model roots to its
`extra_model_paths.yaml`, using key names from that installation's example. You may also
place directory junctions/symlinks under `local/models` pointing at existing collections.
Provider reads support such collections; setup refuses writes through links escaping
the local root. Keep custom references alongside the bundled `assets/references/default.jpg`,
where additional files are ignored by Git, or override
`referenceDir` with an absolute path. ComfyUI uploads the selected reference; sd.cpp reads
the same whitelisted file directly.

## Machine settings and precedence

Config values merge in this order, with later values taking priority:

1. Backend defaults.
2. `selfie.config.json`.
3. Sibling `selfie.config.local.json`.
4. Explicit CLI/in-memory overrides.

Nested objects merge recursively; arrays, scalar values, and `null` replace earlier
values. Path expansion follows the merge, then valid local runtimes take priority over
legacy engine paths. Relative model paths normally resolve under `local/models/<kind>`.
An explicitly configured `userDataDir` retains the legacy `userData/models/sdcpp` base.
Use `${LOCAL}/models/...` for unambiguous shared config values. The backend watches both
config files; changing output or quota-store paths still requires a restart.

Illustrative placeholder for a different disk in PowerShell:

```powershell
$env:WAIFU_LOCAL_DIR = 'X:/path/to/local'
npm run setup:plan
npm run doctor
```

## Verify offline

`npm run doctor` does not use the network or install anything. It reports manifest
problems, required/optional component files, model sizes, detected GPU vendor/variant,
installed-record drift, sd-cli help/devices, a bounded ComfyUI interpreter/script help
check, invalid-local fallback warnings, duplicate model names and sizes across local and
legacy roots, free disk, physical RAM, and commit headroom when available. Each problem
includes its fix command. The external ComfyUI URL is inspected as configuration only;
live HTTP readiness remains the provider's responsibility. After a local-runtime fallback,
the GGUF node check uses the selected ComfyUI installation. Doctor does not start a server
or generate an image.

```sh
npm test
npm run build
npm run setup:plan
npm run doctor
```

Engine/GPU generation needs your verified installation; the default character reference
is included in Git. Custom references must be supplied separately.
Run `npm run selfie:test -- --provider=auto --preset=cepat` only when you want a real image.

## Privacy checks

Run `npm run check:privacy` before staging. The same guard runs in `npm test`.
It scans tracked and untracked non-ignored text, including UTF-16 text, case-insensitively.
Failures report filenames and pattern counts only. The current OS username, hostname
and private profile/project folder names are read at runtime. Windows absolute paths,
user-profile segments, email addresses and credential-like literals fail the check.
Only neutral documentation prefixes are allowed; test paths must be built at runtime.
Setup tests check the committed download manifest offline and use synthetic metadata for
installation tests. They do not read real machine configuration or download upstream artifacts.
