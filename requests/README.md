MOVT-BACKEND - Request examples for Frontend/QA

Files:
- movt_requests.sh        - Bash/curl examples (recommended for uploads)
- movt_requests.ps1       - PowerShell examples (JSON requests). For file uploads use curl or Thunder Client.

How to use
1) Set variables (optional):
   - Bash:
     export BASE_URL=http://localhost:3000
     export TOKEN=ea76e4f6-6cab-4e86-ac77-27400e81d588
     ./movt_requests.sh

   - PowerShell:
     $env:BASE_URL = 'http://localhost:3000'
     $env:TOKEN = 'ea76e4f6-6cab-4e86-ac77-27400e81d588'
     .\movt_requests.ps1

Notes
- Replace the example `TOKEN` with the real `session_id` for the user you want to test.
- For multipart uploads use the curl command in `movt_requests.sh` or use Thunder Client/Postman to attach files.
- Endpoints that may depend on DB tables (e.g., `trainer_posts`, `follows`, `notifications`) will return empty results or 501 if those tables are not present.
- The scripts use `jq` (bash) or `ConvertTo-Json` (PowerShell) to pretty print responses. Install `jq` if you want pretty output in bash.

Common endpoints covered
- GET /api/trainers
- GET /api/trainers/:id
- GET /api/trainers/:id/posts
- PUT /api/user/update-field
- PUT /api/trainers/:id/avatar (curl multipart example)
- POST /api/trainers/:id/follow
- POST /api/uploads/sign

If you want, I can also:
- Export these requests as a Thunder Client collection JSON for direct import.
- Generate a Postman collection or an OpenAPI (YAML) file.
