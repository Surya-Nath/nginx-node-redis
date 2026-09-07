# nginx-node-redis

Multi-tier visit-counter lab: two Node.js/Express workers behind Nginx, shared Redis state, split frontend/backend networks, then the same stack shipped through ECR, GitHub Actions, Jenkins, Terraform, and Ansible.

Local path builds images from source. Production path pulls pre-built `week1-web` and `week1-nginx` images from Amazon ECR and runs them on a single Ubuntu EC2 instance.

```
                    :80
                     │
                  ┌──▼──┐
                  │nginx│   frontend network only
                  └──┬──┘
           ┌─────────┴─────────┐
           │                   │
        ┌──▼──┐             ┌──▼──┐
        │web1 │             │web2 │   hostname identifies which replica served you
        └──┬──┘             └──┬──┘
           │  backend          │
           └─────────┬─────────┘
                  ┌──▼──┐
                  │redis│   not published to the host
                  └─────┘
```

A request hits Nginx on port 80. Nginx round-robins `web1:5000` and `web2:5000`. Each worker increments the Redis key `numVisits` and replies:

```text
web1: Number of visits is: 3
```

Same counter, different hostname. That is the whole demo: load balancing plus shared state.

---

## What is in this repo

| Path | Role |
|---|---|
| `web/` | Express app, multi-stage Node 22 Alpine image, non-root user |
| `nginx/` | Reverse proxy image + `upstream loadbalancer` |
| `compose.yaml` | Local: build from source, publish 80 / 81 / 82 |
| `compose.prod.yaml` | Prod: pull ECR images, publish only 80 |
| `.github/workflows/build-push.yml` | On push to `main`, build + push both images to ECR |
| `Jenkinsfile` | Same build + push from Jenkins using credential `aws-ecr` |
| `terraform/` | Default-VPC Ubuntu 22.04 EC2 + SG (22 from lab CIDR, 80 from the world) |
| `ansible-lab/` | Install Docker on the instance, drop prod compose, ECR login, `compose up` |

The original README only described the four-service Compose sample. CI, IaC, and config management landed later and are now first-class.

---

## Architecture details

### Application (`web/server.js`)

- Express listens on `0.0.0.0:5000`.
- Redis client (`redis@3.1.2`, callback API) connects to `process.env.REDIS_HOST` or hostname `redis`, port `6379`.
- `retry_strategy` reconnects every 1000 ms.
- `GET /` reads `numVisits`, increments, writes back, returns `os.hostname() + ': Number of visits is: ' + n`.
- Redis errors return HTTP `503` with body `redis down`.
- `hostname:` in Compose is what you see in the response (`web1` / `web2`).

Dependencies are pinned in `web/package.json`. `web/.npmrc` and `web/.yarnrc.yml` disable lifecycle scripts. The image runs `npm ci --omit=dev --ignore-scripts` (falls back to `npm install`) in a deps stage, then copies `node_modules` + `server.js` into a second `node:22-alpine` stage, creates user `app`, and drops root.

### Proxy (`nginx/nginx.conf`)

```nginx
upstream loadbalancer {
  server web1:5000;
  server web2:5000;
}

server {
  listen 80;
  location / { proxy_pass http://loadbalancer; }
}
```

Default Nginx round-robin. No sticky sessions. Image is `nginx:1.27-alpine` with this file copied to `/etc/nginx/conf.d/default.conf`.

### Networks

| Network | Members | Why |
|---|---|---|
| `frontend` | nginx, web1, web2 | Proxy can reach workers. Redis is not on this net. |
| `backend` | redis, web1, web2 | Workers can reach Redis. Nginx cannot. |

Redis is **not** published to the host in either compose file. Local debugging of a single worker still works through `localhost:81` and `localhost:82`.

### Healthchecks

- Redis: `redis-cli ping` every 5s, 20 retries.
- web1 / web2: HTTP GET `127.0.0.1:5000` from inside the container. 10s interval, 10s start period.

`depends_on` is service-start only (not `condition: service_healthy`). Healthchecks still mark the containers in `docker compose ps`.

