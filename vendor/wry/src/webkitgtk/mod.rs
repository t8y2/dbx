// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#[cfg(feature = "x11")]
use dpi::LogicalPosition;
use dpi::LogicalSize;
use ffi::CookieManageExt;
#[cfg(feature = "x11")]
use gdkx11::{
  ffi::{gdk_x11_window_foreign_new_for_display, GdkX11Display},
  X11Display,
};
#[cfg(feature = "x11")]
use gtk::glib::{self, translate::FromGlibPtrFull};
use gtk::{
  gdk::{self},
  gio::Cancellable,
  prelude::*,
};
use http::Request;
use javascriptcore::ValueExt;
use raw_window_handle::HasWindowHandle;
#[cfg(feature = "x11")]
use raw_window_handle::RawWindowHandle;
#[cfg(feature = "x11")]
use std::ffi::c_ulong;
#[cfg(any(debug_assertions, feature = "devtools"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
  collections::HashMap,
  rc::Rc,
  sync::{Arc, Mutex},
};
#[cfg(any(debug_assertions, feature = "devtools"))]
use webkit2gtk::WebInspectorExt;
use webkit2gtk::{
  AutoplayPolicy, CookieManagerExt, InputMethodContextExt, LoadEvent, NavigationPolicyDecision,
  NavigationPolicyDecisionExt, NetworkProxyMode, NetworkProxySettings, PolicyDecisionType,
  PrintOperationExt, SettingsExt, URIRequest, URIRequestExt, UserContentInjectedFrames,
  UserContentManager, UserContentManagerExt, UserScript, UserScriptInjectionTime,
  WebContextExt as Webkit2gtkWeContextExt, WebView, WebViewExt, WebsiteDataManagerExt,
  WebsiteDataManagerExtManual, WebsitePolicies,
};
use webkit2gtk_sys::{
  webkit_get_major_version, webkit_get_micro_version, webkit_get_minor_version,
  webkit_policy_decision_ignore, webkit_policy_decision_use,
};
#[cfg(feature = "x11")]
use x11_dl::xlib::*;

pub use web_context::WebContextImpl;

use crate::{
  proxy::ProxyConfig, web_context::WebContext, Error, NewWindowFeatures, NewWindowOpener,
  NewWindowResponse, PageLoadEvent, Rect, Result, WebViewAttributes, RGBA,
};

use self::web_context::WebContextExt;

const WEBVIEW_ID: &str = "webview_id";

mod drag_drop;
mod synthetic_mouse_events;
mod web_context;

#[cfg(feature = "x11")]
struct X11Data {
  is_child: bool,
  xlib: Xlib,
  x11_display: *mut std::ffi::c_void,
  x11_window: c_ulong,
  gtk_window: gtk::Window,
}

#[cfg(feature = "x11")]
impl Drop for X11Data {
  fn drop(&mut self) {
    unsafe { (self.xlib.XDestroyWindow)(self.x11_display as _, self.x11_window) };
    self.gtk_window.close();
  }
}

pub(crate) struct InnerWebView {
  id: String,
  pub webview: WebView,
  #[cfg(any(debug_assertions, feature = "devtools"))]
  is_inspector_open: Arc<AtomicBool>,
  pending_scripts: Arc<Mutex<Option<Vec<String>>>>,
  is_in_fixed_parent: bool,

  #[cfg(feature = "x11")]
  x11: Option<X11Data>,
}

impl Drop for InnerWebView {
  fn drop(&mut self) {
    unsafe { self.webview.destroy() }
  }
}

impl InnerWebView {
  pub fn new<W: HasWindowHandle>(
    window: &W,
    attributes: WebViewAttributes,
    pl_attrs: super::PlatformSpecificWebViewAttributes,
  ) -> Result<Self> {
    #[cfg(feature = "x11")]
    {
      Self::new_x11(window, attributes, pl_attrs, false)
    }
    #[cfg(not(feature = "x11"))]
    {
      let _ = window;
      let _ = attributes;
      let _ = pl_attrs;
      Err(Error::UnsupportedWindowHandle)
    }
  }

  pub fn new_as_child<W: HasWindowHandle>(
    parent: &W,
    attributes: WebViewAttributes,
    pl_attrs: super::PlatformSpecificWebViewAttributes,
  ) -> Result<Self> {
    #[cfg(feature = "x11")]
    {
      Self::new_x11(parent, attributes, pl_attrs, true)
    }
    #[cfg(not(feature = "x11"))]
    {
      let _ = parent;
      let _ = attributes;
      let _ = pl_attrs;
      Err(Error::UnsupportedWindowHandle)
    }
  }

