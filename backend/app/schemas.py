"""Request/response schemas and serializers (shapes from docs/ARCHITECTURE.md section 2)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import JOB_ACTIVE, Artifact, Image, Job, Project, User

# ------------------------------------------------------------------ helpers


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:  # SQLite returns naive datetimes; they are stored as UTC
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------------ requests


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    name: str = Field(default="", max_length=200)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=256)


class ProjectCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


class ProjectPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


ENGINES = ("photogrammetry", "generative")
FORMATS = ("glb", "obj", "ply", "usdz")


class JobOptions(BaseModel):
    """Pipeline config keys (section 1). Missing keys get defaults; unknown keys are ignored."""

    model_config = ConfigDict(extra="ignore")

    quality: Literal["draft", "standard", "high"] = "standard"
    mode: Literal["object", "scene"] = "object"
    texture_size: Literal[1024, 2048, 4096] = 2048
    target_faces: int = Field(default=100_000, ge=1_000, le=5_000_000)
    formats: list[Literal["glb", "obj", "ply", "usdz"]] = Field(default_factory=lambda: list(FORMATS), min_length=1)
    device: Literal["auto", "cpu", "cuda"] = "auto"

    @field_validator("formats")
    @classmethod
    def _dedupe(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for f in v:
            if f not in out:
                out.append(f)
        return out


class JobCreateIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    engine: Literal["photogrammetry", "generative"] = "photogrammetry"
    options: JobOptions = Field(default_factory=JobOptions)

    @field_validator("options", mode="before")
    @classmethod
    def _none_options(cls, v: Any) -> Any:
        return {} if v is None else v


# ------------------------------------------------------------------ responses


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    created_at: str


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    user: UserOut


class ImageOut(BaseModel):
    id: str
    filename: str
    kind: Literal["image", "video"]
    size_bytes: int
    width: int | None
    height: int | None
    thumb_url: str
    url: str
    created_at: str


class ArtifactOut(BaseModel):
    id: str
    kind: str
    filename: str
    size_bytes: int
    url: str


class JobOut(BaseModel):
    id: str
    project_id: str
    engine: str
    options: dict
    status: Literal["queued", "running", "succeeded", "failed", "canceled"]
    stage: str | None
    progress: float
    message: str | None
    error: str | None
    error_code: str | None = None  # extension: machine-readable error code from the pipeline
    metrics: dict | None
    created_at: str
    started_at: str | None
    finished_at: str | None
    artifacts: list[ArtifactOut]


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str
    created_at: str
    updated_at: str
    image_count: int
    thumbnail_url: str | None
    status: Literal["empty", "ready", "processing", "done", "failed"]
    images: list[ImageOut] | None = None
    latest_job: JobOut | None = None


class SampleOut(BaseModel):
    name: str
    title: str
    description: str
    image_count: int
    thumbnail_url: str | None


# ------------------------------------------------------------------ serializers


def user_out(u: User) -> UserOut:
    return UserOut(id=u.id, email=u.email, name=u.name, created_at=iso(u.created_at))


def image_file_url(img: Image) -> str:
    return f"/api/projects/{img.project_id}/images/{img.id}/file"


def image_thumb_url(project_id: str, image_id: str) -> str:
    return f"/api/projects/{project_id}/images/{image_id}/file?thumb=1"


def image_out(img: Image) -> ImageOut:
    return ImageOut(
        id=img.id,
        filename=img.filename,
        kind=img.kind,  # type: ignore[arg-type]
        size_bytes=img.size_bytes,
        width=img.width,
        height=img.height,
        thumb_url=image_thumb_url(img.project_id, img.id),
        url=image_file_url(img),
        created_at=iso(img.created_at),
    )


def artifact_url(artifact_id: str) -> str:
    return f"/api/artifacts/{artifact_id}/download"


def artifact_out(a: Artifact) -> ArtifactOut:
    return ArtifactOut(id=a.id, kind=a.kind, filename=a.filename, size_bytes=a.size_bytes, url=artifact_url(a.id))


def job_out(j: Job) -> JobOut:
    return JobOut(
        id=j.id,
        project_id=j.project_id,
        engine=j.engine,
        options=j.options or {},
        status=j.status,  # type: ignore[arg-type]
        stage=j.stage,
        progress=round(float(j.progress or 0.0), 2),
        message=j.message,
        error=j.error,
        error_code=j.error_code,
        metrics=j.metrics,
        created_at=iso(j.created_at),
        started_at=iso(j.started_at),
        finished_at=iso(j.finished_at),
        artifacts=[artifact_out(a) for a in j.artifacts],
    )


def derive_status(image_count: int, latest_job: Job | None) -> str:
    if latest_job is not None:
        if latest_job.status in JOB_ACTIVE:
            return "processing"
        if latest_job.status == "succeeded":
            return "done"
        if latest_job.status == "failed":
            return "failed"
    return "ready" if image_count > 0 else "empty"


def _thumbnail_for(db: Session, p: Project) -> str | None:
    art = db.scalars(
        select(Artifact)
        .join(Job, Artifact.job_id == Job.id)
        .where(Job.project_id == p.id, Job.status == "succeeded", Artifact.kind == "thumbnail")
        .order_by(Job.created_at.desc())
        .limit(1)
    ).first()
    if art is not None:
        return artifact_url(art.id)
    img = db.scalars(
        select(Image).where(Image.project_id == p.id).order_by((Image.kind != "image"), Image.created_at, Image.position).limit(1)
    ).first()
    return image_thumb_url(p.id, img.id) if img else None


def latest_job_for(db: Session, project_id: str) -> Job | None:
    return db.scalars(select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc()).limit(1)).first()


def project_out(db: Session, p: Project, detail: bool = False) -> ProjectOut:
    count = db.scalar(select(func.count()).select_from(Image).where(Image.project_id == p.id)) or 0
    latest = latest_job_for(db, p.id)
    out = ProjectOut(
        id=p.id,
        name=p.name,
        description=p.description or "",
        created_at=iso(p.created_at),
        updated_at=iso(p.updated_at),
        image_count=count,
        thumbnail_url=_thumbnail_for(db, p),
        status=derive_status(count, latest),  # type: ignore[arg-type]
    )
    if detail:
        imgs = db.scalars(select(Image).where(Image.project_id == p.id).order_by(Image.created_at, Image.position)).all()
        out.images = [image_out(i) for i in imgs]
        out.latest_job = job_out(latest) if latest else None
    return out
