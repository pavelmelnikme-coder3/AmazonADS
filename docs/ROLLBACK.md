# Rollback Guide

This document describes how to safely roll back AdsFlow to a previous version.

---

## Quick Reference

```bash
# See all versions
git log --oneline

# Roll back to a specific commit (safe preview)
git checkout <commit-sha>

# Permanent rollback (creates new commit)
git revert HEAD
```

---

## Step-by-Step Rollback

### 1. Identify the target version

```bash
cd ~/Downloads/adsflow
git log --oneline
```

Output example:
```
1831cf2 fix: add all .env variants to gitignore   ← current
acae0d1 feat: add i18n support (RU/EN)
8088bdc feat: AdsFlow MVP initial commit           ← stable baseline
```

### 2. Stop running containers

```bash
docker compose down
```

### 3. Roll back code

**Option A — Temporary rollback (inspect only, doesn't change history):**
```bash
git checkout <commit-sha>
```
To return to latest: `git checkout main`

**Option B — Permanent rollback (recommended, safe for team):**
```bash
# Revert last commit
git revert HEAD

# Or revert to a specific commit (reverts all commits after it)
git revert HEAD~3..HEAD   # revert last 3 commits

git push origin main
```

**Option C — Hard reset (DANGEROUS — rewrites history, use only on solo branch):**
```bash
git reset --hard <commit-sha>
git push origin main --force   # ⚠️ warns team first
```

### 4. Handle database migrations

Each version may include DB migrations. Check which need reverting:

| Migration file | Version | Revert needed? |
|---------------|---------|----------------|
| `001_initial.sql` | 0.1.0 | Only on full reset |
| `003_rules_alerts.sql` | 0.3.0 | Only if rolling back to < 0.3.0 |

**To revert migration 003:**
```bash
# Connect to DB
docker compose exec postgres psql -U adsflow -d adsflow

-- Remove Stage 2 additions (safe, additive columns/indexes only)
ALTER TABLE rules DROP COLUMN IF EXISTS schedule_type;
ALTER TABLE alert_configs DROP COLUMN IF EXISTS last_triggered_at;
DROP INDEX IF EXISTS idx_rules_workspace_active;
DROP INDEX IF EXISTS idx_alert_configs_workspace_active;
DROP INDEX IF EXISTS idx_keywords_state;
\q
```

### 5. Rebuild and restart

```bash
docker compose up --build -d

# Verify all containers are healthy
docker compose ps

# Check backend logs
docker compose logs backend --tail=50
```

### 6. Verify rollback

```bash
curl http://localhost:4000/health
# Expected: {"status":"ok","version":"1.0.0"}
```

---

## Environment Variables After Rollback

If `.env` settings changed between versions, restore from `.env.example`:

```bash
cp .env.example .env
# Edit .env with your actual credentials
```

---

## Emergency: Full Reset

Use only if rollback fails and you need a clean slate:

```bash
# Stop everything
docker compose down -v   # -v removes volumes (⚠️ deletes DB data)

# Reset to initial commit
git reset --hard 8088bdc

# Rebuild from scratch
docker compose up --build -d
```

---

## Creating a Release Tag (before risky changes)

Always tag before starting major work:

```bash
git tag -a v0.3.0 -m "Stage 2: Rules, Alerts, Keywords, Bulk actions"
git push origin v0.3.0
```

To list all tags: `git tag -l`  
To rollback to a tag: `git checkout v0.2.0`

---

## Who to Contact

| Issue | Contact |
|-------|---------|
| DB corruption | DB admin (Owner role) |
| API keys compromised | Revoke at developer.amazon.com immediately |
| Frontend issues | Frontend developer |
| Infrastructure | DevOps / Owner |
