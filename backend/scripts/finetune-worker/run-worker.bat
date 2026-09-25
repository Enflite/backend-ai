@echo off
REM Minimal native-Windows launcher for the reference fine-tune worker (ADR-015).
REM Edit the variables below, then double-click or run from a terminal.
REM For GPU training on Windows, WSL2 + CUDA is recommended (see README.md).

set MONGO_URI=mongodb+srv://<user>:<password>@<cluster>/<dbname>
set API_BASE=https://ai.yourcompany.internal
set API_KEY=<worker-api-key>
set WORKER_ID=%COMPUTERNAME%-gpu

py -m pip install --quiet pymongo requests
py "%~dp0worker.py" --mongo-uri "%MONGO_URI%" --api-base "%API_BASE%" --api-key "%API_KEY%" --worker-id "%WORKER_ID%"
