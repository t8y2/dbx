use std::collections::BTreeSet;

/// Generate a list of all `ICoreWebView2...Handler` interfaces declared in `WebView2.h`. This is
/// for testing purposes to make sure they are all covered in
/// [callback.rs](../../webview2-com/src/callback.rs).
pub fn all_declared_callbacks() -> BTreeSet<&'static str> {
    let mut interfaces = BTreeSet::new();

    interfaces.insert("ICoreWebView2AcceleratorKeyPressedEventHandler");
    interfaces.insert("ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler");
    interfaces.insert("ICoreWebView2BasicAuthenticationRequestedEventHandler");
    interfaces.insert("ICoreWebView2BrowserExtensionEnableCompletedHandler");
    interfaces.insert("ICoreWebView2BrowserExtensionRemoveCompletedHandler");
    interfaces.insert("ICoreWebView2BrowserProcessExitedEventHandler");
    interfaces.insert("ICoreWebView2BytesReceivedChangedEventHandler");
    interfaces.insert("ICoreWebView2CallDevToolsProtocolMethodCompletedHandler");
    interfaces.insert("ICoreWebView2CapturePreviewCompletedHandler");
    interfaces.insert("ICoreWebView2ClearBrowsingDataCompletedHandler");
    interfaces.insert("ICoreWebView2ClearServerCertificateErrorActionsCompletedHandler");
    interfaces.insert("ICoreWebView2ClientCertificateRequestedEventHandler");
    interfaces.insert("ICoreWebView2ContainsFullScreenElementChangedEventHandler");
    interfaces.insert("ICoreWebView2ContentLoadingEventHandler");
    interfaces.insert("ICoreWebView2ContextMenuRequestedEventHandler");
    interfaces.insert("ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler");
    interfaces.insert("ICoreWebView2CreateCoreWebView2ControllerCompletedHandler");
    interfaces.insert("ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler");
    interfaces.insert("ICoreWebView2CursorChangedEventHandler");
    interfaces.insert("ICoreWebView2CustomItemSelectedEventHandler");
    interfaces.insert("ICoreWebView2DOMContentLoadedEventHandler");
    interfaces.insert("ICoreWebView2DevToolsProtocolEventReceivedEventHandler");
    interfaces.insert("ICoreWebView2DocumentTitleChangedEventHandler");
    interfaces.insert("ICoreWebView2DownloadStartingEventHandler");
    interfaces.insert("ICoreWebView2EstimatedEndTimeChangedEventHandler");
    interfaces.insert("ICoreWebView2ExecuteScriptCompletedHandler");
    interfaces.insert("ICoreWebView2ExecuteScriptWithResultCompletedHandler");
    interfaces.insert("ICoreWebView2FaviconChangedEventHandler");
    interfaces.insert("ICoreWebView2FindActiveMatchIndexChangedEventHandler");
    interfaces.insert("ICoreWebView2FindMatchCountChangedEventHandler");
    interfaces.insert("ICoreWebView2FindStartCompletedHandler");
    interfaces.insert("ICoreWebView2FocusChangedEventHandler");
    interfaces.insert("ICoreWebView2FrameChildFrameCreatedEventHandler");
    interfaces.insert("ICoreWebView2FrameContentLoadingEventHandler");
    interfaces.insert("ICoreWebView2FrameCreatedEventHandler");
    interfaces.insert("ICoreWebView2FrameDOMContentLoadedEventHandler");
    interfaces.insert("ICoreWebView2FrameDestroyedEventHandler");
    interfaces.insert("ICoreWebView2FrameNameChangedEventHandler");
    interfaces.insert("ICoreWebView2FrameNavigationCompletedEventHandler");
    interfaces.insert("ICoreWebView2FrameNavigationStartingEventHandler");
    interfaces.insert("ICoreWebView2FramePermissionRequestedEventHandler");
    interfaces.insert("ICoreWebView2FrameScreenCaptureStartingEventHandler");
    interfaces.insert("ICoreWebView2FrameWebMessageReceivedEventHandler");
    interfaces.insert("ICoreWebView2GetCookiesCompletedHandler");
    interfaces.insert("ICoreWebView2GetFaviconCompletedHandler");
    interfaces.insert("ICoreWebView2GetNonDefaultPermissionSettingsCompletedHandler");
    interfaces.insert("ICoreWebView2GetProcessExtendedInfosCompletedHandler");
    interfaces.insert("ICoreWebView2HistoryChangedEventHandler");
    interfaces.insert("ICoreWebView2IsDefaultDownloadDialogOpenChangedEventHandler");
    interfaces.insert("ICoreWebView2IsDocumentPlayingAudioChangedEventHandler");
    interfaces.insert("ICoreWebView2IsMutedChangedEventHandler");
    interfaces.insert("ICoreWebView2LaunchingExternalUriSchemeEventHandler");
    interfaces.insert("ICoreWebView2MoveFocusRequestedEventHandler");
    interfaces.insert("ICoreWebView2NavigationCompletedEventHandler");
    interfaces.insert("ICoreWebView2NavigationStartingEventHandler");
    interfaces.insert("ICoreWebView2NewBrowserVersionAvailableEventHandler");
    interfaces.insert("ICoreWebView2NewWindowRequestedEventHandler");
    interfaces.insert("ICoreWebView2NonClientRegionChangedEventHandler");
    interfaces.insert("ICoreWebView2NotificationCloseRequestedEventHandler");
    interfaces.insert("ICoreWebView2NotificationReceivedEventHandler");
    interfaces.insert("ICoreWebView2PermissionRequestedEventHandler");
    interfaces.insert("ICoreWebView2PrintCompletedHandler");
    interfaces.insert("ICoreWebView2PrintToPdfCompletedHandler");
    interfaces.insert("ICoreWebView2PrintToPdfStreamCompletedHandler");
    interfaces.insert("ICoreWebView2ProcessFailedEventHandler");
    interfaces.insert("ICoreWebView2ProcessInfosChangedEventHandler");
    interfaces.insert("ICoreWebView2ProfileAddBrowserExtensionCompletedHandler");
    interfaces.insert("ICoreWebView2ProfileDeletedEventHandler");
    interfaces.insert("ICoreWebView2ProfileGetBrowserExtensionsCompletedHandler");
    interfaces.insert("ICoreWebView2RasterizationScaleChangedEventHandler");
    interfaces.insert("ICoreWebView2SaveAsUIShowingEventHandler");
    interfaces.insert("ICoreWebView2SaveFileSecurityCheckStartingEventHandler");
    interfaces.insert("ICoreWebView2ScreenCaptureStartingEventHandler");
    interfaces.insert("ICoreWebView2ScriptDialogOpeningEventHandler");
    interfaces.insert("ICoreWebView2ServerCertificateErrorDetectedEventHandler");
    interfaces.insert("ICoreWebView2SetPermissionStateCompletedHandler");
    interfaces.insert("ICoreWebView2ShowSaveAsUICompletedHandler");
    interfaces.insert("ICoreWebView2SourceChangedEventHandler");
    interfaces.insert("ICoreWebView2StateChangedEventHandler");
    interfaces.insert("ICoreWebView2StatusBarTextChangedEventHandler");
    interfaces.insert("ICoreWebView2TrySuspendCompletedHandler");
    interfaces.insert("ICoreWebView2WebMessageReceivedEventHandler");
    interfaces.insert("ICoreWebView2WebResourceRequestedEventHandler");
    interfaces.insert("ICoreWebView2WebResourceResponseReceivedEventHandler");
    interfaces.insert("ICoreWebView2WebResourceResponseViewGetContentCompletedHandler");
    interfaces.insert("ICoreWebView2WindowCloseRequestedEventHandler");
    interfaces.insert("ICoreWebView2ZoomFactorChangedEventHandler");

    interfaces
}

/// Generate a list of all `ICoreWebView2EnvironmentOptions` interfaces declared in `WebView2.h`.
/// This is for testing purposes to make sure they are all covered in
/// [options.rs](../../webview2-com/src/options.rs).
pub fn all_declared_options() -> BTreeSet<&'static str> {
    let mut interfaces = BTreeSet::new();

    interfaces.insert("ICoreWebView2EnvironmentOptions");
    interfaces.insert("ICoreWebView2EnvironmentOptions2");
    interfaces.insert("ICoreWebView2EnvironmentOptions3");
    interfaces.insert("ICoreWebView2EnvironmentOptions4");
    interfaces.insert("ICoreWebView2EnvironmentOptions5");
    interfaces.insert("ICoreWebView2EnvironmentOptions6");
    interfaces.insert("ICoreWebView2EnvironmentOptions7");
    interfaces.insert("ICoreWebView2EnvironmentOptions8");

    interfaces
}
