# Live values for this submission's deployment. To deploy elsewhere, point
# project_id at your own project (must match the bucket in backend.tf).
# It must match the bucket name in backend.tf, which cannot read variables.
project_id = "project-2764c5ca-8149-443b-b81"
region     = "us-central1"
# Real address supplied at apply time (kept out of the public repo):
#   terraform apply -var alert_email=<your-address>
alert_email = "oncall@example.com"
