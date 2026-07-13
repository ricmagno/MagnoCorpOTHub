#!/bin/bash

# Script to update all magnocorp-othub instances to a new image version
# Usage: ./update-all-instances.sh <new-image-tag>
# Example: ./update-all-instances.sh 0.78.0

if [ $# -ne 1 ]; then
    echo "Usage: $0 <new-image-tag>"
    echo "Example: $0 0.78.0"
    exit 1
fi

NEW_TAG=$1
IMAGE_NAME="magnocorp-othub:$NEW_TAG"

echo "Updating all magnocorp-othub instances to $IMAGE_NAME"

# Get all deployments in the magnocorp-othub namespace
DEPLOYMENTS=$(kubectl get deployments -n magnocorp-othub -o jsonpath='{.items[*].metadata.name}')

if [ -z "$DEPLOYMENTS" ]; then
    echo "No deployments found in magnocorp-othub namespace"
    exit 1
fi

for DEPLOYMENT in $DEPLOYMENTS; do
    echo "Updating deployment: $DEPLOYMENT"
    kubectl set image deployment/$DEPLOYMENT magnocorp-othub=$IMAGE_NAME -n magnocorp-othub

    # Wait for rollout to complete
    kubectl rollout status deployment/$DEPLOYMENT -n magnocorp-othub --timeout=300s

    if [ $? -eq 0 ]; then
        echo "✓ $DEPLOYMENT updated successfully"
    else
        echo "✗ Failed to update $DEPLOYMENT"
    fi
done

echo ""
echo "Update complete! Checking pod status:"
kubectl get pods -n magnocorp-othub