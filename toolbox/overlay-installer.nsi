Var newStartMenuLink
Var oldStartMenuLink
Var newDesktopLink
Var oldDesktopLink
Var oldShortcutName
Var oldMenuDirectory

!include "common.nsh"
!include "MUI2.nsh"
!include FileFunc.nsh
!include UAC.nsh

!define FOLDERID_UserProgramFiles {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}
!define KF_FLAG_CREATE 0x00008000

# allow user to define own custom
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

# current Install Mode ("all" or "CurrentUser")
Var installMode

!ifndef INSTALL_MODE_PER_ALL_USERS
  !ifndef ONE_CLICK
    Var hasPerUserInstallation
    Var hasPerMachineInstallation
  !endif
  Var PerUserInstallationFolder

  !macro setInstallModePerUser
    StrCpy $installMode CurrentUser
    SetShellVarContext current

    # сhecks registry for previous installation path
    ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perUserInstallationFolder != ""
      StrCpy $INSTDIR $perUserInstallationFolder
    ${else}
      StrCpy $0 "$LocalAppData\Programs"
      StrCpy $INSTDIR "$0\${APP_FILENAME}"
    ${endif}

    # allow /D switch to override installation path https://github.com/electron-userland/electron-builder/issues/1551
    ${StdUtils.GetParameter} $R0 "D" ""
    ${If} $R0 != ""
      StrCpy $INSTDIR $R0
    ${endif}

  !macroend
!endif

!ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
  Var perMachineInstallationFolder

  !macro setInstallModePerAllUsers
    StrCpy $installMode all
    SetShellVarContext all

    !ifdef BUILD_UNINSTALLER
      ${IfNot} ${UAC_IsAdmin}
        ShowWindow $HWNDPARENT ${SW_HIDE}
        !insertmacro UAC_RunElevated
        Quit
      ${endif}
    !endif

    # сheck registry for previous installation path
    ReadRegStr $perMachineInstallationFolder HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perMachineInstallationFolder != ""
      StrCpy $INSTDIR $perMachineInstallationFolder
    ${else}
      StrCpy $0 "$PROGRAMFILES"
      !ifdef APP_64
        ${if} ${RunningX64}
          StrCpy $0 "$PROGRAMFILES64"
        ${endif}
      !endif

      !ifdef MENU_FILENAME
        StrCpy $0 "$0\${MENU_FILENAME}"
      !endif

      StrCpy $INSTDIR "$0\${APP_FILENAME}"
    ${endif}

    # allow /D switch to override installation path https://github.com/electron-userland/electron-builder/issues/1551
    ${StdUtils.GetParameter} $R0 "D" ""
    ${If} $R0 != ""
      StrCpy $INSTDIR $R0
    ${endif}

  !macroend
!endif
!include "allowOnlyOneInstallerInstance.nsh"

!ifdef INSTALL_MODE_PER_ALL_USERS
  !ifdef BUILD_UNINSTALLER
    RequestExecutionLevel user
  !else
    RequestExecutionLevel admin
  !endif
!else
  RequestExecutionLevel user
!endif

!ifdef BUILD_UNINSTALLER
  SilentInstall silent
!else
  Var appExe
  Var launchLink
!endif

!ifdef ONE_CLICK
  !include "oneClick.nsh"
!else
  !include "assistedInstaller.nsh"
!endif

!insertmacro addLangs

!ifmacrodef customHeader
  !insertmacro customHeader
!endif

Function .onInit
  Call setInstallSectionSpaceRequired

  SetOutPath $INSTDIR
  ${LogSet} on

  !ifmacrodef preInit
    !insertmacro preInit
  !endif

  !ifdef DISPLAY_LANG_SELECTOR
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !ifdef BUILD_UNINSTALLER
    WriteUninstaller "${UNINSTALLER_OUT_FILE}"
    !insertmacro quitSuccess
  !else
    !insertmacro check64BitAndSetRegView

    !ifdef ONE_CLICK
      !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
    !else
      ${IfNot} ${UAC_IsInnerInstance}
        !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
      ${EndIf}
    !endif

    !insertmacro initMultiUser

    !ifmacrodef customInit
      !insertmacro customInit
    !endif

    !ifmacrodef addLicenseFiles
      InitPluginsDir
      !insertmacro addLicenseFiles
    !endif
  !endif
