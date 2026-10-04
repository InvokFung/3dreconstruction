from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import owned_image, owned_project, storage
from ..models import Job, Project, User, utcnow
from ..schemas import (
    ImageOut,
    JobCreateIn,
    JobOut,
    ProjectCreateIn,
    ProjectOut,
    ProjectPatchIn,
    image_out,
    job_out,
    project_out,
)
from ..security import current_user, current_user_or_query
from ..services import ServiceError, delete_image_files, delete_project_files, ingest_files, submit_job
from ..storage import make_image_thumb, make_video_placeholder_thumb

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _raise(e: ServiceError) -> HTTPException:
    return HTTPException(e.status_code, detail=e.detail)


@router.get("", response_model=list[ProjectOut], response_model_exclude={"__all__": {"images"}})
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    projects = db.scalars(select(Project).where(Project.owner_id == user.id).order_by(Project.created_at.desc())).all()
    out = []
    for p in projects:
        po = project_out(db, p, detail=True)
        po.images = None
        out.append(po)
    return out


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    now = utcnow()
    p = Project(owner_id=user.id, name=body.name, description=body.description or "", created_at=now, updated_at=now)
    db.add(p)
    db.commit()
    return project_out(db, p, detail=True)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return project_out(db, owned_project(db, user, project_id), detail=True)


@router.patch("/{project_id}", response_model=ProjectOut)
def patch_project(project_id: str, body: ProjectPatchIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = owned_project(db, user, project_id)
    if body.name is not None:
        p.name = body.name
    if body.description is not None:
        p.description = body.description
    p.updated_at = utcnow()
    db.commit()
    return project_out(db, p, detail=True)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = owned_project(db, user, project_id)
    job_ids = list(db.scalars(select(Job.id).where(Job.project_id == p.id)).all())
    # A running job's worker notices its row is gone and kills the pipeline process.
    db.delete(p)
    db.commit()
    delete_project_files(get_settings(), project_id, job_ids)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ images


@router.post("/{project_id}/images", response_model=list[ImageOut], status_code=status.HTTP_201_CREATED)
def upload_images(
    project_id: str,
    files: list[UploadFile] = File(..., description="Images (JPEG/PNG/WebP/HEIC) or videos (MP4/MOV/WebM)"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    p = owned_project(db, user, project_id)
    try:
        images = ingest_files(db, get_settings(), p, [(f.file, f.filename or "") for f in files])
        db.commit()
    except ServiceError as e:
        db.rollback()
        raise _raise(e) from None
    finally:
        for f in files:
            f.file.close()
    return [image_out(i) for i in images]


@router.delete("/{project_id}/images/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_image(project_id: str, image_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    img = owned_image(db, user, project_id, image_id)
    img.project.updated_at = utcnow()
    db.delete(img)
    db.commit()
    delete_image_files(get_settings(), img)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{project_id}/images/{image_id}/file")
def image_file(
    project_id: str,
    image_id: str,
    thumb: bool = Query(False),
    user: User = Depends(current_user_or_query),
    db: Session = Depends(get_db),
):
    img = owned_image(db, user, project_id, image_id)
    st = storage()
    headers = {"Cache-Control": "private, max-age=86400"}
    if thumb:
        tp = st.thumb_path(project_id, image_id)
        if not tp.exists():
            src = st.image_path(project_id, img.stored_name)
            try:
                if img.kind == "image" and src.exists():
                    make_image_thumb(src, tp)
                else:
                    make_video_placeholder_thumb(tp)
            except Exception:
                make_video_placeholder_thumb(tp)
        return FileResponse(tp, media_type="image/jpeg", headers=headers)
    path = st.image_path(project_id, img.stored_name)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="File missing")
    return FileResponse(path, media_type=img.content_type, filename=img.filename, content_disposition_type="inline", headers=headers)


# ------------------------------------------------------------------ jobs


@router.post("/{project_id}/jobs", response_model=JobOut, status_code=status.HTTP_201_CREATED)
def create_job(project_id: str, body: JobCreateIn | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = owned_project(db, user, project_id, lock=True)
    try:
        job = submit_job(db, get_settings(), p, body or JobCreateIn())
        db.commit()
    except ServiceError as e:
        raise _raise(e) from None
    db.refresh(job)
    return job_out(job)


@router.get("/{project_id}/jobs", response_model=list[JobOut])
def list_jobs(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = owned_project(db, user, project_id)
    jobs = db.scalars(select(Job).where(Job.project_id == p.id).order_by(Job.created_at.desc())).all()
    return [job_out(j) for j in jobs]
