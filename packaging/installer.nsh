; This product supports current-user installation only, including assisted mode.
!include "${PROJECT_DIR}\.packaging\install-path-limit.nsh"
!include LogicLib.nsh

; This must be defined before assistedInstaller.nsh expands the directory page.
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择一个较短的安装目录。最终目录不能超过 ${STREAM_SYNC_MAX_INSTALL_DIR} 个字符，否则无法完整安装和卸载。"

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
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Fy1Sync 仅支持当前用户安装，请移除 /allusers 参数后重试。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $R7 $INSTDIR
  ${IfNot} ${Silent}
    ${StrContains} $R8 "${APP_FILENAME}" $R7
    ${If} $R8 == ""
      StrCpy $R7 "$R7\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
  StrLen $R8 $R7
  ${If} $R8 > ${STREAM_SYNC_MAX_INSTALL_DIR}
    ${If} ${Silent}
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} ${isUpdated}
      MessageBox MB_OK|MB_ICONSTOP "当前安装目录超过 ${STREAM_SYNC_MAX_INSTALL_DIR} 个字符，无法完整覆盖升级：$\r$\n$R7$\r$\n$\r$\n请直接运行安装包并选择较短的安装目录。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "默认安装目录超过 ${STREAM_SYNC_MAX_INSTALL_DIR} 个字符：$\r$\n$R7$\r$\n$\r$\n请在接下来的安装向导中选择较短的安装目录。"
  ${EndIf}
!macroend

; The Start menu shortcut is always created (createStartMenuShortcut in the builder config).
; The finish page asks whether to add a desktop shortcut, unticked by default.
!macro customFinishPage
  Function fy1CreateDesktopLink
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  FunctionEnd

  ; The finish page's stock checkbox, relabelled. MUI calls the function when the page closes
  ; with the box ticked.
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_NOTCHECKED
  !define MUI_FINISHPAGE_RUN_TEXT "创建桌面快捷方式"
  !define MUI_FINISHPAGE_RUN_FUNCTION fy1CreateDesktopLink
  !insertmacro MUI_PAGE_FINISH
!macroend

; The desktop shortcut exists only if chosen, so remove it on uninstall (not on an update,
; which keeps what the user chose).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${endIf}
!macroend