  #[cfg(feature = "x11")]
  fn new_x11<W: HasWindowHandle>(
    window: &W,
    attributes: WebViewAttributes,
    pl_attrs: super::PlatformSpecificWebViewAttributes,
    is_child: bool,
  ) -> Result<Self> {
    let parent = match window.window_handle()?.as_raw() {
      RawWindowHandle::Xlib(w) => w.window,
      _ => return Err(Error::UnsupportedWindowHandle),
    };

    let xlib = Xlib::open()?;

    let gdk_display = gdk::Display::default().ok_or(crate::Error::X11DisplayNotFound)?;
    let gx11_display: &X11Display = gdk_display.downcast_ref().unwrap();
    let raw = gx11_display.as_ptr();

    let x11_display = unsafe { gdkx11::ffi::gdk_x11_display_get_xdisplay(raw) };

    let x11_window = match is_child {
      true => Self::create_container_x11_window(&xlib, x11_display as _, parent, &attributes),
      false => parent,
    };

    let (gtk_window, vbox) = Self::create_gtk_window(raw, x11_window);

    let visible = attributes.visible;

    Self::new_gtk(&vbox, attributes, pl_attrs).map(|mut w| {
      // for some reason, if the webview starts as hidden,
      // we will need about 3 calls to `webview.set_visible`
      // with alternating value.
      // calling gtk_window.show_all() then hiding it again
      // seems to fix the issue.
      gtk_window.show_all();
      if !visible {
        let _ = w.set_visible(false);
      }

      w.x11.replace(X11Data {
        is_child,
        xlib,
        x11_display: x11_display as _,
        x11_window,
        gtk_window,
      });

      w
    })
  }

  #[cfg(feature = "x11")]
  fn create_container_x11_window(
    xlib: &Xlib,
    display: *mut _XDisplay,
    parent: c_ulong,
    attributes: &WebViewAttributes,
  ) -> c_ulong {
    let scale_factor = scale_factor_from_x11(xlib, display, parent);
    let (x, y) = attributes
      .bounds
      .map(|b| b.position.to_physical::<f64>(scale_factor))
      .map(Into::into)
      .unwrap_or((0, 0));
    let (width, height) = attributes
      .bounds
      .map(|b| b.size.to_physical::<u32>(scale_factor))
      .map(Into::into)
      // it is unlikey that bounds are not set because
      // we have a default for it, but anyways we need to have a fallback
      // and we need to use 1 not 0 here otherwise xlib will crash
      .unwrap_or((1, 1));

    let window =
      unsafe { (xlib.XCreateSimpleWindow)(display, parent, x, y, width, height, 0, 0, 0) };

    if attributes.visible {
      unsafe { (xlib.XMapWindow)(display, window) };
    }

    window
  }

  #[cfg(feature = "x11")]
  pub fn create_gtk_window(
    raw: *mut GdkX11Display,
    x11_window: c_ulong,
  ) -> (gtk::Window, gtk::Box) {
    // Gdk.Window
    let gdk_window = unsafe { gdk_x11_window_foreign_new_for_display(raw, x11_window) };
    let gdk_window = unsafe { gdk::Window::from_glib_full(gdk_window) };

    // Gtk.Window
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.connect_realize(glib::clone!(@weak gdk_window as wd => move |w| w.set_window(wd)));
    window.set_has_window(true);
    window.realize();

    // Gtk.Box (vertical)
    let vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
    window.add(&vbox);

    (window, vbox)
  }

