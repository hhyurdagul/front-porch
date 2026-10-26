# Deploying Front Porch

The live demo runs on Google Cloud Run (europe-west1) from the `Dockerfile` in this repository, deployed by `deploy/cloudrun.sh`. Keys come from Secret Manager; the image contains none.

## Run the container locally

```sh
docker build -t frontporch .
docker run --rm -p 8080:8080 --env-file .env frontporch
curl --fail http://localhost:8080/api/health
```

`.env` needs `QLOO_API_KEY`, `GEMINI_API_KEY` and `GEMINI_MODEL` (see `.env.example`). `/api/health` only shows the process is up and configured; the real check is building a plan in the browser.

## One-time Google Cloud setup

You need a billed project. The script expects an Artifact Registry repository, a runtime service account and two secrets to exist; the default names (`commonground`, `commonground-run`) are the ones our project already used and can be overridden with `REPOSITORY` and `RUNTIME_SA`.

```sh
export PROJECT_ID='[YOUR_PROJECT_ID]' REGION=europe-west1
export REPOSITORY=frontporch RUNTIME_SA="frontporch-run@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project="$PROJECT_ID"
gcloud artifacts repositories create "$REPOSITORY" --repository-format=docker --location="$REGION" --project="$PROJECT_ID"
gcloud iam service-accounts create frontporch-run --project="$PROJECT_ID"
# Put only the key bytes in each file, outside this directory:
gcloud secrets create QLOO_API_KEY --data-file='[PRIVATE_QLOO_KEY_FILE]' --project="$PROJECT_ID"
gcloud secrets create GEMINI_API_KEY --data-file='[PRIVATE_GEMINI_KEY_FILE]' --project="$PROJECT_ID"
for s in QLOO_API_KEY GEMINI_API_KEY; do
  gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
done
```

## Deploy

```sh
PROJECT_ID=... GEMINI_MODEL=gemini-3.5-flash-lite bash deploy/cloudrun.sh --dry-run   # prints the commands only
PROJECT_ID=... GEMINI_MODEL=gemini-3.5-flash-lite bash deploy/cloudrun.sh
```

The script builds with Cloud Build (or local Podman with `BUILD_MODE=podman`), deploys the image **by digest**, and sends all traffic to the new revision. Settings: 1 CPU, 1 GiB, one always-on instance (plans and the evidence cache live in memory and `/tmp`), concurrency 20, 300-second request timeout, session affinity, HTTP startup and liveness probes on `/api/health`.

Cost note: one always-on instance is billed while idle. Delete the service when the demo is no longer needed:
`gcloud run services delete frontporch --project="$PROJECT_ID" --region="$REGION"`

## After a deploy

A new revision starts with an empty evidence cache. The two judged presets (Alabama · hurricane, Oklahoma · tornado) still load instantly: their plans, built live on the production service on 2026-10-26, are recorded in `docs/demo-plans.json` and never expire, and the Gemini-alone answers inside them are pinned in `docs/baseline-seed.json`. "Rebuild live" and every other state and hazard are fetched live.
