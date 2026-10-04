from __future__ import annotations

import mimetypes

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import owned_artifact, storage
from ..models import User
from ..security import current_user_or_query

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])

CONTENT_TYPES = {
    "glb": "model/gltf-binary",
    "preview": "model/gltf-binary",
    "usdz": "model/vnd.usdz+zip",
    "obj_zip": "application/zip",
    "ply": "application/octet-stream",
    "thumbnail": "image/png",
    "report": "application/json",
}


def content_type_for(kind: str, filename: str) -> str:
    return CONTENT_TYPES.get(kind) or mimetypes.guess_type(filename)[0] or "application/octet-stream"


@router.get("/{artifact_id}/download")
def download(
    artifact_id: str,
    inline: bool = Query(False, description="Content-Disposition: inline instead of attachment"),
    user: User = Depends(current_user_or_query),
    db: Session = Depends(get_db),
):
    art = owned_artifact(db, user, artifact_id)
    jdir = storage().job_dir(art.job_id).resolve()
    path = (jdir / art.rel_path).resolve()
    if not path.is_relative_to(jdir) or not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Artifact file is missing")
    # FileResponse implements HTTP Range / If-Range / ETag / Last-Modified.
    disposition = "inline" if (inline or art.kind == "thumbnail") else "attachment"
    return FileResponse(
        path,
        media_type=content_type_for(art.kind, art.filename),
        filename=art.filename,
        content_disposition_type=disposition,
        headers={"Cache-Control": "private, max-age=3600"},
    )