  pub fn new_gtk<W>(
    container: &W,
    mut attributes: WebViewAttributes,
    pl_attrs: super::PlatformSpecificWebViewAttributes,
  ) -> Result<Self>
  where
    W: IsA<gtk::Container>,
  {
    // default_context allows us to create a scoped context on-demand
    let mut default_context;
    let web_context = if attributes.incognito {
      default_context = WebContext::new_ephemeral();
      &mut default_context
    } else {
      match attributes.context.take() {
        Some(w) => w,
        None => {
          default_context = Default::default();
          &mut default_context
        }
      }
    };
    if let Some(proxy_setting) = &attributes.proxy_config {
      let proxy_uri = match proxy_setting {
        ProxyConfig::Http(endpoint) => format!("http://{}:{}", endpoint.host, endpoint.port),
        ProxyConfig::Socks5(endpoint) => {
          format!("socks5://{}:{}", endpoint.host, endpoint.port)
        }
      };
      if let Some(website_data_manager) = web_context.context().website_data_manager() {
        let mut settings = NetworkProxySettings::new(Some(proxy_uri.as_str()), &[]);
        website_data_manager
          .set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut settings));
      }
    }

    // Extension loading
    if let Some(extension_path) = &pl_attrs.extension_path {
      web_context.os.set_web_extensions_directory(extension_path);
    }

    let webview = Self::create_webview(web_context, &attributes, &pl_attrs);

    // Transparent
    if attributes.transparent {
      webview.set_background_color(&gtk::gdk::RGBA::new(0., 0., 0., 0.));
    } else {
      // background color
      if let Some((red, green, blue, alpha)) = attributes.background_color {
        webview.set_background_color(&gtk::gdk::RGBA::new(
          red as f64 / 255.0,
          green as f64 / 255.0,
          blue as f64 / 255.0,
          alpha as f64 / 255.0,
        ));
      }
    }

    // Webview Settings
    Self::set_webview_settings(&webview, &attributes);

    // Webview handlers
    Self::attach_handlers(&webview, web_context, &mut attributes);

    // IPC handler
    Self::attach_ipc_handler(webview.clone(), &mut attributes);

    // Drag drop handler
    if let Some(drag_drop_handler) = attributes.drag_drop_handler.take() {
      drag_drop::connect_drag_event(&webview, drag_drop_handler);
    }

    web_context.register_automation(webview.clone());

    let is_in_fixed_parent = Self::add_to_container(&webview, container, &attributes);

    #[cfg(any(debug_assertions, feature = "devtools"))]
    let is_inspector_open = Self::attach_inspector_handlers(&webview);

    let id = attributes
      .id
      .map(|id| id.to_string())
      .unwrap_or_else(|| (webview.as_ptr() as isize).to_string());
    unsafe { webview.set_data(WEBVIEW_ID, id.clone()) };

    let w = Self {
      id,
      webview,
      pending_scripts: Arc::new(Mutex::new(Some(Vec::new()))),

      is_in_fixed_parent,
      #[cfg(feature = "x11")]
      x11: None,

      #[cfg(any(debug_assertions, feature = "devtools"))]
      is_inspector_open,
    };

    // Initialize message handler
    w.init("Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: function(x) { window.webkit.messageHandlers['ipc'].postMessage(x) } }) })", true)?;

    // Initialize scripts
    for init_script in attributes.initialization_scripts {
      w.init(&init_script.script, init_script.for_main_frame_only)?;
    }

    // Run pending webview.eval() scripts once webview loads.
    let pending_scripts = w.pending_scripts.clone();
    w.webview.connect_load_changed(move |webview, event| {
      if let LoadEvent::Committed = event {
        let mut pending_scripts_ = pending_scripts.lock().unwrap();
        if let Some(pending_scripts) = pending_scripts_.take() {
          let cancellable: Option<&Cancellable> = None;
          for script in pending_scripts {
            webview.run_javascript(&script, cancellable, |_| ());
          }
        }
      }
    });

    // Custom protocols handler
    for (name, handler) in attributes.custom_protocols {
      web_context.register_uri_scheme(&name, handler)?;
    }

    // Navigation
    if let Some(url) = attributes.url {
      web_context.load_uri(w.webview.clone(), url, attributes.headers);
    } else if let Some(html) = attributes.html {
      w.webview.load_html(&html, None);
    }

    if attributes.visible {
      w.webview.show_all();
    }

    if attributes.focused {
      w.webview.grab_focus();
    }

    Ok(w)
  }

  fn create_webview(
    web_context: &WebContext,
    attributes: &WebViewAttributes,
    pl_attrs: &super::PlatformSpecificWebViewAttributes,
  ) -> WebView {
    let mut builder = WebView::builder()
      .user_content_manager(&UserContentManager::new())
      .is_controlled_by_automation(web_context.allows_automation());

    if attributes.autoplay {
      builder = builder.website_policies(
        &WebsitePolicies::builder()
          .autoplay(AutoplayPolicy::Allow)
          .build(),
      );
    }

    if let Some(related_view) = &pl_attrs.related_view {
      builder = builder.related_view(related_view);
    } else {
      builder = builder.web_context(web_context.context());
    }

    builder.build()
  }

  fn set_webview_settings(webview: &WebView, attributes: &WebViewAttributes) {
    // Disable input preedit,fcitx input editor can anchor at edit cursor position
    if let Some(input_context) = webview.input_method_context() {
      input_context.set_enable_preedit(false);
    }

    // use system scrollbars
    if let Some(context) = webview.context() {
      context.set_use_system_appearance_for_scrollbars(false);
    }

    if let Some(settings) = WebViewExt::settings(webview) {
      // Enable webgl, webaudio, canvas features as default.
      settings.set_enable_webgl(true);
      settings.set_enable_webaudio(true);
      settings
        .set_enable_back_forward_navigation_gestures(attributes.back_forward_navigation_gestures);

      // Enable clipboard
      if attributes.clipboard {
        settings.set_javascript_can_access_clipboard(true);
      }

      // Enable App cache
      settings.set_enable_page_cache(true);

      // Set user agent
      settings.set_user_agent(attributes.user_agent.as_deref());

      // Devtools
      if attributes.devtools {
        settings.set_enable_developer_extras(true);
      }

      if attributes.javascript_disabled {
        settings.set_enable_javascript(false);
      }
    }
  }

  fn attach_handlers(
    webview: &WebView,
    web_context: &mut WebContext,
    attributes: &mut WebViewAttributes,
  ) {
    // window.close()
    webview.connect_close(move |webview| unsafe { webview.destroy() });

    // Synthetic mouse events
    synthetic_mouse_events::setup(webview);

    // Document title changed handler
    if let Some(document_title_changed_handler) = attributes.document_title_changed_handler.take() {
      webview.connect_title_notify(move |webview| {
        let new_title = webview.title().map(|t| t.to_string()).unwrap_or_default();
        document_title_changed_handler(new_title)
      });
    }

    // Page load handler
    if let Some(on_page_load_handler) = attributes.on_page_load_handler.take() {
      webview.connect_load_changed(move |webview, load_event| match load_event {
        LoadEvent::Committed => {
          on_page_load_handler(PageLoadEvent::Started, webview.uri().unwrap().to_string());
        }
        LoadEvent::Finished => {
          on_page_load_handler(PageLoadEvent::Finished, webview.uri().unwrap().to_string());
        }
        _ => (),
      });
    }

    // window creation handler
    if let Some(new_window_req_handler) = attributes.new_window_req_handler.take() {
      let related_webviews = Rc::new(Mutex::new(HashMap::new()));
      webview.connect_create(move |webview, action| {
        let url = action
          .request()
          .and_then(|request| request.uri())
          .map(|uri| uri.as_str().to_string())?;
        match new_window_req_handler(
          url.clone(),
          NewWindowFeatures {
            size: None,
            position: None,
            opener: NewWindowOpener {
              webview: webview.clone(),
            },
          },
        ) {
          NewWindowResponse::Allow => {
            let related_webviews = related_webviews.clone();
            let toplevel = webview.toplevel().unwrap();
            let window = toplevel.downcast::<gtk::ApplicationWindow>().unwrap();
            let id = window.id();
            let app = window.application().unwrap();

            let window = gtk::ApplicationWindow::builder()
              .application(&app)
              .title(&url)
              .build();
            let box_ = gtk::Box::new(gtk::Orientation::Vertical, 0);
            window.add(&box_);

            let related_webviews_ = related_webviews.clone();
            window.connect_destroy(move |_| {
              related_webviews_.lock().unwrap().remove(&id);
            });

            window.show_all();
            Self::new_gtk(
              &box_,
              WebViewAttributes {
                ..Default::default()
              },
              super::PlatformSpecificWebViewAttributes {
                related_view: Some(webview.clone()),
                ..Default::default()
              },
            )
            .map(|webview| {
              let widget = webview.webview.upcast_ref::<gtk::Widget>().clone();
              related_webviews.lock().unwrap().insert(id, webview);
              widget
            })
            .ok()
          }
          NewWindowResponse::Create { webview } => Some(webview.upcast::<gtk::Widget>()),
          NewWindowResponse::Deny => None,
        }
      });
    }

    // Navigation handler
    if let Some(navigation_handler) = attributes.navigation_handler.take() {
      webview.connect_decide_policy(move |_webview, policy_decision, policy_type| {
        let handler = match policy_type {
          PolicyDecisionType::NavigationAction => &navigation_handler,
          _ => return false,
        };

        if let Some(policy) = policy_decision.dynamic_cast_ref::<NavigationPolicyDecision>() {
          if let Some(nav_action) = policy.navigation_action() {
            if let Some(uri_req) = nav_action.request() {
              if let Some(uri) = uri_req.uri() {
                let allow = handler(uri.to_string());
                let pointer = policy_decision.as_ptr();
                unsafe {
                  if allow {
                    webkit_policy_decision_use(pointer)
                  } else {
                    webkit_policy_decision_ignore(pointer)
                  }
                }

                return true;
              }
            }
          }
        }

        false
      });
    }

    // Download handler
    if attributes.download_started_handler.is_some()
      || attributes.download_completed_handler.is_some()
    {
      web_context.register_download_handler(
        attributes.download_started_handler.take(),
        attributes.download_completed_handler.take(),
      )
    }
  }

  fn add_to_container<W>(webview: &WebView, container: &W, attributes: &WebViewAttributes) -> bool
  where
    W: IsA<gtk::Container>,
  {
    let mut is_in_fixed_parent = false;

    let container_type = container.type_().name();
    if container_type == "GtkBox" {
      container
        .dynamic_cast_ref::<gtk::Box>()
        .unwrap()
        .pack_start(webview, true, true, 0);
    } else if container_type == "GtkFixed" {
      let scale_factor = webview.scale_factor() as f64;
      let (width, height) = attributes
        .bounds
        .map(|b| b.size.to_logical::<i32>(scale_factor))
        .map(Into::into)
        .unwrap_or((1, 1));
      let (x, y) = attributes
        .bounds
        .map(|b| b.position.to_logical::<i32>(scale_factor))
        .map(Into::into)
        .unwrap_or((0, 0));

      webview.set_size_request(width, height);

      container
        .dynamic_cast_ref::<gtk::Fixed>()
        .unwrap()
        .put(webview, x, y);

      is_in_fixed_parent = true;
    } else {
      container.add(webview);
    }

    is_in_fixed_parent
  }

  fn attach_ipc_handler(webview: WebView, attributes: &mut WebViewAttributes) {
    // Message handler
    let ipc_handler = attributes.ipc_handler.take();
    let manager = webview
      .user_content_manager()
      .expect("WebView does not have UserContentManager");

    // Connect before registering as recommended by the docs
    manager.connect_script_message_received(None, move |_m, msg| {
      #[cfg(feature = "tracing")]
      let _span = tracing::info_span!(parent: None, "wry::ipc::handle").entered();

      if let Some(js) = msg.js_value() {
        if let Some(ipc_handler) = &ipc_handler {
          ipc_handler(
            Request::builder()
              .uri(webview.uri().unwrap().to_string())
              .body(js.to_string())
              .unwrap(),
          );
        }
      }
    });

    // Register the handler we just connected
    manager.register_script_message_handler("ipc");
  }

  #[cfg(any(debug_assertions, feature = "devtools"))]
  fn attach_inspector_handlers(webview: &WebView) -> Arc<AtomicBool> {
    let is_inspector_open = Arc::new(AtomicBool::default());
    if let Some(inspector) = webview.inspector() {
      let is_inspector_open_ = is_inspector_open.clone();
      inspector.connect_bring_to_front(move |_| {
        is_inspector_open_.store(true, Ordering::Relaxed);
        false
      });
      let is_inspector_open_ = is_inspector_open.clone();
      inspector.connect_closed(move |_| {
        is_inspector_open_.store(false, Ordering::Relaxed);
      });
    }
    is_inspector_open
  }

  pub fn id(&self) -> crate::WebViewId<'_> {
    &self.id
  }

  pub fn print(&self) -> Result<()> {
    let print = webkit2gtk::PrintOperation::new(&self.webview);
    print.run_dialog(None::<&gtk::Window>);
    Ok(())
  }

  pub fn url(&self) -> Result<String> {
    Ok(self.webview.uri().unwrap_or_default().to_string())
  }

  pub fn eval(
    &self,
    js: &str,
    callback: Option<impl FnOnce(String) + Send + 'static>,
  ) -> Result<()> {
    if let Some(pending_scripts) = &mut *self.pending_scripts.lock().unwrap() {
      pending_scripts.push(js.into());
    } else {
      let cancellable: Option<&Cancellable> = None;

      #[cfg(feature = "tracing")]
      let span = SendEnteredSpan(tracing::debug_span!("wry::eval").entered());

      self.webview.run_javascript(js, cancellable, |result| {
        #[cfg(feature = "tracing")]
        drop(span);

        if let Some(callback) = callback {
          let result = result
            .map(|r| r.js_value().and_then(|js| js.to_json(0)))
            .unwrap_or_default()
            .unwrap_or_default()
            .to_string();

          callback(result);
        }
      });
    }

    Ok(())
  }

  fn init(&self, js: &str, for_main_only: bool) -> Result<()> {
    if let Some(manager) = self.webview.user_content_manager() {
      let script = UserScript::new(
        js,
        if for_main_only {
          UserContentInjectedFrames::TopFrame
        } else {
          UserContentInjectedFrames::AllFrames
        },
        UserScriptInjectionTime::Start,
        &[],
        &[],
      );
      manager.add_script(&script);
    } else {
      return Err(Error::InitScriptError);
    }
    Ok(())
  }

  #[cfg(any(debug_assertions, feature = "devtools"))]
  pub fn open_devtools(&self) {
    if let Some(inspector) = self.webview.inspector() {
      inspector.show();
      // `bring-to-front` is not received in this case
      self.is_inspector_open.store(true, Ordering::Relaxed);
    }
  }

  #[cfg(any(debug_assertions, feature = "devtools"))]
  pub fn close_devtools(&self) {
    if let Some(inspector) = self.webview.inspector() {
      inspector.close();
    }
  }

  #[cfg(any(debug_assertions, feature = "devtools"))]
  pub fn is_devtools_open(&self) -> bool {
    self.is_inspector_open.load(Ordering::Relaxed)
  }

  pub fn zoom(&self, scale_factor: f64) -> Result<()> {
    self.webview.set_zoom_level(scale_factor);
    Ok(())
  }

  pub fn set_background_color(&self, (red, green, blue, alpha): RGBA) -> Result<()> {
    self.webview.set_background_color(&gtk::gdk::RGBA::new(
      red as f64 / 255.0,
      green as f64 / 255.0,
      blue as f64 / 255.0,
      alpha as f64 / 255.0,
    ));
    Ok(())
  }

  pub fn load_url(&self, url: &str) -> Result<()> {
    self.webview.load_uri(url);
    Ok(())
  }

  pub fn load_url_with_headers(&self, url: &str, headers: http::HeaderMap) -> Result<()> {
    let req = URIRequest::builder().uri(url).build();

    if let Some(ref mut req_headers) = req.http_headers() {
      for (header, value) in headers.iter() {
        req_headers.append(
          header.to_string().as_str(),
          value.to_str().unwrap_or_default(),
        );
      }
    }

    self.webview.load_request(&req);

    Ok(())
  }

  pub fn load_html(&self, html: &str) -> Result<()> {
    self.webview.load_html(html, None);
    Ok(())
  }

  pub fn reload(&self) -> Result<()> {
    self.webview.reload();
    Ok(())
  }

  pub fn clear_all_browsing_data(&self) -> Result<()> {
    if let Some(context) = self.webview.context() {
      if let Some(data_manger) = context.website_data_manager() {
        data_manger.clear(
          webkit2gtk::WebsiteDataTypes::ALL,
          gtk::glib::TimeSpan::from_seconds(0),
          None::<&Cancellable>,
          |_| {},
        );
      }
    }

    Ok(())
  }

  pub fn bounds(&self) -> Result<Rect> {
    let mut bounds = Rect::default();

    #[cfg(feature = "x11")]
    if let Some(x11_data) = &self.x11 {
      unsafe {
        let attributes: XWindowAttributes = std::mem::zeroed();
        let mut attributes = std::mem::MaybeUninit::new(attributes).assume_init();

        let ok = (x11_data.xlib.XGetWindowAttributes)(
          x11_data.x11_display as _,
          x11_data.x11_window,
          &mut attributes,
        );

        if ok != 0 {
          bounds.position = LogicalPosition::new(attributes.x, attributes.y).into();
          bounds.size = LogicalSize::new(attributes.width, attributes.height).into();
        }
      }
      return Ok(bounds);
    }

    let (size, _) = self.webview.allocated_size();
    bounds.size = LogicalSize::new(size.width(), size.height()).into();

    Ok(bounds)
  }

  pub fn set_bounds(&self, bounds: Rect) -> Result<()> {
    let scale_factor = self.webview.scale_factor() as f64;
    let (width, height) = bounds.size.to_logical::<i32>(scale_factor).into();
    let (x, y) = bounds.position.to_logical::<i32>(scale_factor).into();

    #[cfg(feature = "x11")]
    if let Some(x11_data) = &self.x11 {
      let window = &x11_data.gtk_window;
      window.move_(x, y);
      if let Some(window) = window.window() {
        window.resize(width, height);
      }
      window.size_allocate(&gtk::Allocation::new(0, 0, width, height));
    }

    if self.is_in_fixed_parent {
      self
        .webview
        .size_allocate(&gtk::Allocation::new(x, y, width, height));
    }

    Ok(())
  }

  #[cfg(feature = "x11")]
  fn set_visible_x11(&self, visible: bool) {
    if let Some(x11_data) = &self.x11 {
      if x11_data.is_child {
        if visible {
          unsafe { (x11_data.xlib.XMapWindow)(x11_data.x11_display as _, x11_data.x11_window) };
        } else {
          unsafe { (x11_data.xlib.XUnmapWindow)(x11_data.x11_display as _, x11_data.x11_window) };
        }
      }
    }
  }

  #[cfg(feature = "x11")]
  fn set_visible_gtk(&self, visible: bool) {
    if let Some(x11_data) = &self.x11 {
      if x11_data.is_child {
        if visible {
          x11_data.gtk_window.show_all();
        } else {
          x11_data.gtk_window.hide();
        }
      }
    }
  }

  pub fn set_visible(&self, visible: bool) -> Result<()> {
    #[cfg(feature = "x11")]
    self.set_visible_x11(visible);

    if visible {
      self.webview.show_all();
    } else {
      self.webview.hide();
    }

    #[cfg(feature = "x11")]
    self.set_visible_gtk(visible);

    Ok(())
  }

  pub fn focus(&self) -> Result<()> {
    self.webview.grab_focus();
    Ok(())
  }

  pub fn focus_parent(&self) -> Result<()> {
    if let Some(window) = self.webview.parent_window() {
      window.focus(gdk::ffi::GDK_CURRENT_TIME.try_into().unwrap_or(0));
    }

    Ok(())
  }

  fn cookie_from_soup_cookie(mut cookie: soup::Cookie) -> cookie::Cookie<'static> {
    let name = cookie.name().map(|n| n.to_string()).unwrap_or_default();
    let value = cookie.value().map(|n| n.to_string()).unwrap_or_default();

    let mut cookie_builder = cookie::CookieBuilder::new(name, value);

    if let Some(domain) = cookie.domain().map(|n| n.to_string()) {
      cookie_builder = cookie_builder.domain(domain);
    }

    if let Some(path) = cookie.path().map(|n| n.to_string()) {
      cookie_builder = cookie_builder.path(path);
    }

    let http_only = cookie.is_http_only();
    cookie_builder = cookie_builder.http_only(http_only);

    let secure = cookie.is_secure();
    cookie_builder = cookie_builder.secure(secure);

    let same_site = cookie.same_site_policy();
    let same_site = match same_site {
      soup::SameSitePolicy::Lax => cookie::SameSite::Lax,
      soup::SameSitePolicy::Strict => cookie::SameSite::Strict,
      soup::SameSitePolicy::None => cookie::SameSite::None,
      _ => cookie::SameSite::None,
    };
    cookie_builder = cookie_builder.same_site(same_site);

    let expires = cookie.expires();
    let expires = match expires {
      Some(datetime) => cookie::time::OffsetDateTime::from_unix_timestamp(datetime.to_unix())
        .ok()
        .map(cookie::Expiration::DateTime),
      None => Some(cookie::Expiration::Session),
    };
    if let Some(expires) = expires {
      cookie_builder = cookie_builder.expires(expires);
    }

    cookie_builder.build()
  }

  fn cookie_into_soup_cookie(cookie: &cookie::Cookie<'_>) -> soup::Cookie {
    let mut soup_cookie = soup::Cookie::new(
      cookie.name(),
      cookie.value(),
      cookie.domain().unwrap_or(""),
      cookie.path().unwrap_or(""),
      cookie
        .max_age()
        .map(|d| d.whole_seconds() as i32)
        .unwrap_or(-1),
    );

    if let Some(dt) = cookie.expires_datetime() {
      soup_cookie.set_expires(&gtk::glib::DateTime::from_unix_utc(dt.unix_timestamp()).unwrap());
    }

    if let Some(http_only) = cookie.http_only() {
      soup_cookie.set_http_only(http_only);
    }

    if let Some(same_site) = cookie.same_site() {
      soup_cookie.set_same_site_policy(match same_site {
        cookie::SameSite::Lax => soup::SameSitePolicy::Lax,
        cookie::SameSite::Strict => soup::SameSitePolicy::Strict,
        cookie::SameSite::None => soup::SameSitePolicy::None,
      });
    }

    if let Some(secure) = cookie.secure() {
      soup_cookie.set_secure(secure);
    }

    soup_cookie
  }

  pub fn cookies_for_url(&self, url: &str) -> Result<Vec<cookie::Cookie<'static>>> {
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(cookies_manager) = self
      .webview
      .website_data_manager()
      .and_then(|manager| manager.cookie_manager())
    {
      cookies_manager.cookies(url, None::<&Cancellable>, move |cookies| {
        let cookies = cookies.map(|cookies| {
          cookies
            .into_iter()
            .map(Self::cookie_from_soup_cookie)
            .collect()
        });
        let _ = tx.send(cookies);
      })
    }

    loop {
      gtk::main_iteration();

      if let Ok(response) = rx.try_recv() {
        return response.map_err(Into::into);
      }
    }
  }

  pub fn cookies(&self) -> Result<Vec<cookie::Cookie<'static>>> {
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(cookies_manager) = self
      .webview
      .website_data_manager()
      .and_then(|manager| manager.cookie_manager())
    {
      cookies_manager.all_cookies(None::<&Cancellable>, move |cookies| {
        let cookies = cookies.map(|cookies| {
          cookies
            .into_iter()
            .map(Self::cookie_from_soup_cookie)
            .collect()
        });
        let _ = tx.send(cookies);
      })
    }

    loop {
      gtk::main_iteration();

      if let Ok(response) = rx.try_recv() {
        return response.map_err(Into::into);
      }
    }
  }

  pub fn set_cookie(&self, cookie: &cookie::Cookie<'_>) -> Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(cookies_manager) = self
      .webview
      .website_data_manager()
      .and_then(|manager| manager.cookie_manager())
    {
      let mut soup_cookie = Self::cookie_into_soup_cookie(cookie);
      cookies_manager.add_cookie(&mut soup_cookie, None::<&Cancellable>, move |ret| {
        let _ = tx.send(ret);
      });
    }

    loop {
      gtk::main_iteration();

      if let Ok(response) = rx.try_recv() {
        return response.map_err(Into::into);
      }
    }
  }

  pub fn delete_cookie(&self, cookie: &cookie::Cookie<'_>) -> Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(cookies_manager) = self
      .webview
      .website_data_manager()
      .and_then(|manager| manager.cookie_manager())
    {
      let mut soup_cookie = Self::cookie_into_soup_cookie(cookie);
      cookies_manager.delete_cookie(&mut soup_cookie, None::<&Cancellable>, move |ret| {
        let _ = tx.send(ret);
      });
    }

    loop {
      gtk::main_iteration();

      if let Ok(response) = rx.try_recv() {
        return response.map_err(Into::into);
      }
    }
  }

  pub fn reparent<W>(&self, container: &W) -> Result<()>
  where
    W: gtk::prelude::IsA<gtk::Container>,
  {
    if let Some(parent) = self
      .webview
      .parent()
      .and_then(|p| p.dynamic_cast::<gtk::Container>().ok())
    {
      parent.remove(&self.webview);

      let container_type = container.type_().name();
      if container_type == "GtkBox" {
        container
          .dynamic_cast_ref::<gtk::Box>()
          .unwrap()
          .pack_start(&self.webview, true, true, 0);
      } else if container_type == "GtkFixed" {
        container
          .dynamic_cast_ref::<gtk::Fixed>()
          .unwrap()
          .put(&self.webview, 0, 0);
      } else {
        container.add(&self.webview);
      }
    }

    Ok(())
  }
}

