@echo off
echo Starting LogBridge...

:: Start backend
start "LogBridge API" cmd /k "cd backend && npm start"

:: Wait 2 seconds for backend to init
timeout /t 2 /nobreak > nul

:: Start frontend
start "LogBridge UI" cmd /k "cd frontend && npm run dev"

echo.
echo LogBridge is starting:
echo   API:  http://localhost:4000
echo   UI:   http://localhost:5173
echo.
echo Default login: admin / admin123
