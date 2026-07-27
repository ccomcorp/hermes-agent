@echo off
setlocal EnableExtensions

rem Stage-then-swap helper for a running unpacked Hermes Desktop build.
rem Start this while Hermes is open. It waits for every Hermes.exe process to
rem exit, replaces only release\win-unpacked from release-next2, then relaunches.

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "STAGED=%ROOT%\apps\desktop\release-next2\win-unpacked"
set "LIVE=%ROOT%\apps\desktop\release\win-unpacked"

if not exist "%STAGED%\Hermes.exe" (
  echo Staged build not found: "%STAGED%\Hermes.exe"
  echo Wait for the desktop staging build to complete, then run this file again.
  exit /b 1
)

echo Staged Hermes build is ready.
echo Close Hermes Desktop when ready; this window will swap the bundle and relaunch it.

:wait_for_desktop_exit
tasklist /FI "IMAGENAME eq Hermes.exe" /NH | find /I "Hermes.exe" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait_for_desktop_exit
)

if exist "%LIVE%" rmdir /s /q "%LIVE%"
if exist "%LIVE%" (
  echo Unable to remove the previous Desktop bundle: "%LIVE%"
  exit /b 1
)

move "%STAGED%" "%LIVE%" >nul
if errorlevel 1 (
  echo Unable to promote staged Desktop bundle.
  exit /b 1
)

start "" "%LIVE%\Hermes.exe"
