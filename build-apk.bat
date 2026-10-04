@echo off
REM Builds 300 Recipes into an APK and copies it here as 300Recipes.apk.
REM Optional: only for building on your own PC (see "Option B" in SETUP-GUIDE.md).
cd /d "%~dp0"

if not defined JAVA_HOME (
  if exist "C:\Program Files\Android\Android Studio\jbr" set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
)
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"

REM Sign with the project key so local and cloud builds can update each other
if not exist "%USERPROFILE%\.android" mkdir "%USERPROFILE%\.android"
copy /Y "signing\debug.keystore" "%USERPROFILE%\.android\debug.keystore" >nul

echo Copying the latest app files into the Android project...
call npx cap sync android || goto :fail

REM Native alarm (plays on the phone's alarm volume)
copy /Y "native\android\*.java" "android\app\src\main\java\com\personal\threehundredrecipes\" >nul

echo Building the APK (the first time takes several minutes)...
pushd android
call gradlew.bat assembleDebug || (popd & goto :fail)
popd

copy /Y "android\app\build\outputs\apk\debug\app-debug.apk" "300Recipes.apk" >nul || goto :fail
echo.
echo Done! 300Recipes.apk is in this folder. Copy it to your phone and open it to install.
pause
exit /b 0

:fail
echo.
echo Something went wrong. Scroll up for the error, or open the project in
echo Android Studio instead (npx cap open android) and use Build ^> Build APK(s).
pause
exit /b 1
