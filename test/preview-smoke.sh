#!/usr/bin/env bash
# Real Linux Docker/storage/firewall test. Only on an isolated test host:
# uses the preview network and firewall chain, and needs passwordless sudo.
# Commands passed to the container must be expanded there, not on the host.
# shellcheck disable=SC2016
set -euo pipefail
root=$(mktemp -d)
export PR=1 APP_IMAGE=${APP_IMAGE:-ai-activity:ci} PREVIEW_DOMAIN=preview.test
export GITHUB_CLIENT_ID=ci GITHUB_CLIENT_SECRET=ci ALLOWED_GITHUB_LOGINS=octocat
export PREVIEW_DATA_ROOT=$root/data PREVIEW_UID PREVIEW_GID
PREVIEW_UID=$(id -u)
PREVIEW_GID=$(id -g)
preview=(docker compose -f deploy/compose.preview.yaml)
cleanup() {
  "${preview[@]}" down --volumes --remove-orphans || true
  docker rm -f preview-peer preview-host > /dev/null 2>&1 || true
  docker network rm ai-activity-preview > /dev/null 2>&1 || true
  for chain in INPUT DOCKER-USER; do
    sudo iptables -w 10 -D "$chain" -i ai-preview -j AI-PREVIEW || true
  done
  sudo iptables -w 10 -F AI-PREVIEW || true
  sudo iptables -w 10 -X AI-PREVIEW || true
  sudo umount "$root/data" || true
  rm -rf "$root"
}
trap cleanup EXIT
# Never attach to an existing preview network on a shared host.
if docker network inspect ai-activity-preview > /dev/null 2>&1; then
  trap - EXIT
  rm -rf "$root"
  echo 'Use an isolated host: ai-activity-preview already exists' >&2
  exit 1
fi
mkdir "$root/data"
fallocate -l 128M "$root/data.img"
mkfs.ext4 -q -E nodiscard -m 0 "$root/data.img"
sudo mount -o loop,nodev,nosuid,noexec "$root/data.img" "$root/data"
sudo chown "$PREVIEW_UID:$PREVIEW_GID" "$root/data"
mkdir "$root/data/pr-1"
docker network create ai-activity-preview --subnet 172.29.95.0/24 --ip-range 172.29.95.128/25 --opt com.docker.network.bridge.name=ai-preview
sudo bash deploy/ai-activity-preview-firewall
# The policy can be reapplied without removing existing protections.
sudo bash deploy/ai-activity-preview-firewall
"${preview[@]}" up -d --wait --wait-timeout 120
"${preview[@]}" logs app | grep -q 'Only these GitHub accounts can sign in: octocat'
"${preview[@]}" exec -T app node scripts/backup.ts | grep -q 'integrity ok'
# Persist measured data across a container replacement.
"${preview[@]}" exec -T app sh -c 'echo measured > /data/marker'
"${preview[@]}" up -d --force-recreate --wait --wait-timeout 120
"${preview[@]}" exec -T app sh -c 'test "$(cat /data/marker)" = measured'
# A stand-in Caddy can reach the preview and receive its reply. It also
# serves HTTP, to prove reverse connections from the preview are blocked.
docker run -d --name preview-peer --network ai-activity-preview --ip 172.29.95.2 --entrypoint node "$APP_IMAGE" \
  -e "require('http').createServer((q,s)=>s.end('peer')).listen(3000,'0.0.0.0')"
docker exec preview-peer node -e "fetch('http://pr-1:3000/api/auth/status').then(r=>r.json()).then(s=>process.exit(s.setup_required?1:0))"
docker exec preview-peer node -e "fetch('http://localhost:3000').then(r=>{if(!r.ok)process.exit(1)})"
# A real host service: the denial cannot pass merely because no port listens.
docker run -d --name preview-host --network host --entrypoint node "$APP_IMAGE" \
  -e "require('http').createServer((q,s)=>s.end('host')).listen(38987,'0.0.0.0')"
docker exec preview-host node -e "fetch('http://172.29.95.1:38987').then(r=>{if(!r.ok)process.exit(1)})"
# Public HTTPS (OAuth) remains reachable; host gateway, peer and metadata fail.
"${preview[@]}" exec -T app node --input-type=module -e '
  const publicResponse = await fetch("https://api.github.com");
  if (!publicResponse.ok) throw new Error("public HTTPS unavailable");
  for (const url of ["http://preview-peer:3000", "http://172.29.95.1:38987", "http://169.254.169.254/latest/meta-data/"]) {
    try { await fetch(url, {signal: AbortSignal.timeout(2000)}); }
    catch { continue; }
    throw new Error(`preview reached ${url}`);
  }
'
# Prove the metadata request hit the reject rule, even on a runner without
# a metadata service. A timeout by itself would not prove the firewall works.
sudo iptables -w 10 -nvxL AI-PREVIEW | awk '$9 == "169.254.0.0/16" && $1 > 0 {hit=1} END {exit !hit}'
"${preview[@]}" exec -T app sh -c 'test "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6)" = 1'
# Exhaust the bounded filesystem. The host filesystem has already reserved
# these blocks, so its free space must not drop by the amount written.
before=$(df -Pk "$root" | awk 'NR==2 {print $4}')
"${preview[@]}" exec -T app node --input-type=module -e '
  import fs from "node:fs";
  const fd = fs.openSync("/data/fill", "w");
  try { for (let i=0; i<256; i++) fs.writeSync(fd, Buffer.alloc(1024*1024, 1)); throw new Error("unbounded storage"); }
  catch (e) { if (e.code !== "ENOSPC") throw e; }
  finally { fs.closeSync(fd); fs.unlinkSync("/data/fill"); }
'
after=$(df -Pk "$root" | awk 'NR==2 {print $4}')
((before - after < 65536)) || { echo 'preview writes grew the host filesystem' >&2; exit 1; }
"${preview[@]}" exec -T app node scripts/backup.ts | grep -q 'integrity ok'
echo 'Preview smoke passed: persistent bounded data, Caddy access, public HTTPS, blocked private egress.'
