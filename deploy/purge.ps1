<#
  pi-purge 提示词一键注入工具

  把本目录下的 提示词.txt 写入 pi-purge 的 prompt-inject.md，
  让 Pi 下一轮对话就用上。系统提示词本身仍是 Pi 内置的那份，
  这里只是替换注入进去的文字。

    purge.ps1 install     注入（自动备份原文件）
    purge.ps1 status      查看当前状态
    purge.ps1 restore     恢复注入前的原文件
    purge.ps1 list        列出所有备份
    purge.ps1 open        打开数据目录

  可选参数：
    -File <路径>          指定提示词文件（默认本目录 提示词.txt）
    -Position prepend|append   顺便设置注入位置
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string] $Action = 'install',

  [string] $File,

  [ValidateSet('prepend', 'append', '')]
  [string] $Position = ''
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── 数据目录：与 pi-purge 扩展读的是同一处 ──
$AgentDir = $env:PI_CODING_AGENT_DIR
if ([string]::IsNullOrEmpty($AgentDir)) {
  $AgentDir = Join-Path $env:USERPROFILE '.pi\agent'
}
$DataDir    = Join-Path $AgentDir 'pi-purge'
$TargetFile = Join-Path $DataDir 'prompt-inject.md'
$ConfigFile = Join-Path $DataDir 'config.json'
$BackupDir  = Join-Path $DataDir 'backup'

if ([string]::IsNullOrEmpty($File)) {
  $File = Join-Path $ScriptDir '提示词.txt'
}

function Write-Head([string] $Text) {
  Write-Host ''
  Write-Host ('=' * 60) -ForegroundColor DarkGray
  Write-Host "  $Text" -ForegroundColor Cyan
  Write-Host ('=' * 60) -ForegroundColor DarkGray
}

function Fail([string] $Text) {
  Write-Host ''
  Write-Host "  x  $Text" -ForegroundColor Red
  exit 1
}

function Get-Size([string] $Path) {
  if (Test-Path $Path) { return (Get-Item $Path).Length }
  return 0
}

