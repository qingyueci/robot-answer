@echo off
setlocal
set "HOME_ROBOT_EXE=%LOCALAPPDATA%\home_robot\Home Robot.exe"

if exist "%HOME_ROBOT_EXE%" (
  start "" "%HOME_ROBOT_EXE%" %*
  exit /b 0
)

set "HOME_ROBOT_EXE=%~dp0apps\desktop\out\Home Robot-win32-x64\Home Robot.exe"

if not exist "%HOME_ROBOT_EXE%" (
  echo Home Robot is not installed and the local package is missing.
  echo Install: artifacts\desktop-visual-20260820\release\Home-Robot-Setup.exe
  echo Or build: npm run desktop:package
  pause
  exit /b 1
)

start "" "%HOME_ROBOT_EXE%" %*
exit /b 0
