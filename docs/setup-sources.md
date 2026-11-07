# Pinned setup sources

Metadata checked on 2026-10-25. Only metadata, README/license text, checksums and HTTP HEAD
responses were fetched. No model, runtime or source-archive bodies were downloaded, and
no components were installed. Artifact SHA-256 and exact byte counts are in
`setup/manifest.json`; these are published fingerprints, not hashes computed locally.

## Models

| Component | Publisher and immutable revision | Published file |
| --- | --- | --- |
| Shared diffusion | [abenzerps/Qwen-Image-2.1-Uncensored-Quantized](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-Quantized/tree/7959e658915f52274897fb573ffeda49de8dc16b) at `7959e658915f52274897fb573ffeda49de8dc16b` | `qwen-image-2.1-UC-Q5_K_M.gguf` |
| Shared VAE | [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/0217efd1d9c9452e84f6448903d6e21bfa171ffd) at `0217efd1d9c9452e84f6448903d6e21bfa171ffd` | `vae/qwen_image_2.1_vae_bf16.safetensors` |
| sd.cpp encoder | [Qwen/Qwen3-VL-8B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/tree/f982a07559d4a2f6c8744d840bf6fccab30eea96) at `f982a07559d4a2f6c8744d840bf6fccab30eea96` | `Qwen3VL-8B-Instruct-Q4_K_M.gguf` |
| sd.cpp projector | Same Qwen GGUF repository and revision | `mmproj-Qwen3VL-8B-Instruct-F16.gguf` |
| ComfyUI encoder | Same Comfy-Org repository and revision as the VAE | `text_encoders/qwen3vl_8b_int8_convrot.safetensors` |

Hugging Face pinned model APIs (`/api/models/<repo>/revision/<commit>?blobs=true`) and
expanded trees publish LFS SHA-256 and byte counts. The diffusion fingerprint also matches
the publisher's [pinned SHA256SUMS](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-Quantized/blob/7959e658915f52274897fb573ffeda49de8dc16b/SHA256SUMS).
All destination filenames match the existing shared selfie config and ComfyUI workflow.

The original model is [Qwen/Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1/tree/d26bb61231c349cf6b7896fa83353113880e1ba3).
The UC publisher and Comfy-Org model cards declare `qwen-research`; their diffusion, VAE
and ComfyUI encoder entries inherit the original's
[Qwen Research License Agreement](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/d26bb61231c349cf6b7896fa83353113880e1ba3/LICENSE).
It permits non-commercial research/evaluation and requires a separate commercial license
for commercial use. No per-component exception was found in those model cards.

The official GGUF encoder/projector [model card](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/blob/f982a07559d4a2f6c8744d840bf6fccab30eea96/README.md)
declares Apache-2.0. The manifest links the full license in the pinned official
[Qwen3-VL source repository](https://github.com/QwenLM/Qwen3-VL/blob/96588727e44c78b25ba03ea03b8e12f7e64fd0da/LICENSE);
the model card is the model-specific license evidence.

## sd-cli and CUDA libraries

Both Windows x64 builds use the official immutable release
[`master-1010-bb6a0cc`](https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-1010-bb6a0cc),
source commit `bb6a0ccfa31ef24d776d951580a51599797d8cc0`. This is a pinned upstream build,
not a semantic stable release. The [release asset metadata](https://github.com/leejet/stable-diffusion.cpp/releases/expanded_assets/master-1010-bb6a0cc)
publishes SHA-256; HTTP HEAD verified each exact byte count.

The [pinned Qwen Image 2.1 guide](https://github.com/leejet/stable-diffusion.cpp/blob/bb6a0ccfa31ef24d776d951580a51599797d8cc0/docs/qwen_image_2.1.md)
supports the chosen diffusion, dedicated 2.1 VAE, Qwen3-VL GGUF encoder and mmproj.
The [pinned build workflow](https://github.com/leejet/stable-diffusion.cpp/blob/bb6a0ccfa31ef24d776d951580a51599797d8cc0/.github/workflows/build.yml)
uses CUDA Toolkit 12.8.1 for `cuda12` and packages matching cudart, cuBLAS and cuBLASLt
DLLs in `cudart-sd-bin-win-cu12-x64.zip`. Vulkan remains a separate destination.

sd-cli's upstream license is [MIT](https://github.com/leejet/stable-diffusion.cpp/blob/bb6a0ccfa31ef24d776d951580a51599797d8cc0/LICENSE).
CUDA libraries use the [NVIDIA Software License Agreement and CUDA Supplement](https://docs.nvidia.com/cuda/archive/12.8.1/eula/index.html).
Retain the licenses/notices bundled with runtime dependencies.

## ComfyUI and its GGUF node

Portable [ComfyUI v0.42.1](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.42.1),
commit `63be2f9b82ad0dac88a7ceaa28a9cf3154125a18`, publishes its NVIDIA portable archive
SHA-256 in [release asset metadata](https://github.com/Comfy-Org/ComfyUI/releases/expanded_assets/v0.42.1).
HTTP HEAD supplied its exact byte count. Its pinned packaging workflow provides
`python_embeded/python.exe` and `ComfyUI/main.py`; pinned code includes `TextEncodeQwenImage21`
and the Qwen3-VL 8B encoder. The source license is
[GNU GPL v3.0](https://github.com/Comfy-Org/ComfyUI/blob/63be2f9b82ad0dac88a7ceaa28a9cf3154125a18/LICENSE).

The [UC publisher's pinned instructions](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-Quantized/blob/7959e658915f52274897fb573ffeda49de8dc16b/README.md)
recommend the maintained `leejet/ComfyUI-GGUF` fork for native `qwen_image21` support.
The manifest pins [commit 373048b8403a7820620065210a691263d4da0a61](https://github.com/leejet/ComfyUI-GGUF/tree/373048b8403a7820620065210a691263d4da0a61).
Its loader accepts `qwen_image21`; its license is Apache-2.0.

The exact pinned ZIP was read in memory from both its GitHub archive URL and official
codeload redirect on 2026-11-08. Both yielded 38,557 bytes and SHA-256
`692c367072b6c1ec87ac9f3410c8e2563dfb8c0bb7f4abead09a8d6515c67169`.
This measures the distributed archive itself; it is not a Git commit/tree hash or an
uncompressed source size. Setup independently validates these bytes before extraction.

## Portable archive extractor

When system 7-Zip/bsdtar is absent, setup selects the official
[7-Zip 26.06 `7zr.exe` release asset](https://github.com/ip7z/7zip/releases/tag/26.06).
Upstream release metadata reports 600,064 bytes and SHA-256
`e80db2dad715a6c5adabe292d31ed54e11f4e9b99ca349827b50573b175891bc`.
It is installed only inside the application local runtime, after the displayed
[LGPL v2.1 or later license](https://github.com/ip7z/7zip/blob/26.06/DOC/License.txt)
is accepted. The binary is not committed, executed, or installed by tests.

Pinned source code does not pin transitive pip dependencies; no constraints file was
invented. Native generation, archive contents and end-to-end installs remain unverified.