FunctionEnd

!ifndef BUILD_UNINSTALLER
  !macro copyFile FROM TO
    ${StdUtils.GetParentPath} $R5 `${TO}`
    CreateDirectory `$R5`
    ClearErrors
    CopyFiles /SILENT `${FROM}` `${TO}`
  !macroend
  !macro moveFile FROM TO
    ClearErrors
    Rename `${FROM}` `${TO}`
    ${if} ${errors}
      ClearErrors
      !insertmacro copyFile `${FROM}` `${TO}`
      Delete `${FROM}`
    ${endif}
  !macroend
  Var /GLOBAL isTryToKeepShortcuts
  !macro setIsTryToKeepShortcuts
    StrCpy $isTryToKeepShortcuts "true"
    !ifdef allowToChangeInstallationDirectory
      ${ifNot} ${isUpdated}
        StrCpy $isTryToKeepShortcuts "false"
      ${endIf}
    !endif
  !macroend
!endif

Section "install" INSTALL_SECTION_ID
  !ifndef BUILD_UNINSTALLER
    # If we're running a silent upgrade of a per-machine installation, elevate so extracting the new app will succeed.
    # For a non-silent install, the elevation will be triggered when the install mode is selected in the UI,
    # but that won't be executed when silent.
    !ifndef INSTALL_MODE_PER_ALL_USERS
      !ifndef ONE_CLICK
          ${if} $hasPerMachineInstallation == "1" # set in onInit by initMultiUser
          ${andIf} ${Silent}
            ${ifNot} ${UAC_IsAdmin}
              ShowWindow $HWNDPARENT ${SW_HIDE}
              !insertmacro UAC_RunElevated
              ${Switch} $0
                ${Case} 0
                  ${Break}
                ${Case} 1223 ;user aborted
                  ${Break}
                ${Default}
                  MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "Unable to elevate, error $0"
                  ${Break}
              ${EndSwitch}
              Quit
            ${else}
              !insertmacro setInstallModePerAllUsers
            ${endIf}
          ${endIf}
      !endif
    !endif
# functions (nsis macro) for installer

!include "extractAppPackage.nsh"

!ifdef APP_PACKAGE_URL
  !include webPackage.nsh
!endif