---

## Repository layout

```text
.
├── compose.yaml                          # local build + run
├── compose.prod.yaml                     # ECR images, host port 80 only
├── Jenkinsfile                           # Jenkins → ECR
├── .github/workflows/build-push.yml      # GHA → ECR
├── nginx/
│   ├── Dockerfile
│   └── nginx.conf
├── web/
│   ├── Dockerfile
│   ├── server.js
│   ├── package.json
│   ├── package-lock.json
│   ├── .dockerignore
│   ├── .npmrc
│   └── .yarnrc.yml
├── terraform/
│   ├── main.tf
│   ├── variables.tf
│   └── outputs.tf
└── ansible-lab/
    ├── inventory.ini
    ├── site.yml
    └── files/compose.prod.yaml           # copy of prod compose dropped onto the box
```

---

## Prerequisites

**Local compose**

- Docker Engine + Compose v2
- Ports `80`, `81`, `82` free on the host

**CI (GitHub Actions)**

- Repo secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- IAM user/role that can `ecr:GetAuthorizationToken` plus push to:
  - `413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-web`
  - `413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-nginx`
- Those two ECR repositories must already exist

**CI (Jenkins)**

- Jenkins agent with Docker + AWS CLI
- Username/password credential id `aws-ecr` = AWS access key / secret
- Same ECR repos as above

**AWS deploy**

- AWS creds with EC2 + default VPC read
- Key pair named `week1-ansible` (or override `key_name`)
- Ansible on a control node that can SSH to the instance as `ubuntu`
- Private key path referenced in `ansible-lab/inventory.ini`

Lab defaults live in `ap-south-1` (Mumbai). Account `413816840602` is baked into compose prod, Jenkins, GHA is account-agnostic (uses the login action’s registry), Ansible, and Terraform comments / images.

---

## Quick start — local

```bash
git clone https://github.com/Surya-Nath/nginx-node-redis.git
cd nginx-node-redis

docker compose up -d --build
docker compose ps
```

Hit the proxy:

```bash
curl -s http://localhost
# web1: Number of visits is: 1

curl -s http://localhost
# web2: Number of visits is: 2
```

Bypass Nginx and talk to one replica:

```bash
curl -s http://localhost:81
curl -s http://localhost:82
```

Stop:

```bash
docker compose down
```

Add `-v` if you also want the default anonymous Redis volume gone.

Redis is not mapped to `localhost:6379`. That was true in the original sample README and is no longer true. To inspect Redis:

```bash
docker compose exec redis redis-cli ping
docker compose exec redis redis-cli GET numVisits
```

---

## Local vs production compose

| | `compose.yaml` | `compose.prod.yaml` |
|---|---|---|
| web / nginx images | `build: ./web`, `build: ./nginx` | ECR `:latest` |
| Host ports | `80`, `81`, `82` | `80` only |
| Networks / healthchecks / env | same idea | same idea |
| Who uses it | laptop | EC2 via Ansible |

`ansible-lab/files/compose.prod.yaml` is the copy Ansible drops at `/home/ubuntu/app/compose.yaml` on the instance. Keep it in sync with the repo-root `compose.prod.yaml`.

Prod image names:

```text
413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-web:latest
413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-nginx:latest
```

CI also tags every build with the git SHA (`$GITHUB_SHA` / `$GIT_COMMIT`) and pushes that tag plus `latest`.

---

## Application environment

| Variable | Default | Where |
|---|---|---|
| `REDIS_HOST` | `redis` | set on `web1` and `web2` in both compose files |

Nothing else is parameterized in the Node process. Port is hardcoded to `5000` in `server.js` and in Nginx upstream.

---

## CI/CD

Two pipelines do the same job: build `./web` and `./nginx`, tag SHA + `latest`, push to ECR in `ap-south-1`.

### GitHub Actions — `.github/workflows/build-push.yml`

- Trigger: `push` to `main`
- Runner: `ubuntu-latest`
- Auth: `aws-actions/configure-aws-credentials@v4` + `amazon-ecr-login@v2`
- Does **not** deploy. Images only.

