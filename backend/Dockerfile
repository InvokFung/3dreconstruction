# syntax=docker/dockerfile:1.7
# Build context: the repository root (needs backend/ and samples/).
#   docker build -f backend/Dockerfile --target api    -t recon-api .
#   docker build -f backend/Dockerfile --target worker -t recon-worker .
#   GPU worker:
#   docker build -f backend/Dockerfile --target worker \
#     --build-arg WORKER_BASE_IMAGE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
#     --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124 -t recon-worker:gpu .

ARG PYTHON_IMAGE=python:3.11-slim
# Any Debian/Ubuntu image works; if it has no python3 >= 3.11, one is installed (deadsnakes on Ubuntu).
ARG WORKER_BASE_IMAGE=python:3.11-slim

# ---------------------------------------------------------------- api dependencies
FROM ${PYTHON_IMAGE} AS api-deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
COPY backend/requirements-api.txt /tmp/requirements-api.txt
# Optional CA bundle for TLS-intercepting proxies: --secret id=ca_bundle,src=/path/to/ca.crt
RUN --mount=type=secret,id=ca_bundle,required=false \
    if [ -s /run/secrets/ca_bundle ]; then export PIP_CERT=/run/secrets/ca_bundle; fi; \
    /opt/venv/bin/pip install -r /tmp/requirements-api.txt

# ---------------------------------------------------------------- api (slim)
FROM ${PYTHON_IMAGE} AS api
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH \
    DATA_DIR=/data SAMPLES_DIR=/app/samples TMPDIR=/data/tmp LOG_FORMAT=json
RUN groupadd --system --gid 1000 app && useradd --system --uid 1000 --gid app --home /app app \
    && mkdir -p /data/tmp && chown -R app:app /data
COPY --from=api-deps /opt/venv /opt/venv
WORKDIR /app
COPY backend/alembic.ini ./alembic.ini
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY samples ./samples
USER app
EXPOSE 8000
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-keep-alive", "75"]

# ---------------------------------------------------------------- worker (API code + pipeline deps)
FROM ${WORKER_BASE_IMAGE} AS worker
ARG DEBIAN_FRONTEND=noninteractive
# Extra index for torch wheels (e.g. https://download.pytorch.org/whl/cpu or .../cu124). Empty = PyPI.
ARG TORCH_INDEX_URL=""
ARG EXTRA_APT_PACKAGES=""
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/opt/venv/bin:$PATH DATA_DIR=/data SAMPLES_DIR=/app/samples TMPDIR=/data/tmp LOG_FORMAT=json \
    RECON_PYTHON=/opt/venv/bin/python RECON_PATH=/app \
    MODEL_CACHE_DIR=/models HF_HOME=/models/huggingface TORCH_HOME=/models/torch XDG_CACHE_HOME=/models/cache \
    U2NET_HOME=/models/u2net
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates ffmpeg libgl1 libglib2.0-0 libgomp1 ${EXTRA_APT_PACKAGES}; \
    if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then \
        apt-get install -y --no-install-recommends software-properties-common gpg-agent; \
        add-apt-repository -y ppa:deadsnakes/ppa; apt-get update; \
        apt-get install -y --no-install-recommends python3.11 python3.11-venv; \
        ln -sf /usr/bin/python3.11 /usr/local/bin/python3; \
    fi; \
    python3 -c 'import ensurepip' 2>/dev/null || apt-get install -y --no-install-recommends python3-venv; \
    python3 -m venv /opt/venv; \
    rm -rf /var/lib/apt/lists/*
COPY backend/requirements-api.txt /tmp/requirements-api.txt
COPY backend/recon/requirements.txt /tmp/requirements-recon.txt
RUN --mount=type=secret,id=ca_bundle,required=false \
    if [ -s /run/secrets/ca_bundle ]; then export PIP_CERT=/run/secrets/ca_bundle; fi; \
    pip install --upgrade pip \
    && pip install ${TORCH_INDEX_URL:+--extra-index-url ${TORCH_INDEX_URL}} -r /tmp/requirements-recon.txt \
    && pip install -r /tmp/requirements-api.txt
RUN (getent group 1000 || groupadd --gid 1000 app) \
    && (getent passwd 1000 || useradd --uid 1000 --gid 1000 --home /app app) \
    && mkdir -p /data/tmp /models && chown -R 1000:1000 /data /models
WORKDIR /app
COPY backend/alembic.ini ./alembic.ini
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY backend/recon ./recon
COPY samples ./samples
USER 1000:1000
VOLUME ["/data", "/models"]
# SIGTERM: stop claiming, stop running pipelines and re-queue them.
STOPSIGNAL SIGTERM
CMD ["python", "-m", "app.worker"]
