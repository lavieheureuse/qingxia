!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include FileFunc.nsh
  Var QingxiaDirectoryInput
  Var QingxiaDirectoryChanged
  Var QingxiaDirectoryStatus

  !macro customPageAfterChangeDir
    !define allowToChangeInstallationDirectory

    Function QingxiaPrepareDirectory
      Push $2
      Push $3
      ${GetRoot} "$1" $2
      StrCpy $3 $1 1 1
      ${If} $2 == ""
        StrCpy $1 ""
      ${ElseIf} $3 == ":"
        StrCpy $3 $1 1 2
        ${If} $3 != "\"
          StrCpy $1 ""
        ${EndIf}
      ${EndIf}
      ${If} $1 != ""
        System::Call 'kernel32::GetFullPathNameW(w r1, i ${NSIS_MAX_STRLEN}, w .r3, p 0) i.r2'
        ${If} $2 == 0
        ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
          StrCpy $1 ""
        ${Else}
          StrCpy $1 $3
        ${EndIf}
      ${EndIf}
      ${If} $1 != ""
        trim_trailing_slash:
          StrLen $2 $1
          ${If} $2 > 3
            StrCpy $3 $1 1 -1
            ${If} $3 == "\"
              StrCpy $1 $1 -1
              Goto trim_trailing_slash
            ${EndIf}
          ${EndIf}
        ${GetFileName} "$1" $2
        ${If} $2 != "qingxia"
          StrCpy $3 $1 1 -1
          ${If} $3 == "\"
            StrCpy $1 "$1qingxia"
          ${Else}
            StrCpy $1 "$1\qingxia"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      Pop $3
      Pop $2
    FunctionEnd

    Function QingxiaDirectoryInputChanged
      Exch $0
      StrCpy $QingxiaDirectoryChanged 1
      ${NSD_SetText} $QingxiaDirectoryStatus ""
      Pop $0
    FunctionEnd

    Function QingxiaBrowseDirectory
      Exch $0
      Push $1
      ${NSD_GetText} $QingxiaDirectoryInput $1
      nsDialogs::SelectFolderDialog "选择安装位置" "$1"
      Pop $1
      ${If} $1 != "error"
        Call QingxiaPrepareDirectory
        ${If} $1 != ""
          ${NSD_SetText} $QingxiaDirectoryInput "$1"
        ${EndIf}
      ${EndIf}
      Pop $1
      Pop $0
    FunctionEnd

    Function QingxiaDirectoryPage
      !ifdef INSTALL_REGISTRY_KEY
        ReadRegStr $2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${StdUtils.GetParameter} $0 "D" ""
      !else
        StrCpy $2 ""
        StrCpy $0 ""
      !endif
      ${If} $2 == ""
      ${AndIf} $0 == ""
        ${GetFileName} "$INSTDIR" $3
        ${If} $3 == "${APP_FILENAME}"
          ${GetParent} "$INSTDIR" $2
          StrCpy $3 $2 1 -1
          ${If} $3 == "\"
            StrCpy $INSTDIR "$2qingxia"
          ${Else}
            StrCpy $INSTDIR "$2\qingxia"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "选择安装位置" "选择轻匣的安装文件夹。"
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0u 8u 300u 30u "选择安装位置后，轻匣会自动添加 qingxia 文件夹。框中显示的是最终安装位置。"
      Pop $0
      ${NSD_CreateLabel} 0u 48u 300u 12u "目标文件夹"
      Pop $0
      ${NSD_CreateText} 0u 64u 220u 14u "$INSTDIR"
      Pop $QingxiaDirectoryInput
      ${NSD_CreateBrowseButton} 228u 64u 65u 14u "浏览..."
      Pop $0
      ${NSD_OnClick} $0 QingxiaBrowseDirectory
      ${NSD_CreateLabel} 0u 90u 300u 24u ""
      Pop $QingxiaDirectoryStatus
      StrCpy $QingxiaDirectoryChanged 0
      ${NSD_OnChange} $QingxiaDirectoryInput QingxiaDirectoryInputChanged
      nsDialogs::Show
    FunctionEnd

    Function QingxiaDirectoryLeave
      ${NSD_GetText} $QingxiaDirectoryInput $1
      ${If} $QingxiaDirectoryChanged == 1
        StrCpy $2 $1
        Call QingxiaPrepareDirectory
        ${If} $1 != ""
        ${AndIf} $1 != $2
          ${NSD_SetText} $QingxiaDirectoryInput "$1"
          ${NSD_SetText} $QingxiaDirectoryStatus "已补全 qingxia，请确认后点击安装。"
          Abort
        ${EndIf}
      ${EndIf}
      ${If} $1 == ""
        MessageBox MB_ICONEXCLAMATION "请输入完整的安装路径，例如 D:\software。"
        Abort
      ${EndIf}
      StrCpy $INSTDIR $1
    FunctionEnd

    Page custom QingxiaDirectoryPage QingxiaDirectoryLeave
  !macroend
!endif
