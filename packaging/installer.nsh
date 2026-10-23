; This product supports current-user installation only, including assisted mode.
!include "${PROJECT_DIR}\.packaging\install-path-limit.nsh"
!include LogicLib.nsh

; This must be defined before assistedInstaller.nsh expands the directory page.
!define MUI_DIRECTORYPAGE_TEXT_TOP "Choose a short installation directory. The final directory must be at most ${STREAM_SYNC_MAX_INSTALL_DIR} characters to support complete installation and removal."

; The stock assisted template loads StrContains once before invoking customHeader.
!macro customHeader
!ifndef BUILD_UNINSTALLER
Function .onVerifyInstDir
  StrCpy $R7 $INSTDIR
  ${StrContains} $R8 "${APP_FILENAME}" $R7
  ${If} $R8 == ""
    StrCpy $R7 "$R7\${APP_FILENAME}"
  ${EndIf}
  StrLen $R8 $R7
  ${If} $R8 > ${STREAM_SYNC_MAX_INSTALL_DIR}
    Abort
  ${EndIf}
FunctionEnd
!endif
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  ${If} ${isForAllUsers}
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrLen $R8 $INSTDIR
  ${If} $R8 > ${STREAM_SYNC_MAX_INSTALL_DIR}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
