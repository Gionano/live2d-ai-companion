"""Offline, loopback-only BGE-M3 embeddings for application memory.

Normal startup never downloads weights. setup/memoryCli.js installs and verifies
the model explicitly. PyTorch and Transformers are imported only by load_encoder,
so protocol and vector tests run with the Python standard library alone.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL_ID = "BAAI/bge-m3"
MODEL_TAG = "bge-m3-d768"
DIMENSIONS = 768
MAX_TEXTS = 8
MAX_TEXT_CHARS = 20000
MAX_BODY_BYTES = 1024 * 1024


def normalize_vectors(vectors, dimensions=DIMENSIONS):
    """L2 normalize, truncate, then L2 normalize; reject unusable vectors."""
    output = []
    for raw in vectors:
        values = [float(value) for value in raw]
        if len(values) < dimensions or any(not math.isfinite(value) for value in values):
            raise ValueError("Invalid vector")
        norm = math.sqrt(sum(value * value for value in values))
        if not math.isfinite(norm) or norm <= 0:
            raise ValueError("Invalid vector")
        cropped = [value / norm for value in values[:dimensions]]
        norm = math.sqrt(sum(value * value for value in cropped))
        if not math.isfinite(norm) or norm <= 0:
            raise ValueError("Invalid vector")
        output.append([value / norm for value in cropped])
    return output


class Encoder:
    def __init__(self, model_dir, device):
        import torch
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.device = device
        dtype = torch.float16 if device == "cuda" else torch.float32
        self.tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
        self.model = AutoModel.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False,
                                               torch_dtype=dtype, weights_only=True).to(device)
        self.model.eval()

    def encode(self, texts, task_type):
        # BGE-M3 uses the first-token (CLS) dense representation without prefixes.
        tokens = self.tokenizer(texts, padding=True, truncation=True, max_length=1024, return_tensors="pt")
        tokens = {key: value.to(self.device) for key, value in tokens.items()}
        with self.torch.inference_mode():
            values = self.model(**tokens).last_hidden_state[:, 0].float().cpu().tolist()
        return normalize_vectors(values)


def load_encoder(model_dir, requested="auto", factory=Encoder, cuda_available=None):
    """Choose CUDA/CPU and permit one CPU fallback after CUDA init failure."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    if cuda_available is None:
        import torch
        cuda_available = torch.cuda.is_available()
    selected = "cuda" if requested == "cuda" or requested == "auto" and cuda_available else "cpu"
    try:
        return factory(model_dir, selected)
    except Exception:
        if selected != "cuda":
            raise
        # Initialization can fail from driver/VRAM pressure; CPU keeps memory usable.
        import gc
        import sys
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None:
            torch.cuda.empty_cache()
        return factory(model_dir, "cpu")


class EncodingQueue:
    """One encoder owns the GPU. Queued query work precedes document batches."""
    def __init__(self, encoder):
        self.encoder = encoder
        self.items = queue.PriorityQueue(maxsize=64)
        self.sequence = 0
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.worker = threading.Thread(target=self._run, name="memory-embedding", daemon=True)
        self.worker.start()

    def encode(self, texts, task_type):
        item = {"texts": texts, "task_type": task_type, "done": threading.Event()}
        with self.lock:
            self.sequence += 1
            self.items.put_nowait((0 if task_type == "query" else 1, self.sequence, item))
        if not item["done"].wait(60):
            item["cancelled"] = True
            raise TimeoutError("Embedding queue timed out")
        if "error" in item:
            raise ValueError("Embedding failed")
        return item["result"]

    def _run(self):
        while not self.stopped.is_set():
            try:
                _, _, item = self.items.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                if not item.get("cancelled"):
                    item["result"] = self.encoder.encode(item["texts"], item["task_type"])
            except Exception:
                item["error"] = True
            finally:
                item["done"].set()
                self.items.task_done()

    def close(self):
        self.stopped.set()


def make_server(encoder, host="127.0.0.1", port=8011):
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Embedding service must bind to loopback")
    work = EncodingQueue(encoder)

    class Handler(BaseHTTPRequestHandler):
        server_version = "memory-embedding/1"

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *args):
            pass  # Never log text, URLs, or exception contents from embeddings.

        def allowed(self):
            authority = self.headers.get("Host", "").lower()
            actual_port = self.server.server_address[1]
            return not self.headers.get("Origin") and authority in (
                f"127.0.0.1:{actual_port}", f"localhost:{actual_port}", f"[::1]:{actual_port}")

        def reply(self, status, body):
            content = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, {"ok": False})
            if self.path != "/health":
                return self.reply(404, {"ok": False})
            self.reply(200, {"ok": True, "model": MODEL_ID, "tag": MODEL_TAG,
                             "dims": DIMENSIONS, "device": encoder.device,
                             "revision": getattr(encoder, "revision", None)})

        def do_POST(self):
            if not self.allowed():
                return self.reply(403, {"ok": False})
            if self.path != "/embed":
                return self.reply(404, {"ok": False})
            try:
                if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Encoding"):
                    raise ValueError()
                if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                    raise ValueError()
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > MAX_BODY_BYTES:
                    raise ValueError()
                body = json.loads(self.rfile.read(size).decode("utf-8"))
                if not isinstance(body, dict) or set(body) - {"texts", "task_type"}:
                    raise ValueError()
                texts = body.get("texts")
                task_type = body.get("task_type", "document")
                if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_TEXTS:
                    raise ValueError()
                if any(not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS for text in texts):
                    raise ValueError()
                if task_type not in ("query", "document"):
                    raise ValueError()
            except (ValueError, TypeError, UnicodeDecodeError):
                return self.reply(400, {"ok": False, "error": "Invalid embedding request"})
            try:
                values = work.encode(texts, task_type)
                if len(values) != len(texts):
                    raise ValueError()
                values = normalize_vectors(values)
                self.reply(200, {"model": MODEL_TAG, "dims": DIMENSIONS, "embeddings": values,
                                 "revision": getattr(encoder, "revision", None)})
            except (ValueError, TimeoutError, queue.Full):
                self.reply(503, {"ok": False, "error": "Embedding unavailable"})

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def server_close(self):
            work.close()
            super().server_close()

    if host == "::1":
        import socket
        Server.address_family = socket.AF_INET6
    return Server((host, port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--host", choices=("127.0.0.1", "localhost", "::1"), default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    if not Path(args.model_dir, "config.json").is_file() or not 1 <= args.port <= 65535:
        parser.error("Verified cached model and valid port are required; run setup:memory first")
    encoder = load_encoder(args.model_dir, args.device)
    encoder.revision = args.revision
    server = make_server(encoder, args.host, args.port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
