; Coffer's installer hooks (SPEC 3.13, docs/BRIDGE.md): the browser bridge.
;
; scripts/stage-bridge.mjs fills bridge-stage/ before the installer is built
; (tauri.conf.json beforeBuildCommand). Install copies coffer-bridge.exe and
; the extension folder next to coffer.exe, writes the native messaging host
; manifest and registers it for Chrome and Edge (HKCU). Uninstall removes it
; all. An update (/UPDATE) keeps the registry keys.
;
; The host name is the app identifier (BUNDLEID): Coffer registers
; dev.sampo.coffer; a QA build (tauri build --config with its own identifier)
; registers its own name and never Coffer's.

!define COFFER_STAGE "${__FILEDIR__}\..\..\bridge-stage"
; The fixed extension ID, from the public key in extension/manifest.json.
!define COFFER_EXTENSION_ID "jdnmjnanpckdfdhfclpkcbgimdjbeglj"
!define COFFER_CHROME_HOSTS "Software\Google\Chrome\NativeMessagingHosts"
!define COFFER_EDGE_HOSTS "Software\Microsoft\Edge\NativeMessagingHosts"

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "${COFFER_STAGE}\coffer-bridge.exe"
  ; A fresh copy of the extension: no file of an older version stays.
  RMDir /r "$INSTDIR\extension"
  SetOutPath "$INSTDIR\extension"
  File /r "${COFFER_STAGE}\extension\*.*"
  ; host.json: the native host this copy of the extension talks to.
  FileOpen $0 "$INSTDIR\extension\host.json" w
  FileWrite $0 '{"host":"${BUNDLEID}"}$\r$\n'
  FileClose $0
  ; The host manifest. On Windows "path" may be relative to the manifest's folder.
  FileOpen $0 "$INSTDIR\${BUNDLEID}.json" w
  FileWrite $0 '{"name":"${BUNDLEID}","description":"Coffer bridge","path":"coffer-bridge.exe","type":"stdio","allowed_origins":["chrome-extension://${COFFER_EXTENSION_ID}/"]}$\r$\n'
  FileClose $0
  WriteRegStr HKCU "${COFFER_CHROME_HOSTS}\${BUNDLEID}" "" "$INSTDIR\${BUNDLEID}.json"
  WriteRegStr HKCU "${COFFER_EDGE_HOSTS}\${BUNDLEID}" "" "$INSTDIR\${BUNDLEID}.json"
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Before the template's RMDir "$INSTDIR", so the folder can go.
  Delete /REBOOTOK "$INSTDIR\coffer-bridge.exe"
  Delete "$INSTDIR\${BUNDLEID}.json"
  RMDir /r "$INSTDIR\extension"
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "${COFFER_CHROME_HOSTS}\${BUNDLEID}"
    DeleteRegKey HKCU "${COFFER_EDGE_HOSTS}\${BUNDLEID}"
  ${EndIf}
!macroend
