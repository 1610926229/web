$ErrorActionPreference = "Stop"

$token = $env:PUSHPLUS_TOKEN

if ([string]::IsNullOrWhiteSpace($token)) {
    $token = [Environment]::GetEnvironmentVariable(
        "PUSHPLUS_TOKEN",
        "User"
    )
}

if ([string]::IsNullOrWhiteSpace($token)) {
    exit 0
}

try {
    $project = Split-Path -Leaf (Get-Location)
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    $payload = @{
        token    = $token
        title    = "Claude Code：$project 任务结束"
        content  = "Claude Code 已结束当前一轮任务，可以回来查看结果。`n时间：$time"
        template = "txt"
    } | ConvertTo-Json -Compress

    Invoke-RestMethod `
        -Uri "https://www.pushplus.plus/send" `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body $payload | Out-Null
}
catch {
    $logDir = Join-Path $HOME ".claude\hooks"

    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }

    $logFile = Join-Path $logDir "notify-complete-error.log"

    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $($_.Exception.Message)" |
        Out-File -FilePath $logFile -Append -Encoding utf8

    exit 0
}

exit 0