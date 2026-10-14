use std::collections::HashMap;

#[derive(Clone, Copy)]
pub struct WindowHitBox {
    pub handle: isize,
    pub visible: bool,
    pub minimized: bool,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

pub fn topmost_workspace_window_at(
    point: (i32, i32),
    windows_in_z_order: &[WindowHitBox],
    workspace_labels: &HashMap<isize, String>,
    preview_handle: Option<isize>,
) -> Option<String> {
    for window in windows_in_z_order {
        if !window.visible
            || window.minimized
            || point.0 < window.left
            || point.1 < window.top
            || point.0 >= window.right
            || point.1 >= window.bottom
        {
            continue;
        }
        if Some(window.handle) == preview_handle {
            continue;
        }
        // A non-DBX topmost window obscures every workspace window below it.
        return workspace_labels.get(&window.handle).cloned();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{topmost_workspace_window_at, WindowHitBox};
    use std::collections::HashMap;

    #[test]
    fn actual_z_order_wins_even_when_an_underlying_window_is_focused() {
        let point = (40, 50);
        let labels = HashMap::from([(1, "main".to_string()), (2, "dbx-tab-child".to_string())]);
        let windows = [
            WindowHitBox { handle: 2, visible: true, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
            WindowHitBox { handle: 1, visible: true, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
        ];

        assert_eq!(topmost_workspace_window_at(point, &windows, &labels, None), Some("dbx-tab-child".into()));
    }

    #[test]
    fn preview_is_ignored_but_other_topmost_windows_block_hit_testing() {
        let point = (40, 50);
        let labels = HashMap::from([(2, "dbx-tab-child".to_string())]);
        let preview_and_child = [
            WindowHitBox { handle: 9, visible: true, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
            WindowHitBox { handle: 2, visible: true, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
        ];
        assert_eq!(
            topmost_workspace_window_at(point, &preview_and_child, &labels, Some(9)),
            Some("dbx-tab-child".into())
        );

        let plugin_and_child = [
            WindowHitBox { handle: 8, visible: true, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
            WindowHitBox { handle: 2, visible: true, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
        ];
        assert_eq!(topmost_workspace_window_at(point, &plugin_and_child, &labels, Some(9)), None);
    }

    #[test]
    fn hit_testing_ignores_invisible_minimized_and_out_of_bounds_windows() {
        let point = (40, 50);
        let labels = HashMap::from([(1, "main".to_string())]);
        let windows = [
            WindowHitBox { handle: 3, visible: false, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
            WindowHitBox { handle: 4, visible: true, minimized: true, left: 0, top: 0, right: 100, bottom: 100 },
            WindowHitBox { handle: 5, visible: true, minimized: false, left: 100, top: 100, right: 200, bottom: 200 },
            WindowHitBox { handle: 1, visible: true, minimized: false, left: 0, top: 0, right: 100, bottom: 100 },
        ];

        assert_eq!(topmost_workspace_window_at(point, &windows, &labels, None), Some("main".into()));
    }
}
