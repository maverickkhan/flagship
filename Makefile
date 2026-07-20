.PHONY: up down logs migrate seed demo test test-integration lint build docker-build docker-push tf-fmt tf-validate

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
	npm run test:integration

lint:
	npm run lint && npm run format:check && npm run typecheck

build:
	npm run build

docker-build:
	docker build --target runtime -t flagship-api:local .
	docker build --target migrate -t flagship-migrate:local .

tf-fmt:
	terraform -chdir=infra fmt -recursive

tf-validate:
	@for d in infra/envs/staging infra/envs/production; do \
		echo "== $$d"; \
		terraform -chdir=$$d init -backend=false -input=false >/dev/null && \
		terraform -chdir=$$d validate || exit 1; \
	done