Required secrets on the repo:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

### Jenkins — `Jenkinsfile`

Declarative pipeline, `agent any`.

1. `Checkout`
2. `ECR login` via `withCredentials` id `aws-ecr`
3. `Build and push web`
4. `Build and push nginx`

Env inside the Jenkinsfile:

```text
AWS_REGION  = ap-south-1
AWS_ACCOUNT = 413816840602
REGISTRY    = 413816840602.dkr.ecr.ap-south-1.amazonaws.com
```

Point a Multibranch or Pipeline job at this repo. The agent must be allowed to talk to Docker.

There is no deploy stage in either pipeline. Deploy is Terraform + Ansible, run by hand (or wire it later).

---

## Infrastructure — Terraform

`terraform/` launches one public Ubuntu 22.04 (`jammy`) box in the **account default VPC**.

| Resource | Name / value |
|---|---|
| Instance | `week1-app` |
| Type | `t3.small` (var) |
| AMI | canonical `ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*` |
| Key | `week1-ansible` (var) |
| SG | `week1-web-sg` |
| Ingress 22 | `var.ssh_cidr` (default `13.233.117.22/32`) |
| Ingress 80 | `0.0.0.0/0` |
| Egress | all |
| Public IP | yes |

```bash
cd terraform
terraform init
terraform plan
terraform apply
terraform output
```

Outputs: `public_ip`, `public_dns`.

### Variables

| Name | Default | Change when |
|---|---|---|
| `aws_region` | `ap-south-1` | you are not in Mumbai |
| `key_name` | `week1-ansible` | your key pair name differs |
| `ssh_cidr` | `13.233.117.22/32` | your current public IP /32 |
| `instance_type` | `t3.small` | you want cheaper / bigger |

`ssh_cidr` is a single lab IP. If your laptop IP changes, plan + apply again or you will lock yourself out of SSH. HTTP stays open to the world on purpose.

State files and `.terraform/` are gitignored. This stack does not configure a remote backend — local state only unless you add one.

Destroy when the lab is done:

```bash
terraform destroy
```

---

## Deploy — Ansible

`ansible-lab/site.yml` targets group `app`.

What it does, in order:

1. `apt` install `docker.io`, `docker-compose-v2`, `curl`
2. Add `ubuntu` to group `docker`
3. Create `/home/ubuntu/app`
4. Copy `files/compose.prod.yaml` → `/home/ubuntu/app/compose.yaml`
5. `docker login` to ECR with extra-var `ecr_password`
6. `docker compose up -d` in `/home/ubuntu/app`

Inventory (`ansible-lab/inventory.ini`) is a single host. Replace the IP with Terraform’s `public_ip` after every new apply:

```ini
[app]
<PUBLIC_IP> ansible_user=ubuntu ansible_ssh_private_key_file=/home/ubuntu/.ssh/week1-ansible.pem
```

Run from a control node that has the key and AWS access to mint an ECR password:

```bash
PASSWORD=$(aws ecr get-login-password --region ap-south-1)

ansible-playbook -i ansible-lab/inventory.ini ansible-lab/site.yml \
  -e ecr_password="$PASSWORD"
```

First SSH after a fresh instance can race cloud-init. If the play fails on unreachable, wait and rerun.

The instance must be able to pull from ECR. That means the box needs outbound HTTPS and valid login credentials (the play handles login). It does **not** attach an instance profile in Terraform today — ECR auth is the password you pass in.

Verify:

```bash
curl -s http://<PUBLIC_IP>
curl -s http://<PUBLIC_IP>
```

You should see `web1` / `web2` alternate and the counter climb.

---

## End-to-end lab path

1. Push to `main` (or run Jenkins) so `week1-web:latest` and `week1-nginx:latest` exist in ECR.
2. `terraform apply` → note `public_ip`.
3. Put that IP in `ansible-lab/inventory.ini`. Tighten `ssh_cidr` if needed and re-apply.
4. Run the playbook with a fresh ECR password.
5. `curl` the public IP on port 80.
6. `terraform destroy` when finished.

