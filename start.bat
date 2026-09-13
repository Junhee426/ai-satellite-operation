@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe py -3.12 -m venv .venv
if errorlevel 1 goto error
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto error
echo Open http://localhost:8000 in your browser.
.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
goto end
:error
echo Setup failed. Install Python 3.12 and check your internet connection.
pause
:end
