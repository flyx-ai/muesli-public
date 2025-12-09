#!/bin/sh

# Kill any process using port 9000 (Electron Forge webpack dev server)
if command -v lsof > /dev/null 2>&1; then
  PID=$(lsof -ti :9000 2>/dev/null)
  if [ ! -z "$PID" ]; then
    echo "Killing process $PID on port 9000..."
    kill $PID 2>/dev/null || true
    sleep 1
  fi
elif command -v fuser > /dev/null 2>&1; then
  fuser -k 9000/tcp 2>/dev/null || true
fi

npm start
