# Deployment Specification

This document defines the authoritative deployment patterns for MagnoCorpOTHub.

## 🐳 Docker Deployment
The application uses a multi-stage Dockerfile optimized for security and multi-architecture builds (AMD64 and ARM64).

### Build Strategy
- **Base Image**: `node:20-bookworm-slim`.
- **User**: Runs as non-root user `historian` (UID 1001).
- **Stages**: 
  1. `backend-builder`: Compiles TypeScript.
  2. `client-builder`: Builds React frontend.
  3. `prod-deps`: Prepares production-only `node_modules`.
  4. `production`: Final small-footprint image.
- **Persistence**: Requires volumes for `/app/data`, `/app/reports`, and `/app/logs`.

## ☸️ Kubernetes Deployment
Deployment manifests are located in the `/Kubernetes` directory.

### Core Components
- **Namespace**: `magnocorp-othub` (defined in `magnocorp-othub-namespace.yaml`).
- **Workload**: `Deployment` (3 replicas by default) with an associated `HPA` for auto-scaling.
- **Networking**: 
  - `Service`: Standard ClusterIP.
  - `Ingress`: NGINX-based ingress for external access.
- **Configuration**: Uses `Secrets` and `ConfigMaps` for environment variables.

### Auto-Deployment
The repository includes automated CI/CD patterns in `.github/workflows/docker-publish.yml` that push images to GitHub Container Registry (GHCR).

## 🐕 Autodeploy Watchdog
The system implements a "Pull-based" continuous deployment strategy via a systemd-controlled script on the host server.

- **Component**: `Kubernetes/autodeploy/autodeploy.sh`.
- **Logic**: Polls GitHub API for the `latest` release tag and compares it to the running image version.
- **Trigger**: `magnocorp-othub-autodeploy.timer` runs every 5 minutes.
- **Authoritative Guide**: [Docs/KUBERNETES_SETUP_INSTRUCTIONS.md](../Docs/KUBERNETES_SETUP_INSTRUCTIONS.md).

## 🌍 Environment Variables (Containerized)
In addition to standard `.env` variables, the following are crucial for containers:
- `IS_DOCKER=true`: Enables specific logging and path logic for container environments.
- `DATA_DIR`, `REPORTS_DIR`, `LOG_FILE`: Points to persistent volume mounts.
- `OPCUA_MAX_CONNECTIONS` (default 64), `OPCUA_CONNECT_CONCURRENCY` (default 5): multi-connection OPC UA limits.

## 🔌 OPC UA Multi-Connection Sizing & Security
- **Memory**: budget **15–25 MB per OPC UA connection** worst case (large address spaces, many monitored items) plus Node.js baseline. At 50 connections plan 750 MB–1.25 GB for OPC UA alone — treat a 1 Gi container limit as the floor and set **2 Gi** at 50 connections. The `/api/health/services` payload reports process RSS/heap so operators can watch pressure; push connections beyond ~50–64 to edge collectors (Phase 2) rather than raising the in-process limit.
- **Certificates**: all local connections share one client certificate (one PKI folder at `DATA_DIR/pki`) and therefore one **ApplicationURI**. Strict OPC UA servers that require a unique ApplicationURI per client need the (reserved, not yet implemented) per-connection `certificateProfile` override.
- **Collectors (Phase 2)**: the app→collector socket.io link carries decrypted OPC UA credentials on configSync — production deployments MUST terminate it over TLS (`wss://`). Collector token rotation is manual in v1: register a new collector, then delete the old one.