!macro installApplicationFiles
  !ifdef APP_BUILD_DIR
    File /r "${APP_BUILD_DIR}\*.*"
  !else
    !ifdef APP_PACKAGE_URL
      Var /GLOBAL packageFile
      Var /GLOBAL isPackageFileExplicitlySpecified

      ${StdUtils.GetParameter} $packageFile "package-file" ""
      ${if} $packageFile == ""
        !ifdef APP_64_NAME
          !ifdef APP_32_NAME
            !ifdef APP_ARM64_NAME
              ${if} ${IsNativeARM64}
                StrCpy $packageFile "${APP_ARM64_NAME}"
                StrCpy $1 "${APP_ARM64_HASH}"
              ${elseif} ${IsNativeAMD64}
                StrCpy $packageFile "${APP_64_NAME}"
                StrCpy $1 "${APP_64_HASH}"
              ${else}
                StrCpy $packageFile "${APP_32_NAME}"
                StrCpy $1 "${APP_32_HASH}"
              ${endif}
            !else
              ${if} ${RunningX64}
                StrCpy $packageFile "${APP_64_NAME}"
                StrCpy $1 "${APP_64_HASH}"
              ${else}
                StrCpy $packageFile "${APP_32_NAME}"
                StrCpy $1 "${APP_32_HASH}"
              ${endif}
            !endif
          !else
            StrCpy $packageFile "${APP_64_NAME}"
            StrCpy $1 "${APP_64_HASH}"
          !endif
        !else
          StrCpy $packageFile "${APP_32_NAME}"
          StrCpy $1 "${APP_32_HASH}"
        !endif
        StrCpy $4 "$packageFile"
        StrCpy $packageFile "$EXEDIR/$packageFile"
        StrCpy $isPackageFileExplicitlySpecified "false"
      ${else}
        StrCpy $isPackageFileExplicitlySpecified "true"
      ${endIf}

      # we do not check file hash is specifed explicitly using --package-file because it is clear that user definitely want to use this file and it is user responsibility to check
      # 1. auto-updater uses --package-file and validates checksum
      # 2. user can user another package file (use case - one installer suitable for any app version (use latest version))
      ${if} ${FileExists} "$packageFile"
        ${if} $isPackageFileExplicitlySpecified == "true"
          Goto fun_extract
        ${else}
          ${StdUtils.HashFile} $3 "SHA2-512" "$packageFile"
          ${if} $3 == $1
            Goto fun_extract
          ${else}
            MessageBox MB_OK "Package file $4 found locally, but checksum doesn't match — expected $1, actual $3.$\r$\nLocal file is ignored and package will be downloaded from Internet."
          ${endIf}
        ${endIf}
      ${endIf}

      !insertmacro downloadApplicationFiles

      fun_extract:
        !insertmacro extractUsing7za "$packageFile"

        # electron always uses per user app data
        ${if} $installMode == "all"
          SetShellVarContext current
        ${endif}

        !insertmacro moveFile "$packageFile" "$LOCALAPPDATA\${APP_PACKAGE_STORE_FILE}"

        ${if} $installMode == "all"
          SetShellVarContext all
        ${endif}
    !else
      !insertmacro extractEmbeddedAppPackage
      # electron always uses per user app data
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    !endif
  !endif

  WriteUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro registryAddInstallInfo
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts "true"
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName "${SHORTCUT_NAME}"
  !ifdef MENU_FILENAME
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" MenuDirectory "${MENU_FILENAME}"
  !endif

  ${if} $installMode == "all"
    StrCpy $0 "/allusers"
    StrCpy $1 ""
  ${else}
    StrCpy $0 "/currentuser"
    StrCpy $1 ""
  ${endIf}

  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName "${UNINSTALL_DISPLAY_NAME}$1"
  # https://github.com/electron-userland/electron-builder/issues/750
  StrCpy $2 "$INSTDIR\${UNINSTALL_FILENAME}"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$2" $0'
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$2" $0 /S'

  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion" "${VERSION}"
  !ifdef UNINSTALLER_ICON
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$INSTDIR\uninstallerIcon.ico"
  !else
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$appExe,0"
  !endif

  !ifdef COMPANY_NAME
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "Publisher" "${COMPANY_NAME}"
  !endif

  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" NoModify 1
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" NoRepair 1

  # allow user to define ESTIMATED_SIZE to avoid GetSize call
  !ifdef ESTIMATED_SIZE
    IntFmt $0 "0x%08X" ${ESTIMATED_SIZE}
  !else
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
  !endif

  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "EstimatedSize" "$0"
!macroend

!macro cleanupOldMenuDirectory
  ${if} $oldMenuDirectory != ""
    !ifdef MENU_FILENAME
      ${if} $oldMenuDirectory != "${MENU_FILENAME}"
        RMDir "$SMPROGRAMS\$oldMenuDirectory"
      ${endIf}
    !else
      RMDir "$SMPROGRAMS\$oldMenuDirectory"
    !endif
  ${endIf}
!macroend

!macro createMenuDirectory
  !ifdef MENU_FILENAME
    CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
    ClearErrors
  !endif
!macroend

!macro addStartMenuLink keepShortcuts
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    # The keepShortcuts mechanism is NOT enabled.
    # Menu shortcut will be recreated.
    ${if} $keepShortcuts  == "false"
      !insertmacro cleanupOldMenuDirectory
      !insertmacro createMenuDirectory

      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      # clear error (if shortcut already exists)
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    # The keepShortcuts mechanism IS enabled.
    # The menu shortcut could either not exist (it shouldn't be recreated) or exist in an obsolete location.
    ${elseif} $oldStartMenuLink != $newStartMenuLink
    ${andIf} ${FileExists} "$oldStartMenuLink"
      !insertmacro createMenuDirectory

      Rename $oldStartMenuLink $newStartMenuLink
      WinShell::UninstShortcut "$oldStartMenuLink"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"

      !insertmacro cleanupOldMenuDirectory
    ${endIf}
  !endif
