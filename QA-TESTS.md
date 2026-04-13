# MyBot — QA Test Guide

How to run end-to-end tests for the setup page, API endpoints, security
validations, and data persistence. All tests use `curl` against the running
container on `localhost:3400`.

## Prerequisites

```bash
# Container must be running and healthy
docker compose ps claude-api  # should show "healthy"

# Get INTERNAL_API_TOKEN from .env (without reading the full file)
# Used by the helper function below
```

## Helper: Get a CSRF token for a test user

Every test session needs a setup token and CSRF token. This helper
fetches both in one shot:

```bash
# Set these once per test session:
TEST_USER="test-qa-user"
API_TOKEN=$(grep '^INTERNAL_API_TOKEN=' .env | cut -d= -f2-)

# Get setup token
SETUP_TOKEN=$(curl -s -X POST http://localhost:3400/internal/setup-token \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $API_TOKEN" \
  -d "{\"userId\":\"$TEST_USER\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# Load setup page (consumes setup token, issues CSRF token)
CSRF=$(curl -s "http://localhost:3400/setup/$TEST_USER?t=$SETUP_TOKEN" \
  | grep -oP "const CSRF='\K[^']+")

echo "CSRF: $CSRF"  # Should be a 32-char hex string
```

---

## 1. Health Check

```bash
curl -s http://localhost:3400/health
# Expected: {"status":"ok"}
```

## 2. Setup Page Renders

```bash
curl -s "http://localhost:3400/setup/$TEST_USER?t=$SETUP_TOKEN" | head -5
# Expected: <!DOCTYPE html> with Profile Setup title
```

## 3. Tags — CRUD

### Add a tag (should pass)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"49ers\",\"category\":\"Favorite Sports Team\",\"_csrf\":\"$CSRF\"}"
# Expected: {"ok":true,"tag":{"label":"49ers","category":"Favorite Sports Team","addedAt":"..."}}
```

### Add duplicate tag (should fail)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"49ers\",\"category\":\"Favorite Sports Team\",\"_csrf\":\"$CSRF\"}"
# Expected: {"error":"duplicate or limit reached"}
```

### Tag too long (should fail — max 100 chars)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"$(python3 -c 'print("A"*150)')\",\"category\":\"Test\",\"_csrf\":\"$CSRF\"}"
# Expected: {"error":"Tag must be under 100 characters"}
```

### Remove a tag
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/remove-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"49ers\",\"_csrf\":\"$CSRF\"}"
# Expected: {"ok":true,"removed":1}
```

## 4. Jobs — CRUD

