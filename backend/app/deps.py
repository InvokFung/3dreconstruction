"""Shared lookups that enforce ownership (others' resources are reported as 404)."""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import Artifact, Image, Job, Project, User
from .storage import Storage


def storage() -> Storage:
    return Storage(get_settings())


def not_found(what: str = "Not found") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail=what)


def owned_project(db: Session, user: User, project_id: str, *, lock: bool = False) -> Project:
    stmt = select(Project).where(Project.id == project_id, Project.owner_id == user.id)
    if lock and db.get_bind().dialect.name == "postgresql":
        stmt = stmt.with_for_update()
    p = db.scalars(stmt).first()
    if p is None:
        raise not_found("Project not found")
    return p


def owned_image(db: Session, user: User, project_id: str, image_id: str) -> Image:
    img = db.scalars(
        select(Image)
        .join(Project, Image.project_id == Project.id)
        .where(Image.id == image_id, Image.project_id == project_id, Project.owner_id == user.id)
    ).first()
    if img is None:
        raise not_found("Image not found")
    return img


def owned_job(db: Session, user: User, job_id: str) -> Job:
    job = db.scalars(
        select(Job).join(Project, Job.project_id == Project.id).where(Job.id == job_id, Project.owner_id == user.id)
    ).first()
    if job is None:
        raise not_found("Job not found")
    return job


def owned_artifact(db: Session, user: User, artifact_id: str) -> Artifact:
    art = db.scalars(
        select(Artifact)
        .join(Job, Artifact.job_id == Job.id)
        .join(Project, Job.project_id == Project.id)
        .where(Artifact.id == artifact_id, Project.owner_id == user.id)
    ).first()
    if art is None:
        raise not_found("Artifact not found")
    return art
