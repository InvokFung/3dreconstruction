"""Domain operations shared by routers: image ingest, job submission, project deletion."""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import BinaryIO

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .models import Image, Job, Project, utcnow
from .recon_runner import capabilities_cache
from .schemas import JobCreateIn
from .storage import (
    Storage,
    UploadRejected,
    copy_stream_limited,
    format_log_lines,
    link_or_copy,
    make_image_thumb,
    make_video_placeholder_thumb,
    rmtree_quiet,
    safe_filename,
    sniff_file,
)

log = logging.getLogger(__name__)


class ServiceError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


# ---------------------------------------------------------------- images


def image_count(db: Session, project_id: str) -> int:
    return db.scalar(select(func.count()).select_from(Image).where(Image.project_id == project_id)) or 0


def ingest_files(
    db: Session,
    settings: Settings,
    project: Project,
    files: list[tuple[BinaryIO, str]],
) -> list[Image]:
    """Validate and store uploads all-or-nothing. `files` = [(readable binary stream, original filename)].

    Raises ServiceError (400/413/415) and leaves no files behind on failure. Caller commits.
    """
    st = Storage(settings)
    existing = image_count(db, project.id)
    if existing + len(files) > settings.MAX_FILES_PER_PROJECT:
        raise ServiceError(
            400,
            f"A project can hold at most {settings.MAX_FILES_PER_PROJECT} files "
            f"({existing} already uploaded, {len(files)} more submitted)",
        )
    images_dir, thumbs_dir = st.images_dir(project.id), st.thumbs_dir(project.id)
    images_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    start_pos = (db.scalar(select(func.max(Image.position)).where(Image.project_id == project.id)) or 0) + 1

    created_paths: list[Path] = []
    images: list[Image] = []
    try:
        for i, (stream, original) in enumerate(files):
            display = safe_filename(original, default=f"file{i + 1}")
            image_id = str(uuid.uuid4())
            tmp = images_dir / f".upload-{image_id}"
            created_paths.append(tmp)
            size = copy_stream_limited(stream, tmp, settings.max_upload_bytes, display)
            info = sniff_file(tmp, display)
            final = images_dir / f"{image_id}{info.ext}"
            os.replace(tmp, final)
            created_paths.append(final)
            thumb = st.thumb_path(project.id, image_id)
            created_paths.append(thumb)
            if info.kind == "image":
                try:
                    make_image_thumb(final, thumb)
                except Exception:  # decoding succeeded at sniff time; be defensive anyway
                    log.exception("thumbnail generation failed", extra={"image_id": image_id})
                    make_video_placeholder_thumb(thumb)
            else:
                make_video_placeholder_thumb(thumb)
            stem = os.path.splitext(display)[0] or "file"
            images.append(
                Image(
                    id=image_id,
                    project_id=project.id,
                    filename=f"{stem}{info.ext}" if not display.lower().endswith(info.ext) else display,
                    stored_name=final.name,
                    kind=info.kind,
                    content_type=info.content_type,
                    size_bytes=size,
                    width=info.width,
                    height=info.height,
                    position=start_pos + i,
                    created_at=utcnow(),
                )
            )
    except UploadRejected as e:
        for p in created_paths:
            p.unlink(missing_ok=True)
        raise ServiceError(e.status_code, e.detail) from None
    except BaseException:
        for p in created_paths:
            p.unlink(missing_ok=True)
        raise
    db.add_all(images)
    project.updated_at = utcnow()
    return images


def delete_image_files(settings: Settings, img: Image) -> None:
    st = Storage(settings)
    st.image_path(img.project_id, img.stored_name).unlink(missing_ok=True)
    st.thumb_path(img.project_id, img.id).unlink(missing_ok=True)


# ---------------------------------------------------------------- jobs


def submit_job(db: Session, settings: Settings, project: Project, body: JobCreateIn) -> Job:
    images = db.scalars(select(Image).where(Image.project_id == project.id).order_by(Image.created_at, Image.position)).all()
    if not images:
        raise ServiceError(400, "Add some photos or a video to the project before starting a reconstruction")

    caps = capabilities_cache.get(settings)
    if "error" not in caps:
        eng = (caps.get("engines") or {}).get(body.engine)
        if isinstance(eng, dict) and eng.get("available") is False:
            reason = eng.get("reason") or "not available on this server"
            raise ServiceError(400, f"The {body.engine} engine is unavailable: {reason}")

    options = body.options.model_dump()
    job = Job(
        project_id=project.id,
        engine=body.engine,
        options=options,
        status="queued",
        progress=0.0,
        created_at=utcnow(),
        cancel_requested=False,
        attempts=0,
    )
    db.add(job)
    try:
        db.flush()  # enforces the one-active-job-per-project unique index
    except IntegrityError:
        db.rollback()
        raise ServiceError(409, "This project already has a reconstruction in progress") from None

    st = Storage(settings)
    jdir = st.job_dir(job.id)
    try:
        inp = jdir / "input"
        (jdir / "output").mkdir(parents=True, exist_ok=True)
        inp.mkdir(parents=True, exist_ok=True)
        for n, img in enumerate(images, start=1):
            src = st.image_path(project.id, img.stored_name)
            stem = os.path.splitext(safe_filename(img.filename))[0][:80] or "img"
            ext = os.path.splitext(img.stored_name)[1]
            link_or_copy(src, inp / f"{n:04d}_{stem}{ext}")
        config = {"engine": body.engine, **options}
        (jdir / "config.json").write_text(json.dumps(config, indent=2))
        with open(st.job_log(job.id), "a", encoding="utf-8") as f:
            f.write(format_log_lines("info", f"Job queued with {len(images)} input file(s); engine={body.engine}"))
    except Exception:
        db.rollback()
        rmtree_quiet(jdir)
        raise
    project.updated_at = utcnow()
    return job


def delete_project_files(settings: Settings, project_id: str, job_ids: list[str]) -> None:
    st = Storage(settings)
    rmtree_quiet(st.project_dir(project_id))
    for jid in job_ids:
        rmtree_quiet(st.job_dir(jid))
