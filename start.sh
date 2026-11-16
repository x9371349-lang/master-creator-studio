#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "=========================================="
echo "  🚀 启动独立版【文案工作台】"
echo "  🌐 访问地址: http://127.0.0.1:8788"
echo "=========================================="

# Check if uv is available
if command -v /Users/duandongyi/.local/bin/uv >/dev/null 2>&1; then
    UV_BIN="/Users/duandongyi/.local/bin/uv"
elif command -v uv >/dev/null 2>&1; then
    UV_BIN="uv"
else
    echo "未检测到 uv，尝试使用系统 python3..."
    UV_BIN=""
fi

# Automatically open browser after 1 second
(sleep 1.2 && open "http://127.0.0.1:8788") &

if [ -n "$UV_BIN" ]; then
    "$UV_BIN" run --with fastapi --with uvicorn --with httpx --with pydantic python server.py
else
    python3 server.py
fi
