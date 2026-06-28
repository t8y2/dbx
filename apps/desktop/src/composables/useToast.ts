import { ref, type Ref } from "vue";

type ToastState = {
  message: Ref<string>;
  visible: Ref<boolean>;
  timer: number;
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
  });

export function useToast() {
  function toast(msg: string, duration = 2000) {
    toastState.message.value = msg;
    toastState.visible.value = true;
    clearTimeout(toastState.timer);
    toastState.timer = window.setTimeout(() => {
      toastState.visible.value = false;
    }, duration);
  }

  return { message: toastState.message, visible: toastState.visible, toast };
}
