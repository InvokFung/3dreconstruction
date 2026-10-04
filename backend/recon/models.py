"""Registry and lazy download of model weights.

All weights live under ``RECON_MODEL_DIR`` (default ``~/.cache/recon``). Nothing is downloaded
at import time; each loader fetches what it needs on first use. ``python -m recon.cli
--download-models`` pre-fetches everything (for Docker image builds).
"""

from __future__ import annotations

import logging
import shutil
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .runtime import configure_model_cache_env, model_dir

log = logging.getLogger("recon")

# Pinned Hugging Face revisions (commit SHAs) for reproducibility and, for BiRefNet, because it
# uses ``trust_remote_code``: never execute unpinned remote code.
BIREFNET_REPO = "ZhengPeng7/BiRefNet_lite"
BIREFNET_REVISION = "aa62cd87eafb9cc43056d08ef3615a14628b831d"

DA3_REPOS = {
    "depth-anything/DA3-SMALL": None,
    "depth-anything/DA3-BASE": None,
    "depth-anything/DA3-LARGE-1.1": None,
}
DA3_METRIC_REPO = "depth-anything/DA3METRIC-LARGE"
DAV2_FALLBACK_REPO = "depth-anything/Depth-Anything-V2-Small-hf"  # Apache-2.0 (Base/Large are NC)
RETRIEVAL_REPO = "facebook/dinov2-small"

ALIKED_NAME = "aliked-n16rot"
ALIKED_URLS = (
    f"https://raw.githubusercontent.com/Shiaoming/ALIKED/main/models/{ALIKED_NAME}.pth",
    f"https://huggingface.co/kornia/aliked/resolve/main/{ALIKED_NAME}.pth",
)


@dataclass(frozen=True)
class ModelInfo:
    key: str
    description: str
    license: str


MODEL_INFO = (
    ModelInfo("aliked+lightglue", "ALIKED-N16rot keypoints + LightGlue matcher (kornia)", "BSD-3 / Apache-2.0"),
    ModelInfo("birefnet-lite", "BiRefNet-lite dichotomous segmentation for object masks", "MIT"),
    ModelInfo("da3", "Depth Anything 3 (SMALL/BASE/LARGE-1.1) pose-conditioned multi-view depth", "Apache-2.0"),
    ModelInfo("da3-metric", "Depth Anything 3 Metric-Large for real-world scale", "Apache-2.0"),
    ModelInfo("dav2-small", "Depth Anything V2 Small (fallback mono depth)", "Apache-2.0"),
    ModelInfo("dinov2-small", "DINOv2-small global descriptors for image retrieval", "Apache-2.0"),
)


def torch_checkpoint_dir() -> Path:
    configure_model_cache_env()
    import os

    d = Path(os.environ["TORCH_HOME"]) / "hub" / "checkpoints"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _download(urls: tuple[str, ...], dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    last: Exception | None = None
    for url in urls:
        tmp = dest.with_suffix(dest.suffix + ".part")
        try:
            log.info("Downloading %s", url)
            with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:  # noqa: S310
                shutil.copyfileobj(r, f, length=1 << 20)
            tmp.replace(dest)
            return dest
        except Exception as e:  # try the next mirror
            last = e
            tmp.unlink(missing_ok=True)
    raise RuntimeError(f"Could not download {dest.name}: {last}")


def ensure_aliked_weights() -> Path:
    """kornia's ALIKED loader reads ``$TORCH_HOME/hub/checkpoints/<name>.pth``; pre-seed it
    from mirrors because github.com/raw redirects are blocked in some egress setups."""
    return _download(ALIKED_URLS, torch_checkpoint_dir() / f"{ALIKED_NAME}.pth")


def hf_snapshot(repo_id: str, revision: str | None = None) -> Path:
    configure_model_cache_env()
    from huggingface_hub import snapshot_download

    return Path(snapshot_download(repo_id=repo_id, revision=revision))


def download_all(include_large: bool = True) -> list[str]:
    """Fetch every CPU-pipeline model. Returns a list of human-readable status lines."""
    configure_model_cache_env()
    status: list[str] = []

    def step(name: str, fn) -> None:  # type: ignore[no-untyped-def]
        try:
            fn()
            status.append(f"ok   {name}")
        except Exception as e:  # keep going; report at the end
            status.append(f"FAIL {name}: {e}")

    step("aliked", ensure_aliked_weights)

    def _lightglue() -> None:
        import kornia.feature as KF

        KF.LightGlue("aliked")

    step("lightglue(aliked)", _lightglue)
    step("birefnet-lite", lambda: hf_snapshot(BIREFNET_REPO, BIREFNET_REVISION))
    for repo in DA3_REPOS:
        if "LARGE" in repo and not include_large:
            continue
        step(repo, lambda r=repo: hf_snapshot(r))
    step(DA3_METRIC_REPO, lambda: hf_snapshot(DA3_METRIC_REPO))
    step(DAV2_FALLBACK_REPO, lambda: hf_snapshot(DAV2_FALLBACK_REPO))
    step(RETRIEVAL_REPO, lambda: hf_snapshot(RETRIEVAL_REPO))
    status.append(f"cache: {model_dir()}")
    return status
