"""Password hashing (argon2), JWT tokens, auth dependencies, per-IP rate limiting."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import User

_hasher = PasswordHasher()
ALGORITHM = "HS256"

# A valid hash used to equalise timing when the user does not exist.
_DUMMY_HASH = _hasher.hash("dummy-password-for-timing")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: str) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {"sub": user_id, "iat": now, "exp": now + timedelta(minutes=s.ACCESS_TOKEN_EXPIRE_MINUTES)}
    return jwt.encode(payload, s.SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, get_settings().SECRET_KEY, algorithms=[ALGORITHM], options={"require": ["exp", "sub"]})
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) else None


def _unauthorized(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def _token_from_request(request: Request, allow_query: bool) -> str | None:
    auth = request.headers.get("authorization")
    if auth:
        scheme, _, value = auth.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    if allow_query:
        tok = request.query_params.get("token")
        if tok:
            return tok
    return None


def _resolve_user(request: Request, db: Session, allow_query: bool) -> User:
    token = _token_from_request(request, allow_query)
    if not token:
        raise _unauthorized()
    user_id = decode_token(token)
    if not user_id:
        raise _unauthorized("Invalid or expired token")
    user = db.get(User, user_id)
    if user is None:
        raise _unauthorized("Invalid or expired token")
    return user


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Bearer header only."""
    return _resolve_user(request, db, allow_query=False)


def current_user_or_query(request: Request, db: Session = Depends(get_db)) -> User:
    """Bearer header or ?token= (for EventSource, <img>, <a href>, model loaders)."""
    return _resolve_user(request, db, allow_query=True)


class RateLimiter:
    """Simple in-memory sliding-window limiter keyed by (bucket, client ip). Per process."""

    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()

    def hit(self, bucket: str, key: str, limit: int, window: float) -> float | None:
        """Record a hit. Returns retry-after seconds if over the limit, else None."""
        now = time.monotonic()
        with self._lock:
            q = self._hits[(bucket, key)]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                return max(0.0, q[0] + window - now)
            q.append(now)
            if len(self._hits) > 50_000:  # crude memory bound
                for k in [k for k, v in self._hits.items() if not v]:
                    del self._hits[k]
            return None


rate_limiter = RateLimiter()


def client_ip(request: Request) -> str:
    # uvicorn --proxy-headers rewrites request.client from X-Forwarded-For for trusted proxies.
    return request.client.host if request.client else "unknown"


def auth_rate_limit(bucket: str):
    def dep(request: Request) -> None:
        s = get_settings()
        retry = rate_limiter.hit(bucket, client_ip(request), s.AUTH_RATE_LIMIT, s.AUTH_RATE_WINDOW_SECONDS)
        if retry is not None:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts. Please wait a minute and try again.",
                headers={"Retry-After": str(int(retry) + 1)},
            )

    return dep
