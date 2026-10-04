; Reuse NSIS's native language dialog and translations without interrupting updates.
; Tauri calls this MUI macro after parsing /P and /UPDATE but does not skip it for them.
!macroundef MUI_LANGDLL_DISPLAY
!macro MUI_LANGDLL_DISPLAY
  !insertmacro MUI_LANGDLL_VARIABLES
  !insertmacro MUI_DEFAULT MUI_LANGDLL_WINDOWTITLE "Installer Language"
  !insertmacro MUI_DEFAULT MUI_LANGDLL_INFO "Please select a language."

  ; Preserve an explicit previous choice; otherwise NSIS uses the Windows language.
  ReadRegStr $mui.LangDLL.RegistryLanguage "${MUI_LANGDLL_REGISTRY_ROOT}" "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}"
  ${If} $mui.LangDLL.RegistryLanguage != ""
    StrCpy $LANGUAGE $mui.LangDLL.RegistryLanguage
  ${EndIf}

  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
  ${AndIf} $UpdateMode != 1
    LangDLL::LangDialog "${MUI_LANGDLL_WINDOWTITLE}" "${MUI_LANGDLL_INFO}" AC ${MUI_LANGDLL_LANGUAGES_CP} ""
    Pop $LANGUAGE
    ${If} $LANGUAGE == "cancel"
      Abort
    ${EndIf}
  ${EndIf}
!macroend
