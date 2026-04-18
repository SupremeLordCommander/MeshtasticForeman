; Custom NSIS hooks for Meshtastic Foreman

!macro customInit
  ; Force-kill the app before install/upgrade
  nsExec::ExecToLog 'taskkill /F /IM "Meshtastic Foreman.exe"'
  Sleep 1000

  IfFileExists "$INSTDIR\Meshtastic Foreman.exe" 0 skipClean
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "An existing installation was detected at:$\r$\n$INSTDIR$\r$\n$\r$\nWould you like to remove it first? (Recommended for upgrades)$\r$\n$\r$\nThis only removes program files. Your database and settings are preserved." \
      IDNO skipClean
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\swiftshader"
    Delete "$INSTDIR\Meshtastic Foreman.exe"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\LICENSE*"
    Delete "$INSTDIR\LICENSES*"
    Delete "$INSTDIR\chrome_*"
    Delete "$INSTDIR\vk_swiftshader*"
    Delete "$INSTDIR\vulkan*"
    Sleep 500
  skipClean:
!macroend

!macro customUnInit
  ; Force-kill the app before uninstall
  nsExec::ExecToLog 'taskkill /F /IM "Meshtastic Foreman.exe"'
  Sleep 1000
!macroend
