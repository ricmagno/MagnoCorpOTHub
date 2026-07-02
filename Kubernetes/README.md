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
