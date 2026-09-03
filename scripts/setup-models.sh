#!/usr/bin/env bash
# Pull recommended Ollama models for Integrity IDE
set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
MODELS=(
	"qwen2.5-coder:14b"
	"qwen2.5-coder:7b"
	"nomic-embed-text"
)

echo "Integrity: checking Ollama at ${OLLAMA_HOST}..."
if ! curl -sf "${OLLAMA_HOST}/api/tags" > /dev/null; then
	echo "Error: Ollama is not running. Install from https://ollama.com"
	exit 1
fi

for model in "${MODELS[@]}"; do
	echo "Pulling ${model}..."
	curl -sf "${OLLAMA_HOST}/api/pull" -d "{\"name\":\"${model}\"}" > /dev/null &
done

wait
echo "Integrity: all model pulls started. Monitor with: ollama list"
