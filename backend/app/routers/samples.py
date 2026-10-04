from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import storage
from ..models import Project, User, utcnow
from ..schemas import ProjectOut, SampleOut, project_out
from ..security import current_user
from ..services import ServiceError, ingest_files, natural_key
from ..storage import make_image_thumb

router = APIRouter(prefix="/api/samples", tags=["samples"])

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
_VID_EXT = {".mp4", ".mov", ".m4v", ".webm"}


def _sample_dir(name: str) -> Path | None:
    if not _NAME_RE.match(name):
        return None
    root = get_settings().SAMPLES_DIR
    d = root / name
    return d if (d / "images").is_dir() else None


def _sample_files(d: Path) -> list[Path]:
    files = [
        p for p in (d / "images").iterdir() if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in (_IMG_EXT | _VID_EXT)
    ]
    return sorted(files, key=lambda p: natural_key(p.name))


def _meta(d: Path) -> dict:
    try:
        data = json.loads((d / "meta.json").read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _sample_out(name: str, d: Path) -> SampleOut:
    meta = _meta(d)
    files = _sample_files(d)
    return SampleOut(
        name=name,
        title=str(meta.get("title") or name.replace("_", " ").replace("-", " ").title()),
        description=str(meta.get("description") or ""),
        image_count=len(files),
        thumbnail_url=f"/api/samples/{name}/thumbnail" if any(p.suffix.lower() in _IMG_EXT for p in files) else None,
    )


@router.get("", response_model=list[SampleOut])
def list_samples():
    root = get_settings().SAMPLES_DIR
    if not root.is_dir():
        return []
    out = []
    for d in sorted(root.iterdir(), key=lambda p: natural_key(p.name)):
        if d.is_dir() and _sample_dir(d.name):
            out.append(_sample_out(d.name, d))
    return out


@router.get("/{name}/thumbnail")
def sample_thumbnail(name: str):
    """Public (samples are not user data). Not in the original table; referenced by `thumbnail_url`."""
    d = _sample_dir(name)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Sample not found")
    meta = _meta(d)
    files = [p for p in _sample_files(d) if p.suffix.lower() in _IMG_EXT]
    preferred = meta.get("thumbnail")
    if isinstance(preferred, str):
        files = [p for p in files if p.name == preferred] + files
    if not files:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Sample has no images")
    dest = storage().sample_thumb(name)
    if not dest.exists() or dest.stat().st_mtime < files[0].stat().st_mtime:
        make_image_thumb(files[0], dest)
    return FileResponse(dest, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@router.post("/{name}/project", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_from_sample(name: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    d = _sample_dir(name)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Sample not found")
    info = _sample_out(name, d)
    now = utcnow()
    p = Project(owner_id=user.id, name=info.title, description=info.description, created_at=now, updated_at=now)
    db.add(p)
    db.flush()
    handles = [open(f, "rb") for f in _sample_files(d)]
    try:
        ingest_files(db, get_settings(), p, [(h, Path(h.name).name) for h in handles])
        db.commit()
    except ServiceError as e:
        db.rollback()
        raise HTTPException(e.status_code, detail=e.detail) from None
    finally:
        for h in handles:
            h.close()
    return project_out(db, p, detail=True)
