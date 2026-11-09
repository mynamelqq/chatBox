@echo off
setlocal
cd /d "%~dp0" || goto :failed

rem Use an existing Python installation when it already has the app dependencies.
python -c "import fastapi, httpx, dotenv, uvicorn" >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_EXE=python"
    goto :start
)

if not exist ".venv\Scripts\python.exe" (
    python -m venv .venv || goto :failed
)
if not exist ".venv\.chatbox-installed" (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :failed
    type nul > ".venv\.chatbox-installed"
)
set "PYTHON_EXE=.venv\Scripts\python.exe"

:start
if not exist ".env" copy ".env.example" ".env" >nul
"%PYTHON_EXE%" -m uvicorn server:app --host 127.0.0.1 --port 8000
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo Startup failed. Please keep this window open and send the error above.
pause
exit /b 1
