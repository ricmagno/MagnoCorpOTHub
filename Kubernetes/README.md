# Kubernetes Deployment - MagnoCorpOTHub

This directory contains the manifests for deploying the MagnoCorpOTHub application to a Kubernetes cluster.

> [!IMPORTANT]
> For the authoritative system architecture and deployment requirements, consult the [Deployment Specification](../spec/deployment.md).

## Setup Instructions

### 1. Configure Namespace
Apply the namespace manifest:
```bash
kubectl apply -f magnocorp-othub-namespace.yaml
```

### 2. Configure GHCR Access (imagePullSecret)
To pull images from the GitHub Container Registry, you must create a secret with a GitHub Personal Access Token (PAT).

1. Generate a PAT with `read:packages` permissions.
2. Run the following command:
```bash
kubectl create secret docker-registry ghcr-regcred \
  --docker-server=ghcr.io \
  --docker-username=ricmagno \
  --docker-password=<YOUR_GITHUB_PAT> \
  --docker-email=ricmagno@gmail.com \
  -n magnocorp-othub
```

### 3. Apply Environment Secrets
Update `magnocorp-othub-secret.yaml` with your actual database credentials and other secrets, then apply it:
```bash
kubectl apply -f magnocorp-othub-secret.yaml
```

### 4. Deploy the Application
```bash
kubectl apply -f magnocorp-othub-deployment.yaml
kubectl apply -f magnocorp-othub-service.yaml
kubectl apply -f magnocorp-othub-hpa.yaml
```

## TEVE

**TEVE (Tensor Embedding Vector Engine)** is a separate, optional time-series + vector-embedding
service: it stores historized metrics alongside embeddings of screenshots, metric windows, and
anomaly signatures, so the app can do similarity search ("find past incidents like this one",
"search dashboards by description") on top of an ordinary historian. It deploys independently from
the main app, sharing the same `magnocorp-othub` namespace and `ghcr-regcred` pull secret configured
above. See `db/TENSOR_HISTORIAN_IMPLEMENTATION_PLAN_V2.md` for full architecture; images are built by
the `build-and-push-historian` job in `.github/workflows/docker-publish.yml` (same version-tag
trigger as the main app).

### 1. Create the init-sql ConfigMap
```bash
kubectl create configmap historian-init-sql -n magnocorp-othub \
  --from-file=init.sql=database/init.sql
```

### 2. Configure secrets
Update `historian-secret.yaml` with real values (DB/MinIO credentials), then apply it:
```bash
kubectl apply -f historian-secret.yaml
```

### 3. Deploy the data tier
```bash
kubectl apply -f historian-postgres-deployment.yaml
kubectl apply -f historian-redis-deployment.yaml
kubectl apply -f historian-minio-deployment.yaml
kubectl apply -f historian-networkpolicy.yaml
```

### 4. Deploy the API and worker
```bash
kubectl apply -f historian-api-deployment.yaml
kubectl apply -f historian-worker-deployment.yaml
kubectl apply -f historian-ingress.yaml
```

**Note**: both images bake in the CLIP model cache at build time (`HISTORIAN_ALLOW_REMOTE_MODELS=false`), so no pod needs runtime internet access — required for air-gapped plant networks. Worker pods load the vision model at startup; API pods lazily load the smaller text encoder on the first `/api/teve/search` call (the API memory limit includes ~250MB headroom for it). The API image also ships Chromium (Puppeteer) for screenshot capture.

After schema changes, run the historian migration runner against the deployed database (from a machine that can reach it): `npm run historian:migrate` — it applies any pending `database/migrations/*.sql` and is a no-op otherwise.

## Automated Deployment (Watchdog)

To enable zero-manual deployment, set up the "Pull" watchdog on your SCADA server. This service checks GitHub every 5 minutes and updates the cluster if a new version is released.

### Setup Instructions:
1.  **Copy the scripts** from your local machine to your server:
    ```bash
    scp -r Kubernets/autodeploy scada.sa@192.168.235.16:~/Kubernets/
    ```

2.  **Install the service** (run these on the SCADA server):
    ```bash
    # Move the script to a system path
    sudo cp ~/Kubernets/autodeploy/autodeploy.sh /usr/local/bin/autodeploy.sh
    sudo chmod +x /usr/local/bin/autodeploy.sh

    # Install systemd service and timer
    sudo cp ~/Kubernets/autodeploy/magnocorp-othub-autodeploy.* /etc/systemd/system/
    
    # Enable and start the checker
    sudo systemctl daemon-reload
    sudo systemctl enable --now magnocorp-othub-autodeploy.timer
    ```

3.  **Verify**:
    ```bash
    # Check if the timer is active
    sudo systemctl status magnocorp-othub-autodeploy.timer
    
    # Run a check immediately to test
    sudo systemctl start magnocorp-othub-autodeploy.service
    ```

---

### How to Release a New Version
1.  On your local Mac, run: `./release.sh 0.82.0`
2.  **Wait ~5 minutes**. 
3.  GitHub builds the image -> Your SCADA server polls GitHub -> Kubernetes updates automatically.
4.  No extra terminal commands or passwords required!
