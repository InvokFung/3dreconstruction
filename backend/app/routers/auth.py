from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..schemas import LoginIn, RegisterIn, TokenOut, UserOut, user_out
from ..security import auth_rate_limit, create_access_token, current_user, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _token(user: User) -> TokenOut:
    return TokenOut(access_token=create_access_token(user.id), user=user_out(user))


@router.post(
    "/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED, dependencies=[Depends(auth_rate_limit("register"))]
)
def register(body: RegisterIn, db: Session = Depends(get_db)) -> TokenOut:
    email = body.email.strip().lower()
    if db.scalars(select(User).where(User.email == email)).first() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="An account with this email already exists")
    user = User(email=email, name=body.name or email.split("@")[0], password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail="An account with this email already exists") from None
    return _token(user)


@router.post("/login", response_model=TokenOut, dependencies=[Depends(auth_rate_limit("login"))])
def login(body: LoginIn, db: Session = Depends(get_db)) -> TokenOut:
    user = db.scalars(select(User).where(User.email == body.email.strip().lower())).first()
    if not verify_password(body.password, user.password_hash if user else None) or user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    return _token(user)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)) -> UserOut:
    return user_out(user)
