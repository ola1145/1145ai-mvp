FROM python:3.12-slim
RUN pip install --no-cache-dir uv && useradd --create-home --uid 10001 app
WORKDIR /app
RUN chown app:app /app
USER app
# Install into /app/.venv and run from it directly: `uv run` at start-up would re-sync (and pull dev dependencies).
ENV UV_PROJECT_ENVIRONMENT=/app/.venv UV_LINK_MODE=copy PYTHONUNBUFFERED=1 PYTHONPATH=/app/src PATH="/app/.venv/bin:$PATH"
COPY --chown=app:app pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY --chown=app:app src ./src
# Bake the VAD and turn-detector model files into the image so a cold task never downloads them mid-call.
RUN python -m frontdesk.worker download-files
# ECS Fargate: the worker connects OUT to LiveKit (LIVEKIT_URL/API_KEY/API_SECRET); no inbound ports needed.
# Deploys send SIGTERM: the LiveKit worker stops accepting new calls and finishes the live ones (ECS waits stopTimeout, see voice-stack.ts).
STOPSIGNAL SIGTERM
CMD ["python", "-m", "frontdesk.worker", "start"]
