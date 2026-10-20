FROM ghcr.io/astral-sh/uv:0.11.32-python3.13-trixie-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY server.py .
EXPOSE 8080
CMD [".venv/bin/python", "server.py"]
