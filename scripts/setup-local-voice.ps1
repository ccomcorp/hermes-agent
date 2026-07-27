<#
.SYNOPSIS
  Install the dependencies for fully-LOCAL voice in Hermes.

.DESCRIPTION
  Sets up on-device voice for the canonical desktop (chassis = hermes-agent):
    * STT (listen) -> faster-whisper + sounddevice. The large-v3 weights are
      already cached under ~/.cache/huggingface, so no model download is needed
      for STT.
    * TTS (speak)  -> NeuTTS (neutts[all], runs the GGUF backbone on the GPU;
      device:cuda). Requires espeak-ng (a SYSTEM dependency) for phonemization.
      The ~300MB GGUF downloads on first use.

  The chassis venv is uv-managed (it has NO pip), so Python installs go through
  "uv pip install --python <venv-python>", never "python -m pip".

  Idempotent: re-running re-checks each piece and skips what is already present.
  espeak-ng failures are non-fatal (warns + prints manual steps) so the Python
  deps still complete.

  DEPENDENCIES ONLY. This does NOT edit config.yaml. After it runs, set
  tts.provider: neutts and stt.local.model: large-v3 in hermes-home/config.yaml
  and relaunch the desktop (or let the assistant do it).

.PARAMETER Chassis
  Path to the hermes-agent checkout (default D:\HeicH\hermes-agent).
.PARAMETER SkipEspeak
  Skip the espeak-ng system install (do it yourself / already have it).
.PARAMETER SkipStt
  Skip the faster-whisper / sounddevice (STT) install.
.PARAMETER SkipTts
  Skip the neutts[all] (TTS) install.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-local-voice.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-local-voice.ps1 -SkipEspeak
#>
[CmdletBinding()]
param(
    [string]$Chassis = 'D:\HeicH\hermes-agent',
    [switch]$SkipEspeak,
    [switch]$SkipStt,
    [switch]$SkipTts
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [err]  $m" -ForegroundColor Red }

# --- Resolve tools -----------------------------------------------------------
Write-Step "Resolving uv + chassis venv"

$venvPy = Join-Path $Chassis '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) { throw "Chassis venv python not found: $venvPy (is the -Chassis path correct?)" }
Write-Ok "venv python: $venvPy"

$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
    $cand = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (Test-Path $cand) { $uv = $cand }
}
if (-not $uv) { throw "uv not found on PATH or in ~/.local/bin. Install uv first: https://docs.astral.sh/uv/" }
Write-Ok "uv: $uv ($(& $uv --version))"

# --- STT: faster-whisper + sounddevice --------------------------------------
if (-not $SkipStt) {
    Write-Step "Installing STT deps (faster-whisper + sounddevice)"
    & $uv pip install --python $venvPy 'faster-whisper==1.2.1' 'sounddevice==0.5.5'
    if ($LASTEXITCODE -ne 0) { Write-Err2 "STT install failed (exit $LASTEXITCODE)" } else { Write-Ok "STT deps installed" }
} else { Write-Warn2 "Skipping STT deps (-SkipStt)" }

# --- TTS: NeuTTS (neutts[all]) ----------------------------------------------
if (-not $SkipTts) {
    Write-Step "Installing TTS deps (neutts[all] -- pulls torch+CUDA, large)"
    & $uv pip install --python $venvPy 'neutts[all]'
    if ($LASTEXITCODE -ne 0) { Write-Err2 "neutts install failed (exit $LASTEXITCODE)" } else { Write-Ok "neutts[all] installed" }
} else { Write-Warn2 "Skipping TTS deps (-SkipTts)" }

# --- espeak-ng (system dependency for NeuTTS phonemization) -----------------
if (-not $SkipEspeak) {
    Write-Step "Ensuring espeak-ng (system dependency for NeuTTS)"
    $espeak = Get-Command espeak-ng -ErrorAction SilentlyContinue
    if (-not $espeak) { $espeak = Get-Command espeak -ErrorAction SilentlyContinue }
    if ($espeak) {
        Write-Ok "espeak-ng already installed: $($espeak.Source)"
    } else {
        $installed = $false
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host "  trying: winget install eSpeak-NG.eSpeak-NG (will prompt for admin/UAC)"
            try {
                winget install --id eSpeak-NG.eSpeak-NG -e --accept-package-agreements --accept-source-agreements
                if ($LASTEXITCODE -eq 0) { $installed = $true; Write-Ok "espeak-ng installed via winget" }
            } catch { Write-Warn2 "winget install failed: $($_.Exception.Message)" }
        }
        if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) {
            Write-Host "  trying: choco install espeak-ng -y (needs an elevated shell)"
            try { choco install espeak-ng -y; if ($LASTEXITCODE -eq 0) { $installed = $true; Write-Ok "espeak-ng installed via choco" } }
            catch { Write-Warn2 "choco install failed: $($_.Exception.Message)" }
        }
        if (-not $installed) {
            Write-Warn2 "Could not auto-install espeak-ng. Install it manually (admin), then re-run with -SkipStt -SkipTts to re-verify:"
            Write-Host  "    winget install --id eSpeak-NG.eSpeak-NG -e" -ForegroundColor White
            Write-Host  "    (or MSI: https://github.com/espeak-ng/espeak-ng/releases)" -ForegroundColor White
        }
    }
} else { Write-Warn2 "Skipping espeak-ng (-SkipEspeak)" }

# --- Verify ------------------------------------------------------------------
Write-Step "Verifying"
& $venvPy -c @"
import importlib.util as u
for m in ('faster_whisper','sounddevice','neutts'):
    print('  %-16s: %s' % (m, 'OK' if u.find_spec(m) else 'MISSING'))
try:
    import torch
    print('  %-16s: %s  cuda=%s' % ('torch', torch.__version__, torch.cuda.is_available()))
except Exception as e:
    print('  %-16s: not importable (%s)' % ('torch', e))
"@
$espeakFinal = Get-Command espeak-ng -ErrorAction SilentlyContinue
if (-not $espeakFinal) { $espeakFinal = Get-Command espeak -ErrorAction SilentlyContinue }
if ($espeakFinal) { Write-Host "  espeak-ng       : OK ($($espeakFinal.Source))" }
else              { Write-Host "  espeak-ng       : MISSING" }

Write-Step "Next steps (NOT done by this script)"
Write-Host "  1. In hermes-home\config.yaml set:  tts.provider: neutts  AND  stt.local.model: large-v3"
Write-Host "  2. Relaunch the desktop (Editorial .bat) so the gateway picks up deps + config."
Write-Host "  3. First TTS call downloads the ~300MB NeuTTS GGUF; first STT call loads cached large-v3."