!macroend

!macro addDesktopLink keepShortcuts
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    # https://github.com/electron-userland/electron-builder/pull/1432
    ${ifNot} ${isNoDesktopShortcut}
      # The keepShortcuts mechanism is NOT enabled.
      # Shortcuts will be recreated.
      ${if} $keepShortcuts == "false"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      # The keepShortcuts mechanism IS enabled.
      # The desktop shortcut could exist in an obsolete location (due to name change).
      ${elseif} $oldDesktopLink != $newDesktopLink
      ${andIf} ${FileExists} "$oldDesktopLink"
        Rename $oldDesktopLink $newDesktopLink
        WinShell::UninstShortcut "$oldDesktopLink"
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"

      !ifdef RECREATE_DESKTOP_SHORTCUT
      ${elseif} $oldDesktopLink != $newDesktopLink
      ${orIfNot} ${FileExists} "$oldDesktopLink"
        ${ifNot} ${isUpdated}
          CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
          ClearErrors
          WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
        ${endIf}
      !endif
      ${endIf}
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endIf}
  !endif
!macroend


InitPluginsDir

${IfNot} ${Silent}
  SetDetailsPrint none
${endif}

StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

# must be called before uninstallOldVersion
!insertmacro setLinkVars

!ifdef ONE_CLICK
  !ifdef HEADER_ICO
    File /oname=$PLUGINSDIR\installerHeaderico.ico "${HEADER_ICO}"
  !endif
  ${IfNot} ${Silent}
    !ifdef HEADER_ICO
      SpiderBanner::Show /MODERN /ICON "$PLUGINSDIR\installerHeaderico.ico"
    !else
      SpiderBanner::Show /MODERN
    !endif

    FindWindow $0 "#32770" "" $hwndparent
    FindWindow $0 "#32770" "" $hwndparent $0
    GetDlgItem $0 $0 1000
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(installing)"

    StrCpy $1 $hwndparent
		System::Call 'user32::ShutdownBlockReasonCreate(${SYSTYPE_PTR}r1, w "$(installing)")'
  ${endif}
  !insertmacro CHECK_APP_RUNNING
!else
  ${ifNot} ${UAC_IsInnerInstance}
    !insertmacro CHECK_APP_RUNNING
  ${endif}
!endif

Var /GLOBAL keepShortcuts
StrCpy $keepShortcuts "false"
!insertMacro setIsTryToKeepShortcuts
${if} $isTryToKeepShortcuts == "true"
  ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts

  ${if} $R1 == "true"
  ${andIf} ${FileExists} "$appExe"
    StrCpy $keepShortcuts "true"
  ${endIf}
${endif}

# 升级时直接覆盖轻匣自身文件，保留安装目录内其他文件。

SetOutPath $INSTDIR

!ifdef UNINSTALLER_ICON
  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
!endif

!insertmacro installApplicationFiles
!insertmacro registryAddInstallInfo
!insertmacro addStartMenuLink $keepShortcuts
!insertmacro addDesktopLink $keepShortcuts

${if} ${FileExists} "$newStartMenuLink"
  StrCpy $launchLink "$newStartMenuLink"
${else}
  StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
${endIf}

!ifmacrodef registerFileAssociations
  !insertmacro registerFileAssociations
!endif

!ifmacrodef customInstall
  !insertmacro customInstall
!endif

!macro doStartApp
  # otherwise app window will be in background
  HideWindow
  !insertmacro StartApp
!macroend

!ifdef ONE_CLICK
  # https://github.com/electron-userland/electron-builder/pull/3093#issuecomment-403734568
  !ifdef RUN_AFTER_FINISH
    ${ifNot} ${Silent}
    ${orIf} ${isForceRun}
      !insertmacro doStartApp
    ${endIf}
  !else
    ${if} ${isForceRun}
      !insertmacro doStartApp
    ${endIf}
  !endif
  !insertmacro quitSuccess