pub fn platform_webview_version() -> Result<String> {
  let (major, minor, patch) = unsafe {
    (
      webkit_get_major_version(),
      webkit_get_minor_version(),
      webkit_get_micro_version(),
    )
  };
  Ok(format!("{major}.{minor}.{patch}"))
}

// SAFETY: only use this when you are sure the span will be dropped on the same thread it was entered
#[cfg(feature = "tracing")]
struct SendEnteredSpan(tracing::span::EnteredSpan);

#[cfg(feature = "tracing")]
unsafe impl Send for SendEnteredSpan {}

#[cfg(feature = "x11")]
fn scale_factor_from_x11(xlib: &Xlib, display: *mut _XDisplay, parent: c_ulong) -> f64 {
  const BASE_DPI: f64 = 96.0;
  let mut attrs = unsafe { std::mem::zeroed() };
  unsafe { (xlib.XGetWindowAttributes)(display, parent, &mut attrs) };
  let scale_factor = unsafe { (*attrs.screen).width as f64 * 25.4 / (*attrs.screen).mwidth as f64 };
  scale_factor / BASE_DPI
}

mod ffi {
  use gtk::{
    gdk,
    gio::{
      self,
      ffi::{GAsyncReadyCallback, GCancellable},
      prelude::*,
      Cancellable,
    },
    glib::{
      self,
      translate::{FromGlibPtrContainer, ToGlibPtr},
    },
  };
  use webkit2gtk::CookieManager;
  use webkit2gtk_sys::WebKitCookieManager;

