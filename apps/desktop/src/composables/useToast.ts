import { ref, type Ref } from "vue";

export type ToastAction = { label: string; onClick: () => void };

type ToastState = {
  message: Ref<string>;
  visible: Ref<boolean>;
  timer: number;
  action: Ref<ToastAction | undefined>;
};

declare global {
  var __DBX_TOAST_STATE__: ToastState | undefined;
}

const toastState =
  globalThis.__DBX_TOAST_STATE__ ??
  (globalThis.__DBX_TOAST_STATE__ = {
    message: ref(""),
    visible: ref(false),
    timer: 0,
    action: ref<ToastAction | undefined>(undefined),
  });

export function useToast() {
  function toast(msg: string, duration = 2000, action?: ToastAction) {
    toastState.message.value = msg;
    toastState.action.value = action;
    toastState.visible.value = true;
    clearTimeout(toastState.timer);
    toastState.timer = window.setTimeout(() => {
      toastState.visible.value = false;
      toastState.action.value = undefined;
    }, duration);
  }

  function dismissToast() {
    toastState.visible.value = false;
    toastState.action.value = undefined;
  }

  return { message: toastState.message, visible: toastState.visible, action: toastState.action, toast, dismissToast };
}
