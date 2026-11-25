; Hockey Simulator Manager — NSIS additions for electron-builder (package.json → build.nsis.include).
;
; The player's mods live in "$INSTDIR\mods" (see main.cjs). electron-builder's uninstaller — which also runs on
; every update, before the new files are copied — removes the whole $INSTDIR. This replaces that step: the mods
; folder is moved aside to "$INSTDIR.mods-keep" (same drive, so a rename is instant), everything else is removed
; exactly as the stock uninstaller does it, and the folder is moved back. After a full uninstall only
; "$INSTDIR\mods" stays (the player's own files are never deleted).

!macro khlKeepMods
  RMDir /r "$INSTDIR.mods-keep"
  ${if} ${FileExists} "$INSTDIR\mods\*.*"
    ClearErrors
    Rename "$INSTDIR\mods" "$INSTDIR.mods-keep"
    ${if} ${Errors}
      ; Could not move it (a file is open?): copy instead, so the removal below cannot lose it.
      CreateDirectory "$INSTDIR.mods-keep"
      CopyFiles /SILENT "$INSTDIR\mods\*.*" "$INSTDIR.mods-keep"
      RMDir /r "$INSTDIR\mods"
    ${endif}
  ${endif}
!macroend

!macro khlRestoreMods
  ${if} ${FileExists} "$INSTDIR.mods-keep\*.*"
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$INSTDIR.mods-keep" "$INSTDIR\mods"
    ${if} ${Errors}
      CreateDirectory "$INSTDIR\mods"
      CopyFiles /SILENT "$INSTDIR.mods-keep\*.*" "$INSTDIR\mods"
      RMDir /r "$INSTDIR.mods-keep"
    ${endif}
  ${endif}
!macroend

; Same as the stock "delete the installed files" block of templates/nsis/uninstaller.nsh, around the mods folder.
!macro customRemoveFiles
  !insertmacro khlKeepMods

  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      ; Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      !insertmacro khlRestoreMods
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  ; Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  ; Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR

  !insertmacro khlRestoreMods
!macroend
