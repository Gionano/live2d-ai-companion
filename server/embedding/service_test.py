"""Standard-library regressions; no model, GPU, package install or provider API."""
import hashlib
import http.client
import importlib.util
import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    output = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(output)
    return output


service = module("memory_service", "service.py")
installer = module("memory_install", "install_model.py")


class FakeEncoder:
    device = "cpu"
    revision = "a" * 40

    def __init__(self):
        self.calls = []

    def encode(self, texts, task_type):
        self.calls.append((texts, task_type))
        return [[1.0] + [0.0] * 767 for _ in texts]


class VectorTests(unittest.TestCase):
    def test_truncation_renormalizes(self):
        vector = [1.0] + [0.0] * 767 + [2.0] * 256
        result = service.normalize_vectors([vector])[0]
        self.assertEqual(len(result), 768)
        self.assertEqual(result[0], 1.0)
        self.assertAlmostEqual(sum(value * value for value in result), 1.0)

    def test_invalid_vectors(self):
        for vector in ([0.0] * 1024, [math.nan] * 1024, [math.inf] * 1024, [1.0] * 10):
            with self.assertRaises(ValueError):
                service.normalize_vectors([vector])

    def test_cpu_and_cuda_selection(self):
        calls = []
        def factory(folder, device):
            calls.append(device)
            return FakeEncoder()
        service.load_encoder("unused", "auto", factory=factory, cuda_available=False)
        service.load_encoder("unused", "auto", factory=factory, cuda_available=True)
        self.assertEqual(calls, ["cpu", "cuda"])

    def test_cuda_failure_falls_back_once(self):
        calls = []
        def factory(folder, device):
            calls.append(device)
            if device == "cuda":
                raise RuntimeError("No GPU memory")
            return FakeEncoder()
        service.load_encoder("unused", "cuda", factory=factory, cuda_available=True)
        self.assertEqual(calls, ["cuda", "cpu"])

    def test_cpu_failure_is_not_retried(self):
        calls = []
        def factory(folder, device):
            calls.append(device)
            raise RuntimeError()
        with self.assertRaises(RuntimeError):
            service.load_encoder("unused", "cpu", factory=factory, cuda_available=False)
        self.assertEqual(calls, ["cpu"])


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.encoder = FakeEncoder()
        self.server = service.make_server(self.encoder, "127.0.0.1", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, route, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=2)
        try:
            connection.request(method, route, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_and_original_text(self):
        status, health = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["revision"], "a" * 40)
        body = json.dumps({"texts": ["Aku suka Hikari."], "task_type": "query"})
        status, result = self.request("POST", "/embed", body, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(result["dims"], 768)
        self.assertEqual(self.encoder.calls, [(["Aku suka Hikari."], "query")])

    def test_browser_origin_is_rejected(self):
        status, _ = self.request("GET", "/health", headers={"Origin": "https://external.example"})
        self.assertEqual(status, 403)

    def test_host_rebinding_is_rejected(self):
        status, _ = self.request("GET", "/health", headers={"Host": "external.example"})
        self.assertEqual(status, 403)

    def test_invalid_requests_never_encode(self):
        for data in ({"texts": []}, {"texts": ["x"] * 9}, {"texts": [""]},
                     {"texts": ["x"], "task_type": "other"}, {"texts": ["x"], "command": "run"}):
            status, _ = self.request("POST", "/embed", json.dumps(data), {"Content-Type": "application/json"})
            self.assertEqual(status, 400)
        self.assertEqual(self.encoder.calls, [])

    def test_simple_form_posts_are_rejected(self):
        status, _ = self.request("POST", "/embed", "texts=data", {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 400)

    def test_cannot_bind_public_address(self):
        with self.assertRaises(ValueError):
            service.make_server(self.encoder, "0.0.0.0", 8011)


class DownloadTests(unittest.TestCase):
    def fake_hub(self, contents, calls):
        siblings = [types.SimpleNamespace(rfilename=name, lfs=None,
                    blob_id=hashlib.sha1(f"blob {len(value)}\0".encode() + value).hexdigest())
                    for name, value in contents.items()]
        class Api:
            def model_info(self, name, revision=None, files_metadata=False):
                calls.append(("metadata", revision))
                return types.SimpleNamespace(sha="a" * 40, siblings=siblings)
        def download(name, revision, local_dir, allow_patterns):
            calls.append(("download", revision, tuple(allow_patterns)))
            for filename in allow_patterns:
                Path(local_dir, filename).write_bytes(contents[filename])
        return types.SimpleNamespace(HfApi=Api, snapshot_download=download)

    def content(self, weights):
        return {"config.json": b"{}", "tokenizer.json": b"{}", "tokenizer_config.json": b"{}", **weights}

    def run_download(self, contents):
        calls = []
        with tempfile.TemporaryDirectory(prefix="memory-download-test-") as folder:
            with patch.dict(sys.modules, {"huggingface_hub": self.fake_hub(contents, calls)}), \
                 patch.object(installer.importlib.metadata, "version", return_value="fixture"):
                receipt = installer.download(folder)
        return receipt, calls

    def test_prefers_safetensors(self):
        receipt, calls = self.run_download(self.content({"model.safetensors": b"safe", "pytorch_model.bin": b"bin"}))
        names = {file["path"] for file in receipt["files"]}
        self.assertIn("model.safetensors", names)
        self.assertNotIn("pytorch_model.bin", names)
        self.assertTrue(all(call[1] == "a" * 40 for call in calls if call[0] == "download"))

    def test_accepts_official_pytorch_weights(self):
        receipt, _ = self.run_download(self.content({"pytorch_model.bin": b"bin"}))
        self.assertIn("pytorch_model.bin", {file["path"] for file in receipt["files"]})

    def test_downloads_verified_shards(self):
        index = json.dumps({"weight_map": {"weight": "model-00001-of-00001.safetensors"}}).encode()
        receipt, _ = self.run_download(self.content({"model.safetensors.index.json": index,
                                                   "model-00001-of-00001.safetensors": b"shard"}))
        self.assertIn("model-00001-of-00001.safetensors", {file["path"] for file in receipt["files"]})

    def test_refuses_to_overwrite_modified_existing_file(self):
        contents = self.content({"pytorch_model.bin": b"bin"})
        calls = []
        with tempfile.TemporaryDirectory(prefix="memory-download-test-") as folder:
            Path(folder, "config.json").write_bytes(b"my local config")
            with patch.dict(sys.modules, {"huggingface_hub": self.fake_hub(contents, calls)}):
                with self.assertRaises(ValueError):
                    installer.download(folder)
            self.assertEqual(Path(folder, "config.json").read_bytes(), b"my local config")
        self.assertFalse(any(call[0] == "download" for call in calls))

    def test_rejects_weight_shard_path_traversal(self):
        index = json.dumps({"weight_map": {"weight": "../../outside.bin"}}).encode()
        with self.assertRaises(ValueError):
            self.run_download(self.content({"pytorch_model.bin.index.json": index, "../../outside.bin": b"invalid"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
