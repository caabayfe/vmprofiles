# Multi-stage build: compile wheels into a virtualenv, then copy to runtime.
FROM python:3.13-slim AS builder

WORKDIR /build
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
# --system-site-packages: the runtime base image (rewritten by the platform
# build pipeline to the SDK-bearing curated image) has nttdsp.web baked into
# its global site-packages. Without this flag the venv is fully isolated and
# `import nttdsp.web` 404s at runtime — see ADR
# 2026-09-02-template-venv-system-site-packages.
RUN python -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt


FROM python:3.13-slim AS runtime

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Run as a non-root user. uid 10001 is the convention shared with
# yarp-files / scanner / share-janitor on the platform side, so any
# files written into mounted shares end up owned by the same uid the
# platform's housekeeping tools can clean up.
RUN groupadd --system --gid 10001 yarp \
    && useradd --system --uid 10001 --gid 10001 --no-create-home yarp

COPY --from=builder /opt/venv /opt/venv
COPY --chown=yarp:yarp . .

USER 10001

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
