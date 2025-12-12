#!/usr/bin/env bash
# MOVT Backend - Requests (curl)
# Usage:
#   export BASE_URL=http://localhost:3000
#   export TOKEN=your_session_id_here
#   ./movt_requests.sh

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN="${TOKEN:-ea76e4f6-6cab-4e86-ac77-27400e81d588}"
JQ=${JQ:-jq}

echo "Base URL: $BASE_URL"

echo "\n1) GET /api/trainers (list)"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/trainers?limit=20&offset=0" | $JQ

echo "\n2) GET /api/trainers/:id (detail)"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/trainers/15" | $JQ

echo "\n3) GET /api/trainers/:id/posts"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/trainers/15/posts?limit=10&offset=0" | $JQ

echo "\n4) PUT /api/user/update-field (update username)"
curl -s -X PUT "$BASE_URL/api/user/update-field" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field":"username","value":"TiagoNewUsername"}' | $JQ

echo "\n5) PUT /api/user/update-field (update email)"
curl -s -X PUT "$BASE_URL/api/user/update-field" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field":"email","value":"novoemail@example.com"}' | $JQ

echo "\n6) POST /api/trainers/:id/follow"
curl -s -X POST "$BASE_URL/api/trainers/15/follow" -H "Authorization: Bearer $TOKEN" | $JQ

echo "\n7) DELETE /api/trainers/:id/follow"
curl -s -X DELETE "$BASE_URL/api/trainers/15/follow" -H "Authorization: Bearer $TOKEN" | $JQ

echo "\n8) POST /api/uploads/sign (presigned placeholder)"
curl -s -X POST "$BASE_URL/api/uploads/sign" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"cover.jpg","contentType":"image/jpeg","purpose":"trainer-cover"}' | $JQ

echo "\n9) PUT /api/trainers/:id/avatar (multipart/form-data). Replace /path/to/avatar.jpg with your file"
# Use this command for uploads (curl handles multipart). Update file path before running.
# curl -X PUT "$BASE_URL/api/trainers/15/avatar" -H "Authorization: Bearer $TOKEN" -F "avatar=@/path/to/avatar.jpg"

echo "\n10) GET /api/search?q=..."
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/search?q=Tiago&limit=10" | $JQ

echo "\nDone. Replace TOKEN and BASE_URL as needed. Use jq to pretty-print responses (install separately)."
