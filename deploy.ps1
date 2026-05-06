#!/usr/bin/env pwsh
# deploy.ps1 — Despliega Dashboard al servidor 179.1.87.46
#
# Uso:
#   .\deploy.ps1                        # commit automático + deploy completo
#   .\deploy.ps1 -Message "mi cambio"   # mensaje de commit personalizado
#   .\deploy.ps1 -SkipCommit            # solo despliega, sin commit/push

param(
    [string]$Message   = "",
    [switch]$SkipCommit
)

$SSH_KEY    = "C:\Users\herna\Documents\Fazes\fazes"
$SSH_HOST   = "fazes@179.1.87.46"
$REMOTE_DIR = "/home/fazes/dashboard-new"
$MODEL_LOCAL  = "$PSScriptRoot\server\cone_model.pt"
$MODEL_REMOTE = "$REMOTE_DIR/server/cone_model.pt"

function Write-Step([string]$text) {
    Write-Host "`n==> $text" -ForegroundColor Cyan
}

function Write-OK([string]$text) {
    Write-Host "  OK  $text" -ForegroundColor Green
}

function Write-Fail([string]$text) {
    Write-Host "  FAIL  $text" -ForegroundColor Red
    exit 1
}

function Invoke-SSH([string]$cmd) {
    $out = ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_HOST $cmd 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host $out
        Write-Fail "Comando SSH falló: $cmd"
    }
    return $out
}

# ── 1. Commit y push ───────────────────────────────────────────────────────────
if (-not $SkipCommit) {
    Write-Step "Verificando cambios locales..."

    $status = git status --porcelain
    if ($status) {
        Write-Host $status

        if ($Message -eq "") {
            $Message = Read-Host "`n  Mensaje de commit (Enter = 'chore: deploy update')"
            if ($Message -eq "") { $Message = "chore: deploy update" }
        }

        Write-Step "Haciendo commit y push..."
        git add -A
        if ($LASTEXITCODE -ne 0) { Write-Fail "git add falló" }

        git commit -m $Message
        if ($LASTEXITCODE -ne 0) { Write-Fail "git commit falló" }

        git push origin master
        if ($LASTEXITCODE -ne 0) { Write-Fail "git push falló" }

        Write-OK "Commit y push completados"
    } else {
        Write-OK "Sin cambios locales, omitiendo commit"
    }
}

# ── 2. Subir cone_model.pt si existe ──────────────────────────────────────────
if (Test-Path $MODEL_LOCAL) {
    Write-Step "Subiendo cone_model.pt al servidor..."
    scp -i $SSH_KEY -o StrictHostKeyChecking=no $MODEL_LOCAL "${SSH_HOST}:${MODEL_REMOTE}"
    if ($LASTEXITCODE -ne 0) { Write-Fail "scp cone_model.pt falló" }
    Write-OK "cone_model.pt subido"
} else {
    Write-Host "  --  cone_model.pt no encontrado localmente, omitiendo" -ForegroundColor Yellow
}

# ── 3. Git pull en el servidor ────────────────────────────────────────────────
Write-Step "Actualizando código en el servidor..."
$pull = Invoke-SSH "cd $REMOTE_DIR && git checkout -- . && git pull 2>&1"
Write-Host $pull
Write-OK "Git pull completado"

# ── 4. Build y reinicio de contenedores ───────────────────────────────────────
Write-Step "Construyendo imágenes Docker (puede tardar unos minutos)..."
$build = Invoke-SSH "cd $REMOTE_DIR && docker compose build 2>&1"
Write-Host $build
Write-OK "Build completado"

Write-Step "Levantando contenedores..."
$up = Invoke-SSH "cd $REMOTE_DIR && docker compose up -d 2>&1"
Write-Host $up
Write-OK "Contenedores levantados"

# ── 5. Verificación ───────────────────────────────────────────────────────────
Write-Step "Verificando salud del servidor..."
Start-Sleep -Seconds 3
$health = Invoke-SSH "curl -s http://localhost:8000/health 2>&1"
Write-Host "  $health"

if ($health -match '"status":"ok"') {
    $yolo = if ($health -match '"yolo_cones":true') { "SI" } else { "NO (cone_model.pt no cargado)" }
    Write-Host ""
    Write-Host "  Despliegue exitoso!" -ForegroundColor Green
    Write-Host "  Frontend : http://179.1.87.46" -ForegroundColor Green
    Write-Host "  Backend  : http://179.1.87.46:8000" -ForegroundColor Green
    Write-Host "  YOLO     : $yolo" -ForegroundColor Green
} else {
    Write-Fail "El servidor no respondio correctamente"
}
