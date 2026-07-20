.PHONY: up down logs migrate seed demo test test-integration lint build docker-build docker-push bootstrap-image tf-fmt tf-validate tf-apply

# Local compose endpoints (host ports chosen to dodge locally installed
# Postgres/Redis); test-integration works on a fresh clone with no .env.
LOCAL_DB_URL ?= postgresql://flagship:flagship@localhost:5434/flagship?schema=public
LOCAL_REDIS_URL ?= redis://localhost:6380
LOCAL_ADMIN_TOKEN ?= local-dev-admin-token

up: ## Start full local stack (api + postgres + redis), migrate, seed
	docker compose up -d --build
	docker compose exec api npx prisma migrate deploy
	docker compose exec api npm run seed

down:
	docker compose down -v

logs:
	docker compose logs -f api

migrate:
	docker compose exec api npx prisma migrate deploy

seed:
	docker compose exec api npm run seed

demo: ## Scripted curl tour against the local stack
	./scripts/demo.sh http://localhost:8080 local-dev-admin-token

test:
	npm run test

test-integration:
	DATABASE_URL='$(LOCAL_DB_URL)' REDIS_URL='$(LOCAL_REDIS_URL)' ADMIN_TOKEN='$(LOCAL_ADMIN_TOKEN)' npm run test:integration

lint:
	npm run lint && npm run format:check && npm run typecheck

build:
	npm run build

docker-build:
	docker build --target runtime -t flagship-api:local .
	docker build --target migrate -t flagship-migrate:local .

# Push both images to Artifact Registry (REGISTRY=<region>-docker.pkg.dev/<project>/flagship)
docker-push: docker-build
	@test -n "$(REGISTRY)" || { echo "usage: make docker-push REGISTRY=us-central1-docker.pkg.dev/<project>/flagship [TAG=sha-...]"; exit 1; }
	docker tag flagship-api:local $(REGISTRY)/api:$(or $(TAG),local)
	docker tag flagship-migrate:local $(REGISTRY)/api:$(or $(TAG),local)-migrate
	docker push $(REGISTRY)/api:$(or $(TAG),local)
	docker push $(REGISTRY)/api:$(or $(TAG),local)-migrate

# One-time seed images for the first terraform apply of an env root
# (the Cloud Run service/job need SOME image to exist; CI owns tags after).
bootstrap-image:
	@test -n "$(REGISTRY)" || { echo "usage: make bootstrap-image REGISTRY=us-central1-docker.pkg.dev/<project>/flagship"; exit 1; }
	$(MAKE) docker-push REGISTRY=$(REGISTRY) TAG=bootstrap

tf-fmt:
	terraform -chdir=infra fmt -recursive

tf-validate:
	@for d in infra/envs/staging infra/envs/production; do \
		echo "== $$d"; \
		terraform -chdir=$$d init -backend=false -input=false >/dev/null && \
		terraform -chdir=$$d validate || exit 1; \
	done

# Operator-run applies (CI validates but never applies — DECISIONS.md #6)
tf-apply:
	@test -n "$(ENV)" || { echo "usage: make tf-apply ENV=staging|production"; exit 1; }
	terraform -chdir=infra/envs/$(ENV) init -input=false
	terraform -chdir=infra/envs/$(ENV) apply
