FROM python:3.12-slim
RUN pip install --no-cache-dir uv
WORKDIR /app
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project
COPY src ./src
ENV PYTHONPATH=/app/src PYTHONUNBUFFERED=1
RUN uv run python -m frontdesk.worker download-files
# ECS Fargate: the worker connects OUT to LiveKit (LIVEKIT_URL/API_KEY/API_SECRET); no inbound ports needed.
CMD ["uv", "run", "python", "-m", "frontdesk.worker", "start"]
