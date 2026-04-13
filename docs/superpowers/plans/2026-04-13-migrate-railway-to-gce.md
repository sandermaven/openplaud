# Migrate OpenPlaud from Railway to GCE Free Tier

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate OpenPlaud from Railway ($214/mo estimated) to a GCE e2-micro free tier VM ($0/mo) using the existing Docker Compose setup.

**Architecture:** Spin up a free GCE e2-micro instance, install Docker, clone the repo, configure environment variables, run `docker compose up`, set up Caddy as reverse proxy with automatic HTTPS, and configure a cron job for background sync. Finally, update DNS and decommission Railway.

**Tech Stack:** GCE e2-micro, Docker Compose, Caddy, PostgreSQL 16, Let's Encrypt (via Caddy), systemd

---

### Task 1: Create GCE e2-micro Instance

**Context:** GCP Free Tier includes 1 e2-micro VM in us-east1, us-west1, or us-central1 with 30GB standard persistent disk and 1GB egress/month (beyond that $0.012/GB vs Railway's $0.09/GB).

- [ ] **Step 1: Go to GCP Console and create the VM**

Navigate to Compute Engine > VM Instances > Create Instance:
- Name: `openplaud`
- Region: `us-central1` (free tier eligible)
- Machine type: `e2-micro` (2 vCPU, 1 GB RAM)
- Boot disk: Ubuntu 24.04 LTS, 30 GB standard persistent disk
- Firewall: Allow HTTP + HTTPS traffic
- Click "Create"

- [ ] **Step 2: Note the external IP**

Copy the external IP from the VM instances list. You'll need this for DNS later.

- [ ] **Step 3: SSH into the instance**

```bash
gcloud compute ssh openplaud --zone=us-central1-a
```

Or use the "SSH" button in the GCP Console.

---

### Task 2: Install Docker on the VM

- [ ] **Step 1: Update system and install Docker**

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

- [ ] **Step 2: Add your user to the docker group**

```bash
sudo usermod -aG docker $USER
newgrp docker
```

- [ ] **Step 3: Verify Docker is working**

```bash
docker run hello-world
```

Expected: "Hello from Docker!" message.

---

### Task 3: Clone Repo and Configure Environment

- [ ] **Step 1: Clone the repository**

```bash
cd /opt
sudo mkdir openplaud && sudo chown $USER:$USER openplaud
git clone https://github.com/openplaud/openplaud.git openplaud
cd openplaud
```

- [ ] **Step 2: Create `.env` file with your Railway environment variables**

First, export your current env vars from Railway:
- Go to Railway dashboard > Open Plaude project > Variables
- Copy all variable values

Then create the `.env` file on the VM:

```bash
cat > .env << 'ENVEOF'
# Database (internal Docker network)
DATABASE_URL=postgresql://postgres:YOUR_STRONG_PASSWORD@db:5432/openplaud

# Auth
BETTER_AUTH_SECRET=<copy from Railway>
APP_URL=https://your-domain.com

# Encryption
ENCRYPTION_KEY=<copy from Railway>

# Storage
DEFAULT_STORAGE_TYPE=local

# SMTP (if configured)
SMTP_HOST=<copy from Railway>
SMTP_PORT=<copy from Railway>
SMTP_SECURE=<copy from Railway>
SMTP_USER=<copy from Railway>
SMTP_PASSWORD=<copy from Railway>
SMTP_FROM=<copy from Railway>

# Cron
CRON_SECRET=<copy from Railway>

# Notion (if configured)
NOTION_TOKEN=<copy from Railway>
NOTION_DATABASE_ID=<copy from Railway>

# Scribe (if configured)
SCRIBE_WEBHOOK_SECRET=<copy from Railway>
ENVEOF
```

- [ ] **Step 3: Update docker-compose.yml postgres password**

Edit `docker-compose.yml` and change the default postgres password to match your `.env`:

```bash
nano docker-compose.yml
```

Change `POSTGRES_PASSWORD: postgres` to your strong password.

---

### Task 4: Migrate Database from Railway

- [ ] **Step 1: Export database from Railway**

On your local machine (or the VM if you can reach Railway's DB):

```bash
pg_dump "postgresql://USER:PASS@HOST:PORT/railway" --no-owner --no-acl > railway-backup.sql
```

Get the connection string from Railway dashboard > Database service > Connect tab.

- [ ] **Step 2: Copy the backup to the VM**

```bash
gcloud compute scp railway-backup.sql openplaud:~/railway-backup.sql --zone=us-central1-a
```

- [ ] **Step 3: Start only the database container**

```bash
cd /opt/openplaud
docker compose up -d db
```

Wait for it to be healthy:

```bash
docker compose exec db pg_isready -U postgres
```

Expected: `accepting connections`

- [ ] **Step 4: Import the backup**

```bash
docker compose exec -T db psql -U postgres openplaud < ~/railway-backup.sql
```

- [ ] **Step 5: Verify the data**

```bash
docker compose exec db psql -U postgres openplaud -c "SELECT count(*) FROM recordings;"
```

Expected: your recording count.

---

### Task 5: Set Up Caddy Reverse Proxy

**Context:** Caddy provides automatic HTTPS via Let's Encrypt with zero configuration. It runs on the host, not in Docker.

- [ ] **Step 1: Install Caddy**

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install caddy
```

- [ ] **Step 2: Configure Caddy**

```bash
sudo tee /etc/caddy/Caddyfile << 'EOF'
your-domain.com {
    reverse_proxy localhost:3000

    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "no-referrer-when-downgrade"
    }

    request_body {
        max_size 100MB
    }
}
EOF
```

Replace `your-domain.com` with your actual domain.

- [ ] **Step 3: Restart Caddy**

```bash
sudo systemctl restart caddy
sudo systemctl enable caddy
```

---

### Task 6: Update DNS

- [ ] **Step 1: Point your domain to the GCE IP**

In your DNS provider, update the A record for your domain to point to the GCE external IP from Task 1.

- [ ] **Step 2: Wait for DNS propagation**

```bash
dig your-domain.com +short
```

Expected: the GCE external IP.

---

### Task 7: Start the Application

- [ ] **Step 1: Start all containers**

```bash
cd /opt/openplaud
docker compose up -d
```

- [ ] **Step 2: Check logs**

```bash
docker compose logs -f app
```

Expected: "Starting OpenPlaud..." followed by "Running database migrations..." and the app starting on port 3000.

- [ ] **Step 3: Verify the app is accessible**

```bash
curl https://your-domain.com/api/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 4: Set up auto-restart on boot**

Docker Compose services already have `restart: unless-stopped`, but ensure Docker starts on boot:

```bash
sudo systemctl enable docker
```

---

### Task 8: Set Up Cron for Background Sync

- [ ] **Step 1: Create the cron job**

```bash
crontab -e
```

Add these lines:

```cron
# Sync Plaud recordings every 15 minutes
*/15 * * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron/sync > /dev/null 2>&1

# Cleanup old recordings daily at 3 AM
0 3 * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron/cleanup > /dev/null 2>&1
```

Replace `YOUR_CRON_SECRET` with the CRON_SECRET from your `.env`.

- [ ] **Step 2: Verify cron is running**

```bash
crontab -l
```

Expected: the two cron entries.

---

### Task 9: Verify Everything Works End-to-End

- [ ] **Step 1: Log in to the app**

Open `https://your-domain.com` in your browser and log in.

- [ ] **Step 2: Trigger a manual sync**

Use the sync button in the app, or:

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-domain.com/api/cron/sync
```

Expected: JSON response with sync results.

- [ ] **Step 3: Verify a transcription works**

Select an untranscribed recording and trigger transcription. Verify it completes.

---

### Task 10: Decommission Railway

**Only do this after verifying everything works on GCE for at least 24 hours.**

- [ ] **Step 1: Stop the Railway service**

In Railway dashboard, pause or delete the "Open Plaude" service.

- [ ] **Step 2: Keep the Railway backup**

Download a final database backup from Railway before deleting:

```bash
pg_dump "postgresql://USER:PASS@HOST:PORT/railway" --no-owner --no-acl | gzip > railway-final-backup.sql.gz
```

- [ ] **Step 3: Delete the Railway project**

Once confirmed everything works, delete the project from Railway to stop billing.

---

## Cost Comparison

| | Railway | GCE Free Tier |
|---|---|---|
| Compute | ~$3/mo | $0 |
| Egress | ~$11/mo (projected ~$180/mo) | $0 (1GB free, then $0.012/GB) |
| Storage | ~$0.01/mo | $0 (30GB free) |
| Database | included | included (Docker) |
| SSL | included | $0 (Caddy/Let's Encrypt) |
| **Total** | **~$214/mo estimated** | **~$0-5/mo** |

## Risks & Mitigations

- **1 GB RAM might be tight**: Monitor with `docker stats`. If needed, add a 1GB swap file: `sudo fallocate -l 1G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
- **No managed backups**: Set up a daily cron to backup PostgreSQL to Google Cloud Storage (5GB free)
- **Single point of failure**: Acceptable for a single-user app. Keep Railway backup for disaster recovery.
