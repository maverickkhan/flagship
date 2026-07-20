terraform {
  backend "gcs" {
    # Backend blocks cannot interpolate variables — this is the one place the
    # project id is repeated by hand. The bucket is created by infra/bootstrap
    # and the GCS backend locks state natively (no extra lock table). If your
    # project id differs, override at init time:
    #   terraform init -backend-config="bucket=<your-project-id>-tfstate"
    bucket = "flagship-demo-project-tfstate"
    prefix = "envs/staging"
  }
}
