# MOVT Backend - Requests (PowerShell)
# Usage:
#   $baseUrl = 'http://localhost:3000'
#   $token = 'ea76e4f6-6cab-4e86-ac77-27400e81d588'
#   Then run the commands below in PowerShell (Windows PowerShell 5.1 or PowerShell 7+).

$baseUrl = $env:BASE_URL -or 'http://localhost:3000'
$token = $env:TOKEN -or 'ea76e4f6-6cab-4e86-ac77-27400e81d588'
$headers = @{ Authorization = "Bearer $token" }

Write-Host "Base URL: $baseUrl"

Write-Host "`n1) GET /api/trainers"
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/trainers?limit=20&offset=0" -Headers $headers | ConvertTo-Json -Depth 5

Write-Host "`n2) GET /api/trainers/15"
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/trainers/15" -Headers $headers | ConvertTo-Json -Depth 5

Write-Host "`n3) GET /api/trainers/15/posts"
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/trainers/15/posts?limit=10&offset=0" -Headers $headers | ConvertTo-Json -Depth 5

Write-Host "`n4) PUT /api/user/update-field (username)"
$body = @{ field = 'username'; value = 'TiagoNewUsername' } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "$baseUrl/api/user/update-field" -Headers $headers -Body $body -ContentType 'application/json' | ConvertTo-Json -Depth 5

Write-Host "`n5) PUT /api/user/update-field (email)"
$body = @{ field = 'email'; value = 'novoemail@example.com' } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "$baseUrl/api/user/update-field" -Headers $headers -Body $body -ContentType 'application/json' | ConvertTo-Json -Depth 5

Write-Host "`n6) POST /api/trainers/15/follow"
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/trainers/15/follow" -Headers $headers | ConvertTo-Json -Depth 5

Write-Host "`n7) DELETE /api/trainers/15/follow"
Invoke-RestMethod -Method Delete -Uri "$baseUrl/api/trainers/15/follow" -Headers $headers | ConvertTo-Json -Depth 5

Write-Host "`n8) POST /api/uploads/sign"
$body = @{ filename = 'cover.jpg'; contentType = 'image/jpeg'; purpose = 'trainer-cover' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/uploads/sign" -Headers $headers -Body $body -ContentType 'application/json' | ConvertTo-Json -Depth 5

Write-Host "`nNote: For file uploads (multipart/form-data) prefer using curl or Thunder Client/Postman.\nIn PowerShell 7+ you can use Invoke-RestMethod with -Form, but in 5.1 it's more complex. Example (curl):"
Write-Host "curl -X PUT \"$baseUrl/api/trainers/15/avatar\" -H \"Authorization: Bearer $token\" -F \"avatar=@C:\path\to\avatar.jpg\""

Write-Host "`nDone. Replace $baseUrl and $token as needed."
