"""Download and pin official model files. Invoked only by explicit setup:memory."""
import argparse
import hashlib
import importlib.metadata
import json
import re
from pathlib import Path

MODEL_ID = "BAAI/bge-m3"
TOKENIZER_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json",
                   "special_tokens_map.json", "sentencepiece.bpe.model"]


def verify_source_file(filename, source):
    """Check existing/downloaded content against the official pinned blob hash."""
    sha256 = hashlib.sha256()
    size = filename.stat().st_size
    git_sha = hashlib.sha1(f"blob {size}\0".encode())
    with filename.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            sha256.update(block)
            git_sha.update(block)
    digest = sha256.hexdigest()
    source_hash = source.lfs.sha256 if source.lfs else source.blob_id
    if not source_hash or (digest if source.lfs else git_sha.hexdigest()) != source_hash:
        raise ValueError("Cached model failed official source checksum verification; no file was force-overwritten")
    return {"path": source.rfilename, "sizeBytes": size, "sha256": digest, "sourceHash": source_hash}


def weight_selection(names):
    """Prefer safetensors; permit official PyTorch weights with a modern safe loader."""
    for name in ("model.safetensors", "model.safetensors.index.json", "pytorch_model.bin", "pytorch_model.bin.index.json"):
        if name in names:
            return name
    raise ValueError("Official snapshot has no supported model weights")


def download(folder, revision=None):
    from huggingface_hub import HfApi, snapshot_download
    api = HfApi()
    info = api.model_info(MODEL_ID, revision=revision or "main", files_metadata=True)
    commit = info.sha
    if not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Official model has no immutable revision")
    info = api.model_info(MODEL_ID, revision=commit, files_metadata=True)
    sources = {item.rfilename: item for item in info.siblings}
    weight = weight_selection(sources)
    selected = [name for name in TOKENIZER_FILES if name in sources] + [weight]
    if weight.endswith(".index.json"):
        filename = Path(folder, weight)
        if filename.exists():
            verify_source_file(filename, sources[weight])
        snapshot_download(MODEL_ID, revision=commit, local_dir=folder, allow_patterns=[weight])
        verify_source_file(filename, sources[weight])
        if filename.stat().st_size > 1024 * 1024:
            raise ValueError("Model weight index is too large")
        index = json.loads(filename.read_text("utf-8"))
        mapping = index.get("weight_map")
        if not isinstance(mapping, dict) or not mapping:
            raise ValueError("Invalid model weight index")
        shards = sorted(set(mapping.values()))
        if len(shards) > 64 or any(not isinstance(name, str) or name not in sources or
                                  not re.fullmatch(r"(?:model|pytorch_model)-[0-9]+-of-[0-9]+\.(?:safetensors|bin)", name)
                                  for name in shards):
            raise ValueError("Invalid model weight shards")
        selected += shards
    for name in selected:
        filename = Path(folder, name)
        if filename.exists():
            verify_source_file(filename, sources[name])
    snapshot_download(MODEL_ID, revision=commit, local_dir=folder, allow_patterns=selected)
    files = []
    for name in selected:
        item = sources[name]
        filename = Path(folder, item.rfilename)
        files.append(verify_source_file(filename, item))
    required = {"config.json", "tokenizer.json", "tokenizer_config.json"}
    if not required.issubset({item["path"] for item in files}):
        raise ValueError("Official snapshot is missing required model assets")
    return {"modelRevision": commit, "files": files,
            "packages": {name: importlib.metadata.version(name) for name in ("torch", "transformers", "huggingface_hub")}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--revision")
    args = parser.parse_args()
    print(json.dumps(download(args.model_dir, args.revision), ensure_ascii=True))
