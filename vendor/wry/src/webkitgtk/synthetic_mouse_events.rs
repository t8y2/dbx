use std::{cell::RefCell, rc::Rc};

use gtk::{
  gdk::{EventButton, EventMask, ModifierType},
  prelude::*,
};
use webkit2gtk::{WebView, WebViewExt};

pub fn setup(webview: &WebView) {
  webview.add_events(EventMask::BUTTON1_MOTION_MASK | EventMask::BUTTON_PRESS_MASK);

  let bf_state = BackForwardState(Rc::new(RefCell::new(0)));

  let bf_state_c = bf_state.clone();
  webview.connect_button_press_event(move |webview, event| {
    let mut inhibit = false;
    match event.button() {
      // back button
      8 => {
        inhibit = true;
        bf_state_c.set(BACK);
        webview.run_javascript(
          &create_js_mouse_event(event, true, &bf_state_c),
          None::<&gtk::gio::Cancellable>,
          |_| {},
        );
      }
      // forward button
      9 => {
        inhibit = true;
        bf_state_c.set(FORWARD);
        webview.run_javascript(
          &create_js_mouse_event(event, true, &bf_state_c),
          None::<&gtk::gio::Cancellable>,
          |_| {},
        );
      }
      _ => {}
    }

    if inhibit {
      gtk::glib::Propagation::Stop
    } else {
      gtk::glib::Propagation::Proceed
    }
  });

  let bf_state_c = bf_state.clone();
  webview.connect_button_release_event(move |webview, event| {
    let mut inhibit = false;
    match event.button() {
      // back button
      8 => {
        inhibit = true;
        bf_state_c.remove(BACK);
        webview.run_javascript(
          &create_js_mouse_event(event, false, &bf_state_c),
          None::<&gtk::gio::Cancellable>,
          |_| {},
        );
      }
      // forward button
      9 => {
        inhibit = true;
        bf_state_c.remove(FORWARD);
        webview.run_javascript(
          &create_js_mouse_event(event, false, &bf_state_c),
          None::<&gtk::gio::Cancellable>,
          |_| {},
        );
      }
      _ => {}
    }
    if inhibit {
      gtk::glib::Propagation::Stop
    } else {
      gtk::glib::Propagation::Proceed
    }
  });
}

fn create_js_mouse_event(event: &EventButton, pressed: bool, state: &BackForwardState) -> String {
  let event_name = if pressed { "mousedown" } else { "mouseup" };
  // js equivalent https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button
  let button = if event.button() == 8 { 3 } else { 4 };
  let (x, y) = event.position();
  let (x, y) = (x as i32, y as i32);
  let modifers_state = event.state();
  let mut buttons = 0;
  // left button
  if modifers_state.contains(ModifierType::BUTTON1_MASK) {
    buttons += 1;
  }
  // right button
  if modifers_state.contains(ModifierType::BUTTON3_MASK) {
    buttons += 2;
  }
  // middle button
  if modifers_state.contains(ModifierType::BUTTON2_MASK) {
    buttons += 4;
  }
  // back button
  if state.has(BACK) {
    buttons += 8;
  }
  // if modifers_state.contains(ModifierType::BUTTON4_MASK) {
  //   buttons += 8;
  // }
  // forward button
  if state.has(FORWARD) {
    buttons += 16;
  }
  // if modifers_state.contains(ModifierType::BUTTON5_MASK) {
  //   buttons += 16;
  // }
  format!(
    r#"(() => {{
        const el = document.elementFromPoint({x},{y});
        const ev = new MouseEvent('{event_name}', {{
          view: window,
          button: {button},
          buttons: {buttons},
          x: {x},
          y: {y},
          bubbles: true,
          detail: {detail},
          cancelBubble: false,
          cancelable: true,
          clientX: {x},
          clientY: {y},
          composed: true,
          layerX: {x},
          layerY: {y},
          pageX: {x},
          pageY: {y},
          screenX: window.screenX + {x},
          screenY: window.screenY + {y},
          ctrlKey: {ctrl_key},
          metaKey: {meta_key},
          shiftKey: {shift_key},
          altKey: {alt_key},
        }});
        el.dispatchEvent(ev)
        if (!ev.defaultPrevented && "{event_name}" === "mouseup") {{
          if (ev.button === 3) {{
            window.history.back();
          }}
          if (ev.button === 4) {{
            window.history.forward();
          }}
        }}
      }})()"#,
    event_name = event_name,
    x = x,
    y = y,
    detail = event.click_count().unwrap_or(1),
    ctrl_key = modifers_state.contains(ModifierType::CONTROL_MASK),
    alt_key = modifers_state.contains(ModifierType::MOD1_MASK),
    shift_key = modifers_state.contains(ModifierType::SHIFT_MASK),
    meta_key = modifers_state.contains(ModifierType::SUPER_MASK),
    button = button,
    buttons = buttons,
  )
}

// Internal modifiers to track whether BACK/FORWARD buttons are pressed
const BACK: u8 = 0b01;
const FORWARD: u8 = 0b10;

/// A single u8 that stores whether [BACK] and [FORWARD] are pressed or not
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct BackForwardState(Rc<RefCell<u8>>);

impl BackForwardState {
  fn set(&self, button: u8) {
    *self.0.borrow_mut() |= button
  }

  fn remove(&self, button: u8) {
    *self.0.borrow_mut() &= !button
  }

  fn has(&self, button: u8) -> bool {
    let state = *self.0.borrow();
    state & !button != state
  }
}
