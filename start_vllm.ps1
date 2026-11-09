param(
  [string]$ModelPath = 'F:\AAA model\Qwen3___5-9B',
  [int]$Port = 8001
)

Write-Host "Starting vLLM for $ModelPath on http://127.0.0.1:$Port/v1 ..."
vllm serve `
  --model $ModelPath `
  --served-model-name Qwen3___5-9B `
  --host 127.0.0.1 `
  --port $Port `
  --trust-remote-code
