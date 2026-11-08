# Frihet ERP Official Postman Collection

Official [Postman](https://www.postman.com/) collection and environment for Frihet ERP API testing, automation, and CI/CD validation.

## Files
- `frihet-erp.postman_collection.json`: Collection v2.1.0 with requests, auth, and automated assertions.
- `frihet-erp.postman_environment.json`: Pre-configured environment variables (`baseUrl`, `apiKey`).

## Running with Newman CLI

```bash
# Install Newman
npm install -g newman

# Execute collection tests
newman run marketplace/postman/frihet-erp.postman_collection.json \
  -e marketplace/postman/frihet-erp.postman_environment.json \
  --env-var "apiKey=fri_live_your_key_here"
```

## Included Assertions
- Verification of HTTP 200/201 response status codes.
- Enforcement of `status: 'draft'` on all invoice creation calls.
- Schema integrity and JSON envelope assertions.