  pub trait CookieManageExt: IsA<CookieManager> + 'static {
    fn all_cookies<P: FnOnce(std::result::Result<Vec<soup::Cookie>, glib::Error>) + 'static>(
      &self,
      cancellable: Option<&impl IsA<Cancellable>>,
      callback: P,
    ) {
      let main_context = glib::MainContext::ref_thread_default();
      let is_main_context_owner = main_context.is_owner();
      let has_acquired_main_context = (!is_main_context_owner)
        .then(|| main_context.acquire().ok())
        .flatten();
      assert!(
        is_main_context_owner || has_acquired_main_context.is_some(),
        "Async operations only allowed if the thread is owning the MainContext"
      );

      let user_data: Box<glib::thread_guard::ThreadGuard<P>> =
        Box::new(glib::thread_guard::ThreadGuard::new(callback));
      unsafe extern "C" fn cookies_trampoline<
        P: FnOnce(std::result::Result<Vec<soup::Cookie>, glib::Error>) + 'static,
      >(
        _source_object: *mut glib::gobject_ffi::GObject,
        res: *mut gdk::gio::ffi::GAsyncResult,
        user_data: glib::ffi::gpointer,
      ) {
        let mut error = std::ptr::null_mut();
        let ret =
          webkit_cookie_manager_get_all_cookies_finish(_source_object as *mut _, res, &mut error);
        let result = if error.is_null() {
          Ok(FromGlibPtrContainer::from_glib_full(ret))
        } else {
          Err(glib::translate::from_glib_full(error))
        };
        let callback: Box<glib::thread_guard::ThreadGuard<P>> = Box::from_raw(user_data as *mut _);
        let callback: P = callback.into_inner();
        callback(result);
      }
      let callback = cookies_trampoline::<P>;

      unsafe {
        webkit_cookie_manager_get_all_cookies(
          self.as_ref().to_glib_none().0,
          cancellable.map(|p| p.as_ref()).to_glib_none().0,
          Some(callback),
          Box::into_raw(user_data) as *mut _,
        );
      }
    }
  }

  impl CookieManageExt for CookieManager {}

  extern "C" {
    pub fn webkit_cookie_manager_get_all_cookies(
      cookie_manager: *mut webkit2gtk_sys::WebKitCookieManager,
      cancellable: *mut GCancellable,
      callback: GAsyncReadyCallback,
      user_data: glib::ffi::gpointer,
    );

    pub fn webkit_cookie_manager_get_all_cookies_finish(
      cookie_manager: *mut WebKitCookieManager,
      result: *mut gio::ffi::GAsyncResult,
      error: *mut *mut glib::ffi::GError,
    ) -> *mut glib::ffi::GList;
  }
}
