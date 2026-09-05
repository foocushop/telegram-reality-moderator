@echo off
chcp 65001 > nul
echo ========================================================
echo   LANCEMENT DU BOT TELEGRAM MODERATEUR TELE-REALITE
echo ========================================================
echo.

if not exist node_modules (
    echo [INFO] Premier lancement detecte. Installation des dependances...
    call npm.cmd install
    if errorlevel 1 (
        echo [ERREUR] L'installation des dependances a echoue. Verifiez votre connexion.
        pause
        exit /b 1
    )
)

echo [INFO] Demarrage du bot...
node src/bot.js
if errorlevel 1 (
    echo.
    echo [ERREUR] Le bot s'est arrete avec une erreur.
    echo Verifiez vos cles dans le fichier .env !
    pause
)