# UTF-8 无 BOM —— 与 pi-purge 期望的一致，写错会变成乱码
function Write-Utf8NoBom([string] $Path, [string] $Text) {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Read-Utf8([string] $Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

# ── 前置检查 ──
if (-not (Test-Path $DataDir)) {
  Fail "pi-purge 没有安装。`n     期望的数据目录: $DataDir`n     请先安装 pi-purge 扩展。"
}

switch ($Action.ToLower()) {

  'status' {
    Write-Head 'pi-purge 当前状态'

    $injectExists = Test-Path $TargetFile
    Write-Host ("  数据目录    : {0}" -f $DataDir)
    Write-Host ("  注入文件    : {0}" -f $(if ($injectExists) { "有 ($((Get-Size $TargetFile)) 字节)" } else { '无' }))
    Write-Host ("  提示词.txt  : {0}" -f $(if (Test-Path $File) { "有 ($((Get-Size $File)) 字节)" } else { '无' }))

    if (Test-Path $ConfigFile) {
      try {
        $cfg = Read-Utf8 $ConfigFile | ConvertFrom-Json
        $posText = if ($cfg.position -eq 'prepend') { 'prepend（放在系统提示词开头）' } else { 'append（放在系统提示词末尾）' }
        Write-Host ("  注入开关    : {0}" -f $(if ($cfg.enabled) { '开' } else { '关 —— 注入了也不会生效' }))
        Write-Host ("  注入位置    : {0}" -f $posText)
        Write-Host ("  自动续跑    : {0}" -f $(if ($cfg.autoContinue) { "开（最多 $($cfg.continueMax) 次）" } else { '关' }))
        if ($null -ne $cfg.activePreset -and $cfg.activePreset -ne '') {
          Write-Host ("  当前 preset : {0}（已指定，忽略模型规则）" -f $cfg.activePreset) -ForegroundColor Yellow
        } else {
          Write-Host  "  当前 preset : auto（按模型匹配规则）"
        }
        Write-Host ("  模型规则    : {0} 条" -f @($cfg.modelPresets).Count)
      } catch {
        Write-Host "  配置读取失败：$($_.Exception.Message)" -ForegroundColor Yellow
      }
    }

    $backups = @()
    if (Test-Path $BackupDir) {
      $backups = @(Get-ChildItem $BackupDir -Filter 'prompt-inject.*.bak' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    }
    Write-Host ("  可用备份    : {0} 个" -f $backups.Count)
    if ($backups.Count -gt 0) {
      Write-Host ("    最近一次  : {0}  ({1})" -f $backups[0].Name, $backups[0].LastWriteTime.ToString('yyyy-MM-dd HH:mm')) -ForegroundColor Gray
    }
  }

  'install' {
    Write-Head 'pi-purge 提示词注入'

    if (-not (Test-Path $File)) {
      Fail "找不到提示词文件:`n     $File`n     请把提示词保存为该路径，或用 -File 指定别的文件。"
    }

    $prompt = Read-Utf8 $File
    if ([string]::IsNullOrWhiteSpace($prompt)) {
      Fail "提示词文件是空的: $File"
    }

    Write-Host ("  提示词文件  : {0} ({1} 字节)" -f $File, (Get-Size $File))
    Write-Host  "  目标文件    ：$TargetFile"

    # 备份：只在第一次注入前保存原始内容，之后每次用时间戳另存，绝不覆盖历史
    if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
    if (Test-Path $TargetFile) {
      $orig = Join-Path $BackupDir 'prompt-inject.orig.bak'
      if (-not (Test-Path $orig)) {
        Copy-Item $TargetFile $orig -Force
        Write-Host "  已保存原始备份 -> $orig" -ForegroundColor Gray
      }
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $snap = Join-Path $BackupDir "prompt-inject.$stamp.bak"
      Copy-Item $TargetFile $snap -Force
      Write-Host "  本次快照      -> $snap" -ForegroundColor Gray
    }

    # 原子写入：先写临时文件再替换，中途失败不会截断
    $tmp = "$TargetFile.tmp"
    Write-Utf8NoBom $tmp $prompt
    if (Test-Path $TargetFile) { Remove-Item $TargetFile -Force }
    Move-Item $tmp $TargetFile -Force

    Write-Host ("  写入完成    : {0} 字节" -f (Get-Size $TargetFile)) -ForegroundColor Green

    # 顺便改注入位置（可选）
    if ($Position -ne '' -and (Test-Path $ConfigFile)) {
      try {
        $cfg = Read-Utf8 $ConfigFile | ConvertFrom-Json
        $cfg.position = $Position
        Write-Utf8NoBom $ConfigFile (($cfg | ConvertTo-Json -Depth 20) + "`n")
        Write-Host "  注入位置已设为 $Position" -ForegroundColor Green
      } catch {
        Write-Host "  设置注入位置失败：$($_.Exception.Message)" -ForegroundColor Yellow
      }
    }

    Write-Host ''
    Write-Host '  下一轮对话即生效 —— 不需要 /reload，也不需要重启 Pi。' -ForegroundColor Green
    Write-Host '  想确认是否真的注入了，在 Pi 里敲：/purge preview' -ForegroundColor Gray
  }

  'restore' {
    Write-Head 'pi-purge 恢复原始提示词'

    $orig = Join-Path $BackupDir 'prompt-inject.orig.bak'
    if (-not (Test-Path $orig)) {
      Fail "没有找到原始备份:`n     $orig`n     说明这个工具还没注入过，或备份已被删除。"
    }

    $tmp = "$TargetFile.tmp"
    Copy-Item $orig $tmp -Force
    if (Test-Path $TargetFile) { Remove-Item $TargetFile -Force }
    Move-Item $tmp $TargetFile -Force

    Write-Host ("  已恢复      : {0} 字节" -f (Get-Size $TargetFile)) -ForegroundColor Green
    Write-Host ("  来源        : $orig") -ForegroundColor Gray
    Write-Host ''
    Write-Host '  下一轮对话即生效。' -ForegroundColor Green
  }

  'list' {
    Write-Head 'pi-purge 备份列表'
    if (-not (Test-Path $BackupDir)) { Write-Host '  没有备份目录。'; exit 0 }
    $items = @(Get-ChildItem $BackupDir -Filter 'prompt-inject*.bak' | Sort-Object LastWriteTime -Descending)
    if ($items.Count -eq 0) { Write-Host '  暂无备份。'; exit 0 }
    foreach ($i in $items) {
      Write-Host ("  {0,-34} {1,8} 字节  {2}" -f $i.Name, $i.Length, $i.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    }
  }

  'open' {
    if (-not (Test-Path $DataDir)) { Fail "数据目录不存在: $DataDir" }
    Write-Host "  打开: $DataDir"
    Start-Process explorer.exe $DataDir
  }

  default {
    Write-Host ''
    Write-Host '  用法: purge.ps1 <动作> [-File <路径>] [-Position prepend|append]' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    install   注入（自动备份）'
    Write-Host '    status    查看当前状态'
    Write-Host '    restore   恢复注入前的原文件'
    Write-Host '    list      列出所有备份'
    Write-Host '    open      打开数据目录'
    exit 1
  }
}

exit 0