!else
  # for assisted installer run only if silent, because assisted installer has run after finish option
  ${if} ${isForceRun}
  ${andIf} ${Silent}
    !insertmacro doStartApp
  ${endIf}
!endif

  !endif
SectionEnd

Function setInstallSectionSpaceRequired
  !insertmacro setSpaceRequired ${INSTALL_SECTION_ID}
FunctionEnd

Var QingxiaPurge
!macro customUnInit
  StrCpy $QingxiaPurge "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/PURGE" $R1
  ${IfNot} ${Errors}
    StrCpy $QingxiaPurge "1"
  ${ElseIfNot} ${Silent}
    HideWindow
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-ui' $R0
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "无法打开卸载页面，请重新安装轻匣后再卸载。"
      Abort
    ${EndIf}
    ${If} $R0 == 2
      StrCpy $QingxiaPurge "1"
    ${ElseIf} $R0 != 0
      Abort
    ${EndIf}
    ShowWindow $HWNDPARENT ${SW_SHOW}
  ${EndIf}
!macroend

!macro customRemoveFiles
  InitPluginsDir
  System::Call 'kernel32::SetEnvironmentVariableW(w "QINGXIA_INSTALL", w "$INSTDIR")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "QINGXIA_EXE", w "${APP_EXECUTABLE_FILENAME}")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "QINGXIA_PURGE", w "$QingxiaPurge")'
  FileOpen $R0 "$PLUGINSDIR\qingxia-cleanup.ps1" w
  FileWrite $R0 `$$ErrorActionPreference = 'Stop'$\r$\n`
  FileWrite $R0 `$$install = [IO.Path]::GetFullPath($$env:QINGXIA_INSTALL).TrimEnd('\')$\r$\n`
  FileWrite $R0 `$$data = Join-Path $$env:APPDATA 'qingxia'$\r$\n`
  FileWrite $R0 `$$legacy = Join-Path $$env:APPDATA ([string]::Concat([char[]]@(0x4e2a,0x4eba,0x5de5,0x5177,0x7bb1)))$\r$\n`
  FileWrite $R0 `if (-not (Test-Path -LiteralPath $$data) -and (Test-Path -LiteralPath $$legacy)) { $$data = $$legacy }$\r$\n`
  FileWrite $R0 `$$config = Join-Path $$data 'toolbox.json'$\r$\n`
  FileWrite $R0 `$$protected = @()$\r$\n`
  FileWrite $R0 `$$settings = $$null$\r$\n`
  FileWrite $R0 `if (Test-Path -LiteralPath $$config) {$\r$\n`
  FileWrite $R0 `  $$settings = Get-Content -LiteralPath $$config -Raw -Encoding UTF8 | ConvertFrom-Json$\r$\n`
  FileWrite $R0 `  $$base = if ($$settings.pluginFolder) { [IO.Path]::GetFullPath($$settings.pluginFolder).TrimEnd('\') } else { Join-Path $$data 'plugins' }$\r$\n`
  FileWrite $R0 `  foreach ($$plugin in @($$settings.plugins)) {$\r$\n`
  FileWrite $R0 `    if (-not $$plugin) { continue }$\r$\n`
  FileWrite $R0 `    $$item = [IO.Path]::GetFullPath([string]$$plugin).TrimEnd('\')$\r$\n`
  FileWrite $R0 `    if ([IO.Path]::GetDirectoryName($$item) -ne $$base -or [IO.Path]::GetFileName($$item) -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$$') { throw 'Invalid plugin path' }$\r$\n`
  FileWrite $R0 `    $$protected += $$item$\r$\n`
  FileWrite $R0 `  }$\r$\n`
  FileWrite $R0 `  if ($$base -ne $$install) { $$protected += $$base }$\r$\n`
  FileWrite $R0 `}$\r$\n`
  FileWrite $R0 `function Remove-OwnedDirectory([string]$$target, [string]$$parent) {$\r$\n`
  FileWrite $R0 `  $$target = [IO.Path]::GetFullPath($$target).TrimEnd('\')$\r$\n`
  FileWrite $R0 `  $$parent = [IO.Path]::GetFullPath($$parent).TrimEnd('\')$\r$\n`
  FileWrite $R0 `  if ([IO.Path]::GetDirectoryName($$target) -ne $$parent) { throw 'Invalid directory' }$\r$\n`
  FileWrite $R0 `  if (-not (Test-Path -LiteralPath $$target)) { return }$\r$\n`
  FileWrite $R0 `  $$current = Get-Item -LiteralPath $$target -Force$\r$\n`
  FileWrite $R0 `  while ($$current) {$\r$\n`
  FileWrite $R0 `    if (($$current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked directory' }$\r$\n`
  FileWrite $R0 `    $$current = $$current.Parent$\r$\n`
  FileWrite $R0 `  }$\r$\n`
  FileWrite $R0 `  Remove-Item -LiteralPath $$target -Recurse -Force$\r$\n`
  FileWrite $R0 `}$\r$\n`
  FileWrite $R0 `if ($$env:QINGXIA_PURGE -eq '1') {$\r$\n`
  FileWrite $R0 `  foreach ($$item in @($$settings.plugins)) {$\r$\n`
  FileWrite $R0 `    if ($$item) { Remove-OwnedDirectory ([string]$$item) $$base }$\r$\n`
  FileWrite $R0 `  }$\r$\n`
  FileWrite $R0 `  Remove-OwnedDirectory $$data $$env:APPDATA$\r$\n`
  FileWrite $R0 `  $$protected = @()$\r$\n`
  FileWrite $R0 `}$\r$\n`
  FileWrite $R0 `$$files = @($$env:QINGXIA_EXE,'chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','ffmpeg.dll','icudtl.dat','libEGL.dll','libGLESv2.dll','LICENSE.electron.txt','LICENSES.chromium.html','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','vk_swiftshader_icd.json','vk_swiftshader.dll','vulkan-1.dll')$\r$\n`
  FileWrite $R0 `foreach ($$name in $$files) {$\r$\n`
  FileWrite $R0 `  $$item = Join-Path $$install $$name$\r$\n`
  FileWrite $R0 `  if (Test-Path -LiteralPath $$item -PathType Leaf) { Remove-Item -LiteralPath $$item -Force }$\r$\n`
  FileWrite $R0 `}$\r$\n`
  FileWrite $R0 `foreach ($$name in @('resources','locales')) {$\r$\n`
  FileWrite $R0 `  $$item = Join-Path $$install $$name$\r$\n`
  FileWrite $R0 `  $$blocked = @($$protected | Where-Object { $$_ -eq $$item -or $$_.StartsWith($$item + '\',[StringComparison]::OrdinalIgnoreCase) }).Count -gt 0$\r$\n`
  FileWrite $R0 `  if (-not $$blocked) { Remove-OwnedDirectory $$item $$install }$\r$\n`
  FileWrite $R0 `}$\r$\n`
  FileClose $R0
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\qingxia-cleanup.ps1"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint "卸载未完成：有文件正在使用或无法访问。"
    MessageBox MB_ICONSTOP "卸载没有完成，部分插件或配置可能已经删除。$\r$\n$\r$\n请先退出轻匣和正在运行的插件，关闭可能正在使用插件文件的程序，然后重新启动卸载。"
    Abort
  ${EndIf}
  ${If} $QingxiaPurge == "1"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${APP_FILENAME}"
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend

UninstPage instfiles
!define BUILD_UNINSTALLER
!macro customCheckAppRunning
  qingxia_check_running:
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    ${If} ${Silent}
      SetErrorLevel 1
      Abort
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "轻匣还在运行，暂时无法卸载。$\r$\n$\r$\n请在任务栏右下角找到轻匣图标，右键选择“退出”，然后点击“重试”。$\r$\n$\r$\n如果暂时不卸载，请点击“取消”。" IDRETRY qingxia_check_running
    Abort
  ${EndIf}
!macroend
!include "uninstaller.nsh"
!undef BUILD_UNINSTALLER
