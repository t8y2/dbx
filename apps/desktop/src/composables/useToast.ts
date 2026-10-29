import { ref, type Ref } from "vue";

export type ToastAction = { label: string; onClick: () => void };
export type ToastOptions = { persistent: true };
export type PersistentToast = { id: number; message: string; action?: ToastAction };

type ToastState = {
  message: Ref<string>;
  visible: Ref<boolean>;
  timer: number;
  action: Ref<ToastAction | undefined>;
  persistentMessages: Ref<PersistentToast[]>;
  nextId: number;
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
    persistentMessages: ref<PersistentToast[]>([]),
    nextId: 1,
  });

// The global state can predate these fields when the module is hot-reloaded.
toastState.persistentMessages ??= ref<PersistentToast[]>([]);
toastState.nextId ??= 1;

export function useToast() {
  function toast(msg: string, duration: number | ToastOptions = 2000, action?: ToastAction) {
    if (typeof duration === "object" && duration.persistent) {
      toastState.persistentMessages.value.push({ id: toastState.nextId++, message: msg, action });
      return;
    }
    toastState.message.value = msg;
    toastState.action.value = action;
    toastState.visible.value = true;
    clearTimeout(toastState.timer);
    toastState.timer = window.setTimeout(
      () => {
        toastState.visible.value = false;
        toastState.action.value = undefined;
      },
      typeof duration === "number" ? duration : 2000,
    );
  }

  function dismissToast(id?: number) {
    if (id !== undefined) {
      toastState.persistentMessages.value = toastState.persistentMessages.value.filter((entry) => entry.id !== id);
      return;
    }
    clearTimeout(toastState.timer);
    toastState.visible.value = false;
    toastState.action.value = undefined;
  }

  return { message: toastState.message, visible: toastState.visible, action: toastState.action, persistentMessages: toastState.persistentMessages, toast, dismissToast };
}
