# 把本项目推送到 GitHub
#
# 用法（在项目根目录执行）：
#   .\publish-github.ps1 -Repo 你的用户名/仓库名
#
# 例：
#   .\publish-github.ps1 -Repo zhangsan/migu-music-desktop
#
# 执行前请确认 GitHub 上已经建好同名空仓库（不要勾选 Add README / .gitignore / license）。
# 首次推送会要求登录：用户名填 GitHub 用户名，密码填 Personal Access Token（不是登录密码）。

param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if ($Repo -notmatch '^[\w.-]+/[\w.-]+$') {
    Write-Host "仓库名格式不对，应形如 用户名/仓库名" -ForegroundColor Red
    exit 1
}

Write-Host "=== 提交前检查 ===" -ForegroundColor Cyan

# 兜底：确认没有把运行数据加进来
$staged = git diff --cached --name-only
$tracked = git ls-files
$danger = @($staged + $tracked) | Where-Object { $_ -match '^\.userdata|^dist/|auth\.json|(^|/)Cookies$' } | Select-Object -Unique
if ($danger) {
    Write-Host "检测到不该提交的文件，已中止：" -ForegroundColor Red
    $danger | ForEach-Object { Write-Host "  $_" }
    exit 1
}
Write-Host "OK：没有登录数据 / 打包产物" -ForegroundColor Green

# 有没有未提交的改动
$dirty = git status --porcelain
if ($dirty) {
    Write-Host "`n有改动未提交，正在提交…" -ForegroundColor Yellow
    git add -A
    git commit -q -m "chore: 更新"
}

Write-Host "`n=== 配置远程 ===" -ForegroundColor Cyan
git remote remove origin 2>$null | Out-Null
git remote add origin "https://github.com/$Repo.git"
git remote -v

Write-Host "`n=== 推送 ===" -ForegroundColor Cyan
Write-Host "提示：若要求登录，密码处请填 Personal Access Token（需要 repo 权限）" -ForegroundColor Yellow
git push -u origin $Branch

Write-Host "`n完成：https://github.com/$Repo" -ForegroundColor Green