Local `docker compose up` does not need any of that.

---

## Ports

| Where | Port | Service |
|---|---|---|
| Host (local) | 80 | Nginx |
| Host (local) | 81 | web1 directly |
| Host (local) | 82 | web2 directly |
| Host (prod) | 80 | Nginx |
| Host (prod) | 22 | SSH, lab CIDR only |
| Inside web containers | 5000 | Express |
| Inside Redis | 6379 | not published |

---

## Image build notes

Web image is multi-stage:

```dockerfile
FROM node:22-alpine AS deps
# npm ci --omit=dev --ignore-scripts
FROM node:22-alpine
# non-root user `app`, COPY server.js, EXPOSE 5000, CMD node server.js
```

Nginx image:

```dockerfile
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`.dockerignore` keeps `node_modules` and `.git` out of the web build context.

Manual build (same tags CI uses):

```bash
aws ecr get-login-password --region ap-south-1 \
  | docker login --username AWS --password-stdin 413816840602.dkr.ecr.ap-south-1.amazonaws.com

docker build -t 413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-web:latest ./web
docker build -t 413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-nginx:latest ./nginx
docker push 413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-web:latest
docker push 413816840602.dkr.ecr.ap-south-1.amazonaws.com/week1-nginx:latest
```

---

## Security notes (lab, not production-hardened)

- Redis is isolated on `backend` and not published. Good.
- Web process drops to user `app`. Good.
- npm lifecycle scripts are disabled. Good.
- SG SSH is restricted to one /32. Update it when your IP changes.
- SG HTTP is open to the world. Fine for a counter demo; do not put secrets behind it.
- ECR account ID, instance IP, and SSH CIDR are committed. Treat them as lab identifiers, not secrets. Rotate keys if this repo is public and the key pair was ever shared.
- Ansible receives the ECR password as an extra var. It will sit in process list / logs on the control node for that run.
- Terraform uses the default VPC and a public IP. No ALB, no TLS, no remote state lock, no instance profile.
- Redis image is `redislabs/redismod` (Redis modules). A plain `redis:7-alpine` would also work for this key-value counter.

Do not reuse this as a production template without TLS, a private subnet + ALB, an instance profile instead of a pasted password, remote state, and a real Redis password / network policy.

---

## Known limits

- `redis` npm client is **3.x** (callback API). It is not the current v4 promise client. That is why `createClient({ host, port, retry_strategy })` looks old — it is correct for 3.1.2.
- Counter is a single key with no lock. Two in-flight requests can lose an increment. Irrelevant for the demo.
- Nginx has no `proxy_set_header`, health check, or retry. If one worker is down, ~50% of requests fail until Compose restarts it (`restart: unless-stopped`).
- `depends_on` does not wait for healthy Redis. The Node retry loop covers the race.
- Jenkins and GHA can drift if one is edited and the other is not.
- `ansible-lab/inventory.ini` hardcodes a live IP. After `destroy` / `apply` it is stale until you edit it.
- No TLS. Curl is HTTP.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `redis down` in the browser | `docker compose ps` — is Redis healthy? `REDIS_HOST` must resolve on the backend network. |
| Always the same hostname | You are hitting `:81` or `:82` instead of `:80`. |
| Counter resets | `compose down -v` or a new Redis container. The key lives only in that container’s data. |
| GHA / Jenkins cannot push | Repo missing in ECR, or IAM lacks `ecr:PutImage` / `InitiateLayerUpload` / `BatchCheckLayerAvailability`. |
| Ansible ECR login fails | Password expired (they are short-lived). Mint a new one with `get-login-password`. |
| Ansible SSH fails | Wrong IP, key path, or `ssh_cidr` does not match your current public IP. |
| Port 80 already allocated locally | Stop the other process or change the host mapping in `compose.yaml`. |

---

## License

The Node package is MIT (`web/package.json`). The rest of the repo has no root LICENSE file.