### Create a job (should pass)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Morning Briefing\",\"prompt\":\"Give me the latest news\",\"frequency\":\"daily at 9am\",\"_csrf\":\"$CSRF\"}"
# Expected: {"ok":true,"job":{"id":...,"cronRule":"0 9 * * *","type":"dm-task",...}}
# Save the job ID for later tests
```

### Toggle job off
```bash
JOB_ID=<id from above>
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs/$JOB_ID/toggle" \
  -H "Content-Type: application/json" \
  -d "{\"_csrf\":\"$CSRF\"}"
# Expected: {"ok":true,"active":false}
```

### Toggle job back on
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs/$JOB_ID/toggle" \
  -H "Content-Type: application/json" \
  -d "{\"_csrf\":\"$CSRF\"}"
# Expected: {"ok":true,"active":true}
```

### Edit a job
```bash
curl -s -X PUT "http://localhost:3400/setup/$TEST_USER/jobs/$JOB_ID" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Updated Briefing\",\"prompt\":\"New prompt\",\"frequency\":\"weekdays at 8am\",\"_csrf\":\"$CSRF\"}"
# Expected: {"ok":true,"job":{"cronRule":"0 8 * * 1-5",...}}
```

### Delete a job
```bash
curl -s -X DELETE "http://localhost:3400/setup/$TEST_USER/jobs/$JOB_ID" \
  -H "Content-Type: application/json" \
  -d "{\"_csrf\":\"$CSRF\"}"
# Expected: {"ok":true}
```

## 5. Security Validations

### Frequency too fast — every 1 minute (should fail)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Bad\",\"prompt\":\"Hi\",\"frequency\":\"every 1 minute\",\"_csrf\":\"$CSRF\"}"
# Expected: {"error":"Schedule must be at least every 5 minutes"}
```

### Raw cron too fast — * * * * * (should fail)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Bad\",\"prompt\":\"Hi\",\"frequency\":\"* * * * *\",\"_csrf\":\"$CSRF\"}"
# Expected: {"error":"Schedule must be at least every 5 minutes"}
```

### Job prompt too long — over 2000 chars (should fail)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Bad\",\"prompt\":\"$(python3 -c 'print("X"*2100)')\",\"frequency\":\"daily at 9am\",\"_csrf\":\"$CSRF\"}"
# Expected: {"error":"Job prompt must be under 2000 characters"}
```

### Invalid CSRF token (should fail)
```bash
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"test\",\"category\":\"Test\",\"_csrf\":\"invalid-token\"}"
# Expected: {"error":"invalid csrf"}
```

### Max 10 jobs per user
```bash
# Create 10 jobs, then try an 11th
for i in $(seq 1 10); do
  curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"Job $i\",\"prompt\":\"Task $i\",\"frequency\":\"daily at ${i}am\",\"_csrf\":\"$CSRF\"}" > /dev/null
done
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Job 11\",\"prompt\":\"Over limit\",\"frequency\":\"daily at 11am\",\"_csrf\":\"$CSRF\"}"
# Expected: {"error":"Maximum 10 scheduled jobs per user"}
```

## 6. Data Persistence Across Rebuild

```bash
# 1. Create test data
curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"PersistTest\",\"category\":\"QA\",\"_csrf\":\"$CSRF\"}"

# 2. Verify it exists
docker exec mybot-claude-api-1 node -e \
  "const p=require('./user-profiles').getProfile('$TEST_USER'); console.log('Tags:', p?.tags?.length||0)"
# Expected: Tags: 1

# 3. Force rebuild
docker compose up -d --build claude-api
sleep 10

# 4. Verify data survived
docker exec mybot-claude-api-1 node -e \
  "const p=require('./user-profiles').getProfile('$TEST_USER'); console.log('Tags after rebuild:', p?.tags?.length||0)"
# Expected: Tags after rebuild: 1
```

## 7. Complete User Deletion

Tests that `deleteUser()` removes profile + tokens + schedules:

```bash
docker exec mybot-claude-api-1 node -e "
  const up = require('./user-profiles');
  const ss = require('./schedules-storage');
  // Verify data exists
  console.log('Profile exists:', !!up.getProfile('$TEST_USER'));
  console.log('Schedules:', ss.getUserSchedules('$TEST_USER').length);
  // Delete
  up.deleteUser('$TEST_USER');
  // Verify gone
  console.log('Profile after delete:', up.getProfile('$TEST_USER'));
  console.log('Schedules after delete:', ss.getUserSchedules('$TEST_USER').length);
"
# Expected:
# Profile exists: true
# Schedules: <some number>
# Profile after delete: null
# Schedules after delete: 0
```

## 8. Container Logs — Cron Registration

After creating a job, check the container logs for cron registration:

```bash
docker compose logs claude-api --tail 20 | grep "Schedule #"
# Expected: Schedule #<id>: "<job name>" → <cron rule>
```

## 9. Setup Page Pre-fill

For a user who already has a profile, the setup page should show their
existing data pre-filled in the form fields:

```bash
# Set up a profile first
docker exec mybot-claude-api-1 node -e "
  require('./user-profiles').setProfile('prefill-test', {
    name: 'TestUser', location: 'NYC', timezone: 'America/New_York'
  });
"

# Get a fresh setup token and load the page
PREFILL_TOKEN=$(curl -s -X POST http://localhost:3400/internal/setup-token \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $API_TOKEN" \
  -d '{"userId":"prefill-test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s "http://localhost:3400/setup/prefill-test?t=$PREFILL_TOKEN" | grep -o 'value="[^"]*"'
# Expected: should include value="TestUser" and value="NYC"

# Clean up
docker exec mybot-claude-api-1 node -e "require('./user-profiles').deleteUser('prefill-test')"
```

---

## Running All Tests (automated)

For a future agent to run all tests at once:

```bash
cd "/mnt/c/Users/karen/Desktop/Github Projects/MyBot"

# 1. Get tokens
API_TOKEN=$(grep '^INTERNAL_API_TOKEN=' .env | cut -d= -f2-)
TEST_USER="qa-auto-$(date +%s)"
SETUP_TOKEN=$(curl -s -X POST http://localhost:3400/internal/setup-token \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $API_TOKEN" \
  -d "{\"userId\":\"$TEST_USER\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
CSRF=$(curl -s "http://localhost:3400/setup/$TEST_USER?t=$SETUP_TOKEN" \
  | grep -oP "const CSRF='\K[^']+")

PASS=0; FAIL=0

# 2. Health
[ "$(curl -s http://localhost:3400/health)" = '{"status":"ok"}' ] && ((PASS++)) || ((FAIL++))

# 3. Add tag
R=$(curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"QATag\",\"category\":\"Test\",\"_csrf\":\"$CSRF\"}")
echo "$R" | grep -q '"ok":true' && ((PASS++)) || ((FAIL++))

# 4. Long tag rejected
R=$(curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d "{\"label\":\"$(python3 -c 'print("X"*150)')\",\"category\":\"T\",\"_csrf\":\"$CSRF\"}")
echo "$R" | grep -q 'under 100' && ((PASS++)) || ((FAIL++))

# 5. Create job
R=$(curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"QA Job\",\"prompt\":\"Test\",\"frequency\":\"daily at 9am\",\"_csrf\":\"$CSRF\"}")
echo "$R" | grep -q '"ok":true' && ((PASS++)) || ((FAIL++))

# 6. Fast cron rejected
R=$(curl -s -X POST "http://localhost:3400/setup/$TEST_USER/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Bad\",\"prompt\":\"X\",\"frequency\":\"every 1 minute\",\"_csrf\":\"$CSRF\"}")
echo "$R" | grep -q 'at least every 5' && ((PASS++)) || ((FAIL++))

# 7. Invalid CSRF rejected
R=$(curl -s -X POST "http://localhost:3400/setup/$TEST_USER/add-tag" \
  -H "Content-Type: application/json" \
  -d '{"label":"x","category":"x","_csrf":"bad"}')
echo "$R" | grep -q 'invalid csrf' && ((PASS++)) || ((FAIL++))

# 8. Delete cleans everything
docker exec mybot-claude-api-1 node -e "
  const up=require('./user-profiles'), ss=require('./schedules-storage');
  up.deleteUser('$TEST_USER');
  const gone=!up.getProfile('$TEST_USER') && ss.getUserSchedules('$TEST_USER').length===0;
  process.exit(gone?0:1);
" && ((PASS++)) || ((FAIL++))

echo ""
echo "=== QA Results: $PASS passed, $FAIL failed ==="
[ $FAIL -eq 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
```

Expected output: `=== QA Results: 7 passed, 0 failed ===`
