# Docker deployment

Build the static release bundle:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-release.ps1
```

Extract `dist/shiyi-deploy.tar.gz` on the target host. Place the web files in a release directory, point `current` to it, then start the isolated Nginx container:

```bash
export SHIYI_PORT=8080
mkdir -p releases/manual
cp -r web/. releases/manual/
ln -sfn releases/manual current
docker compose up -d
curl -I http://127.0.0.1:${SHIYI_PORT}/
```

`SHIYI_PORT` defaults to `8080`. The container serves static files only. Application data, the optional DeepSeek API key, and AI usage records remain in each visitor's browser IndexedDB.

When placing this service behind an existing reverse proxy, add a new upstream or location without replacing unrelated virtual hosts. Back up the current configuration before reloading the proxy.

The GitHub Actions deployment uses the same `current` symlink, keeps the five newest releases, verifies the public endpoint, and rolls back when the container health check fails.
