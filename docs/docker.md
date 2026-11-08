# Docker

Use Docker Desktop with Linux containers and Docker Compose v2. The image runs
Node.js 22, the built companion, the built Vision Monitor, their Node backends,
and an nginx proxy. Python 3.11 is included for optional memory setup; model
weights and embedding packages are installed only by an explicit setup command.

## Start and configure

Copy `.env.example` to `.env` if it does not exist. Fill in backend credentials
as needed; build context excludes `.env`, private overrides, runtime data,
personal reference images, and local engine/model weights. The tracked Witch
`assets/references/default.jpg` is included as the bundled PAP reference.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 app
```

Open the [companion](http://localhost:5173),
[Settings](http://localhost:5173/#settings), and
[Vision Monitor](http://localhost:5174). Closing the last monitor dashboard
stops continuous capture; the bridge alone does not enable it. Browser camera,
microphone and screen-sharing permissions remain necessary. Electron stays on
the Windows host; its development frontend can use `http://localhost:5173`.

The companion backend stays on container loopback port 8787, the monitor bridge
on 3001, and BGE on 8011. Only ports 5173 and 5174 are published, both on host
`127.0.0.1`. The proxy preserves the actual Host and Origin, removes supplied
forwarding chains, and forwards to loopback. Settings keep their same-origin
and token checks. **Keep the localhost port bindings:** this setup trusts the
local publication and is not a LAN or public deployment recipe. Use Docker
Engine 28 or newer for localhost publication isolation on bridged networks.

This replaces the old source-mounted Vite container. Use `npm run dev:all`
for hot reload on the host. Image rebuilds use `npm ci` and production bundles;
host `node_modules` cannot overwrite Linux dependencies. Health checks probe
both pages and both backend APIs. A service exit stops its sibling processes;
Compose restarts the container after an unexpected exit.

Public chat, voice, STT, vision and planner slots start unassigned. Configure
them in Settings; environment keys alone do not select a model. Surface,
reflection and memory writing follow Chat by default. The Groq router needs
`GROQ_API_KEY`; unavailable routing falls back to local rules.

Linux containers default to **environment-only credentials**. Windows DPAPI
credentials cannot be copied into Linux. To save keys through the GUI, explicitly
set `WAIFU_ALLOW_PLAINTEXT_SECRETS=1` in `.env` and recreate the container:

```sh
docker compose up -d --force-recreate
```

This opts into plaintext keys in the private `app-local` volume. Settings display
the storage warning. Configuration exports still omit credentials and memories.
See [provider settings](settings-gui.md) for endpoint/key mappings.

## Persistent storage

| Compose volume | Container path | Contents |
| --- | --- | --- |
| `app-data` | `/app/data` | Dialogue evidence, memory jobs/vectors, PAP limits and duration history |
| `app-local` | `/app/local` | Settings, optional stored keys, BGE runtime/weights, PAP outputs, selected-model record |
| `app-config` | `/app/config` | Animation tuning and shared character/PAP configuration |
| `app-models` | `/app/public/models` | Live2D assets and models uploaded through the companion |
| `app-references` | `/app/assets/references` | Bundled Witch reference and personal references added explicitly |

New config/model/reference volumes are seeded from the image. The proxy serves Live2D files
directly from the model volume, so uploads work without rebuilding the frontend.
Rebuilds preserve existing volumes: new shared config/model files do not replace
their saved copies automatically. Back up the volumes and manually merge those
updates when upgrading. Stop the app before backing up memory or runtime files.

`docker compose stop` and `docker compose down` retain these volumes.
`docker compose down --volumes` **deletes them**, including memories, keys, models
and generated images. Windows host `local/` and `data/` are separate; they are
neither imported nor modified. Live2D assets present in the build context enter
the image; retain their licenses and avoid publishing images containing private
or non-redistributable models.

## Optional BGE memory search

Keyword memory works without BGE. For CPU embeddings, stop the app, plan and
install inside a one-off Linux container sharing its volumes, then restart:

```sh
docker compose stop app
docker compose run --rm --no-deps app npm run memory:plan -- --device=cpu
docker compose run --rm --no-deps app npm run setup:memory -- --device=cpu --accept-license=bge-m3 --accept-license=pytorch --accept-license=transformers --accept-license=huggingface-hub
docker compose run --rm --no-deps app npm run memory:doctor -- --verify-hashes
docker compose up -d
```

The plan checks available space in Docker's storage, requiring about 6 GiB for
a fresh CPU installation. Weights are about 2.3 GB, plus dependencies and temporary
downloads. In **Memori**, choose **CPU** or **Otomatis**, wait for readiness, and
use **Bangun ulang indeks**. Normal restarts use verified cached files and never
download weights. Do not mount the Windows BGE virtual environment into Linux;
install a separate Linux runtime. See [memory](memory.md) for evidence, deletion,
retrieval deadlines and recovery behavior.

GPU acceleration additionally requires an NVIDIA-compatible Docker runtime
(on Windows, Docker Desktop WSL2 GPU support and a compatible driver). Create an
ignored `docker-compose.override.yml` locally:

```yaml
services:
  app:
    gpus: all
```

Repeat the setup commands with `--device=cuda` in the plan and install commands.
A fresh CUDA setup reserves about 12 GiB of disk. Select **CUDA** or **Otomatis**
in **Memori**. CPU fallback can occur after CUDA initialization failure. GPU
timings and VRAM depend on the host and need a native check; the default Compose
file makes no GPU allocation.

## PAP and host services

Cloudflare PAP needs no local image engine. Configure **Foto / PAP** and supply
its account/token through Settings or `.env` as described in the
[PAP guide](selfie.md). Fresh reference volumes already contain the bundled
Witch image. To replace it with a personal reference after startup:

```sh
docker compose cp /path/to/reference.jpg app:/app/assets/references/default.jpg
```

For ComfyUI running on the host, use `http://host.docker.internal:8188` in
**Foto / PAP**. The host service must listen on an interface reachable from
Docker, with host firewall rules permitting that connection. Container
`127.0.0.1` refers to the container itself. Windows managed ComfyUI and sd.cpp
installations are not portable into this Linux image; use external ComfyUI or
Cloudflare here, or run the companion on Windows for managed image engines.

## Manual checks

After building, verify the container reports healthy, Settings loads and saves,
chat/audio work with configured providers, and opening/closing Vision Monitor
starts/stops capture. Upload/switch a Live2D model and confirm its files load.
Restart/recreate the container and confirm model selection, settings and
completed memory evidence persist. Check that cross-origin Settings mutations
remain forbidden and localhost bindings remain in place.

For optional BGE, verify health/device in **Memori**, rebuild the index, then
test recall and deletion. Build and API health do not validate real AI providers,
browser permissions, GPU performance, or native Electron capture.
