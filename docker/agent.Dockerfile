# An image for ai-perf workers on Kubernetes (target k8s, CONTRACTS §3b): Node, ai-perf at /ai-perf,
# and the engines that run in it. Build from the ai-perf folder:
#   docker build -f docker/agent.Dockerfile -t <registry>/ai-perf-agent:<version> .
# fake and ws need only Node. For Locust, build with --build-arg LOCUST=2.43.1; for k6, with
# --build-arg K6=1.0.0.
FROM node:22-alpine
ARG LOCUST=
ARG K6=
# Set by docker buildx for the platform built: amd64 or arm64.
ARG TARGETARCH=amd64
RUN if [ -n "$LOCUST" ]; then apk add --no-cache python3 py3-pip && pip install --break-system-packages "locust==$LOCUST" psutil; fi \
 && if [ -n "$K6" ]; then wget -qO- "https://github.com/grafana/k6/releases/download/v$K6/k6-v$K6-linux-$TARGETARCH.tar.gz" | tar xz -C /usr/local/bin --strip-components=1; fi
# The k6 archive is not checksummed here: pin K6 to a version you have verified, or build from a
# base image that ships it.
COPY . /ai-perf
USER node
ENTRYPOINT ["node", "/ai-perf/bin/perf-agent.mjs"]
