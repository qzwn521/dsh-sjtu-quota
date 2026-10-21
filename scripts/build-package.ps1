$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'pack.mjs')
if ($LASTEXITCODE -ne 0) { throw '插件打包失败' }
