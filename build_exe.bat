@echo off
echo ===========================================
echo   Building Proxy Attendance Desktop App
echo ===========================================

echo.
echo [1/3] Building the React Frontend...
call npm run build
if %errorlevel% neq 0 (
    echo "NPM Build Failed. Please check your errors."
    pause
    exit /b %errorlevel%
)

echo.
echo [2/3] Installing Python Dependencies...
pip install pywebview pyinstaller
if %errorlevel% neq 0 (
    echo "Failed to install Python dependencies. Ensure Python is installed."
    pause
    exit /b %errorlevel%
)

echo.
echo [3/3] Compiling Desktop EXE...
python -m PyInstaller --name "ProxyAttendance" --add-data "dist;dist" --windowed --noconfirm desktop.py
if %errorlevel% neq 0 (
    echo "PyInstaller Failed."
    pause
    exit /b %errorlevel%
)

echo.
echo ===========================================
echo   SUCCESS! 
echo   Your desktop application is ready at:
echo   dist\ProxyAttendance\ProxyAttendance.exe
echo ===========================================
pause
