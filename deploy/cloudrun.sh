#!/usr/bin/env bash
# Owner-run only. See DEPLOY.md for one-time resources, costs and teardown.
# A minimum of one warm instance incurs ongoing idle charges; alerts are not caps.
# Teardown (owner only): gcloud run services delete "$SERVICE" --project="$PROJECT_ID" --region="$REGION"
set -euo pipefail

dry_run=false
case "${1:-}" in
  --dry-run) dry_run=true; shift ;;
  --help|-h)
    printf '%s\n' 'Usage: PROJECT_ID=... GEMINI_MODEL=... bash deploy/cloudrun.sh [--dry-run]' \
      'Optional: REGION, SERVICE, REPOSITORY, BUILD_MODE=cloudbuild|podman, IMAGE_TAG,' \
      'IMAGE_DIGEST (full image@sha256:...; skips build), RUNTIME_SA,' \
      'QLOO_SECRET_VERSION=1, GEMINI_SECRET_VERSION=1, MAX_INSTANCES=1 (default), CONCURRENCY=20 (default).'
    exit 0 ;;
esac
[[ $# == 0 ]] || { printf 'Unknown argument: %s\n' "$1" >&2; exit 2; }
: "${PROJECT_ID:?Set PROJECT_ID to an existing billed project}"
: "${GEMINI_MODEL:?Set GEMINI_MODEL to an exact key-day verified model ID}"
REGION=${REGION:-europe-west1}
SERVICE=${SERVICE:-frontporch}
REPOSITORY=${REPOSITORY:-commonground}
BUILD_MODE=${BUILD_MODE:-cloudbuild}
IMAGE_TAG=${IMAGE_TAG:-candidate}
RUNTIME_SA=${RUNTIME_SA:-commonground-run@${PROJECT_ID}.iam.gserviceaccount.com}
QLOO_SECRET_VERSION=${QLOO_SECRET_VERSION:-1}
GEMINI_SECRET_VERSION=${GEMINI_SECRET_VERSION:-1}
MAX_INSTANCES=${MAX_INSTANCES:-1}  # sessions are in-memory: keep one instance for the judged demo
CONCURRENCY=${CONCURRENCY:-20}  # the app enforces its own per-session and upstream limits
[[ $PROJECT_ID =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo 'Invalid PROJECT_ID' >&2; exit 2; }
[[ $REGION =~ ^[a-z0-9-]+$ && $SERVICE =~ ^[a-z][a-z0-9-]{0,48}$ && $REPOSITORY =~ ^[a-z0-9-]+$ ]] || { echo 'Invalid resource name' >&2; exit 2; }
[[ $GEMINI_MODEL =~ ^[a-zA-Z0-9.-]+$ && $IMAGE_TAG =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || { echo 'Invalid model or tag' >&2; exit 2; }
[[ $QLOO_SECRET_VERSION =~ ^[1-9][0-9]*$ && $GEMINI_SECRET_VERSION =~ ^[1-9][0-9]*$ ]] || { echo 'Use numeric secret versions' >&2; exit 2; }
[[ $MAX_INSTANCES == 1 || $MAX_INSTANCES == 2 ]] || { echo 'MAX_INSTANCES must be 1 or 2' >&2; exit 2; }
[[ $BUILD_MODE == cloudbuild || $BUILD_MODE == podman ]] || { echo 'BUILD_MODE must be cloudbuild or podman' >&2; exit 2; }

app_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image_base="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}"
image="${image_base}:${IMAGE_TAG}"

# Dry-run never invokes gcloud, podman, authentication or network commands.
run() {
  if $dry_run; then printf '%q ' "$@"; printf '\n'; else "$@"; fi
}

if [[ -n ${IMAGE_DIGEST:-} ]]; then
  [[ $IMAGE_DIGEST == "$image_base"@sha256:* && ${IMAGE_DIGEST##*@sha256:} =~ ^[a-f0-9]{64}$ ]] || { echo 'IMAGE_DIGEST must be a full digest in this service repository' >&2; exit 2; }
  image=$IMAGE_DIGEST
else
  if [[ $BUILD_MODE == cloudbuild ]]; then
    run gcloud builds submit "$app_dir" --project="$PROJECT_ID" --region="$REGION" \
      --ignore-file="$app_dir/.gcloudignore" --tag="$image" --quiet
  else
    run podman build --platform=linux/amd64 -t "$image" "$app_dir"
    if $dry_run; then
      printf 'gcloud auth print-access-token --project=%q | podman login --username oauth2accesstoken --password-stdin %q\n' "$PROJECT_ID" "${REGION}-docker.pkg.dev"
    else
      gcloud auth print-access-token --project="$PROJECT_ID" | \
        podman login --username oauth2accesstoken --password-stdin "${REGION}-docker.pkg.dev"
    fi
    run podman push "$image"
  fi
  if $dry_run; then
    run gcloud artifacts docker images describe "$image" --project="$PROJECT_ID" '--format=value(image_summary.digest)'
    image="${image_base}@sha256:<DIGEST_FROM_PREVIOUS_COMMAND>"
  else
    digest=$(gcloud artifacts docker images describe "$image" --project="$PROJECT_ID" '--format=value(image_summary.digest)')
    [[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Registry did not return a digest' >&2; exit 1; }
    image="${image_base}@${digest}"
  fi
fi

# Reconciles the same service; repeated pinned-image runs do not create resources.
run gcloud run deploy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --platform=managed --image="$image" --service-account="$RUNTIME_SA" \
  --allow-unauthenticated --port=8080 --cpu=1 --memory=1Gi \
  --min=1 --max="$MAX_INSTANCES" --min-instances=1 --max-instances="$MAX_INSTANCES" \
  --concurrency="$CONCURRENCY" --session-affinity --timeout=300s \
  --set-env-vars="NODE_ENV=production,QLOO_MODE=live,QLOO_HOME=/tmp/frontporch-qloo,CACHE_DIR=/tmp/frontporch-cache,PREWARM=0,QLOO_BASE_URL=https://hackathon.api.qloo.com,QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com,GEMINI_MODEL=${GEMINI_MODEL}" \
  --set-secrets="QLOO_API_KEY=QLOO_API_KEY:${QLOO_SECRET_VERSION},GEMINI_API_KEY=GEMINI_API_KEY:${GEMINI_SECRET_VERSION}" \
  --startup-probe=httpGet.path=/api/health,httpGet.port=8080,periodSeconds=10,timeoutSeconds=3,failureThreshold=12 \
  --liveness-probe=httpGet.path=/api/health,httpGet.port=8080,periodSeconds=30,timeoutSeconds=3,failureThreshold=3 \
  --quiet
run gcloud run services update-traffic "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --to-latest --quiet
run gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" '--format=value(status.url)'
