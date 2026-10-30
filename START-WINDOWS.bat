@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Install Node.js 24, then run this file again.
 pause
 exit /b 1
)
if not exist .env (
 copy .env.example .env >nul
 echo Created .env. Edit DATABASE_URL with your real password, run the Supabase SQL, then restart this file.
 pause
 exit /b 1
)
if not exist node_modules\pg (
 call npm install
 if errorlevel 1 exit /b 1
)
call npm run build
if errorlevel 1 (
 pause
 exit /b 1
)
if not exist node_modules\proper-lockfile (
 call npm install
 if errorlevel 1 exit /b 1
)
call npm run db:check
if errorlevel 1 (
 pause
 exit /b 1
)
echo Data is saved in your Supabase database. Read SETUP.md for center registration and backup.
node server/index.mjs
pause
