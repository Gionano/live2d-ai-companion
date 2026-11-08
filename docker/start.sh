#!/usr/bin/env bash
set -euo pipefail

cd /app
mkdir -p /app/local/container /app/data /app/assets/references
# Keep the selected model with settings while leaving backend code in the image.
if [[ ! -f /app/local/container/activeModel.json ]]; then
  cp /app/server/activeModel.json /app/local/container/activeModel.json
fi
ln -sf /app/local/container/activeModel.json /app/server/activeModel.json

pids=()
shutdown() {
  trap - TERM INT EXIT
  if (( ${#pids[@]} )); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap shutdown TERM INT EXIT

PORT=8787 node server/index.js &
pids+=("$!")
PORT=3001 MAIN_COMPANION_WS_URL=ws://127.0.0.1:8787/ws node vision-monitor/server/server.js &
pids+=("$!")
nginx -c /app/docker/nginx.conf -g 'daemon off;' &
pids+=("$!")

# If any service exits, stop the others so Compose can restart the whole app.
set +e
wait -n "${pids[@]}"
status=$?
set -e
if (( status == 0 )); then status=1; fi
exit "$status"
