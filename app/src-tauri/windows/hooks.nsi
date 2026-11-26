; Désinstallation : si l'utilisateur coche « Supprimer les données de l'application », on efface aussi les données de PAIZ
; (catalogue, conversations, mémoire, journaux : %APPDATA%\PAIZ), pas seulement le dossier WebView2 géré par défaut.
; Sans la case cochée (défaut, y compris en désinstallation silencieuse), les données sont gardées pour une réinstallation.
!macro NSIS_HOOK_POSTUNINSTALL
  ; la clé « dossier d'installation » ne sert plus une fois désinstallé : on ne la laisse pas dans le registre
  DeleteRegKey HKCU "Software\PAIZ\PAIZ-WeightStream"
  DeleteRegKey /ifempty HKCU "Software\PAIZ"
  ${If} $DeleteAppDataCheckboxState = 1
    RmDir /r "$APPDATA\PAIZ"
  ${EndIf}
!macroend
