FROM node:24-bookworm-slim AS node
FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends git libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --default-timeout=120 --retries=5 'vaquum-limen[data,boosting,indicators,stats]==5.30.2'
RUN useradd --create-home --uid 10001 grid \
    && mkdir /data && chown grid:grid /data
WORKDIR /app
COPY grid/ grid/
COPY web/ web/
COPY tools/build.py tools/build.py
COPY tools/agent_query.mjs tools/agent_query.mjs
COPY package.json package.json
RUN python tools/build.py --out dist/grid.html
COPY deploy/start.sh /app/deploy/start.sh
USER grid
RUN git config --global user.name Grid \
    && git config --global user.email grid@localhost
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["sh", "/app/deploy/start.sh"]
CMD ["python", "-m", "grid", "serve", "--project", "/data/project", "--bind", "127.0.0.1", "--port", "8490", "--public-origin", "https://grid.vaquum.fi", "--limen-cli", "/usr/local/bin/limen", "--limen-python", "/usr/local/bin/python"]
