// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  cell::{Cell, UnsafeCell},
  path::PathBuf,
  rc::Rc,
};

use gtk::{glib::GString, prelude::*};
use webkit2gtk::WebView;

use crate::DragDropEvent;

#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Copy, Debug)]
enum DragControllerState {
  Entered,
  Leaving,
  Left,
}

struct DragDropController {
  paths: UnsafeCell<Option<Vec<PathBuf>>>,
  state: Cell<DragControllerState>,
  position: Cell<(i32, i32)>,
  handler: Box<dyn Fn(DragDropEvent) -> bool>,
}

impl DragDropController {
  fn new(handler: Box<dyn Fn(DragDropEvent) -> bool>) -> Self {
    Self {
      handler,
      paths: UnsafeCell::new(None),
      state: Cell::new(DragControllerState::Left),
      position: Cell::new((0, 0)),
    }
  }

  fn store_paths(&self, paths: Vec<PathBuf>) {
    unsafe { *self.paths.get() = Some(paths) };
  }

  fn take_paths(&self) -> Option<Vec<PathBuf>> {
    unsafe { &mut *self.paths.get() }.take()
  }

  fn store_position(&self, position: (i32, i32)) {
    self.position.replace(position);
  }

  fn enter(&self) {
    self.state.set(DragControllerState::Entered);
  }

  fn leaving(&self) {
    self.state.set(DragControllerState::Leaving);
  }

  fn leave(&self) {
    self.state.set(DragControllerState::Left);
  }

  fn state(&self) -> DragControllerState {
    self.state.get()
  }

  fn call(&self, event: DragDropEvent) -> bool {
    (self.handler)(event)
  }
}

pub(crate) fn connect_drag_event(webview: &WebView, handler: Box<dyn Fn(DragDropEvent) -> bool>) {
  let controller = Rc::new(DragDropController::new(handler));

  {
    let controller = controller.clone();
    webview.connect_drag_data_received(move |_, _, _, _, data, info, _| {
      if info == 2 {
        let uris = data.uris();
        let paths = uris.iter().map(path_buf_from_uri).collect::<Vec<_>>();
        controller.enter();
        controller.call(DragDropEvent::Enter {
          paths: paths.clone(),
          position: controller.position.get(),
        });
        controller.store_paths(paths);
      }
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_motion(move |_, _, x, y, _| {
      if controller.state() == DragControllerState::Entered {
        controller.call(DragDropEvent::Over { position: (x, y) });
      } else {
        controller.store_position((x, y));
      }
      false
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_drop(move |_, ctx, x, y, time| {
      if controller.state() == DragControllerState::Leaving {
        if let Some(paths) = controller.take_paths() {
          ctx.drop_finish(true, time);
          controller.leave();
          return controller.call(DragDropEvent::Drop {
            paths,
            position: (x, y),
          });
        }
      }

      false
    });
  }

  webview.connect_drag_leave(move |_w, _, _| {
    if controller.state() != DragControllerState::Left {
      controller.leaving();
      let controller = controller.clone();
      gtk::glib::idle_add_local_once(move || {
        if controller.state() == DragControllerState::Leaving {
          controller.leave();
          controller.call(DragDropEvent::Leave);
        }
      });
    }
  });
}

fn path_buf_from_uri(gstr: &GString) -> PathBuf {
  let path = gstr.as_str();
  let path = path.strip_prefix("file://").unwrap_or(path);
  let path = percent_encoding::percent_decode(path.as_bytes())
    .decode_utf8_lossy()
    .to_string();
  PathBuf::from(path)
}
