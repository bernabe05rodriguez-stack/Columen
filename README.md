# Columen — Landing Legal & Notarial

Single-page HTML, servida por nginx. Deploy en EasyPanel (`redhawk/columen`).

## Deploy
```bash
git add . && git commit -m "..." && git push
# trigger manual:
curl -s -X POST "https://panel.redhawk.digital/api/trpc/services.app.deployService" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"json":{"projectName":"redhawk","serviceName":"columen"}}'
```
