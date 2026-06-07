import { ref } from "vue";

const message = ref("");
const visible = ref(false);
let timer = 0;

export function useToast() {
  function toast(msg: string, duration = 2000) {
    message.value = msg;
    visible.value = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      visible.value = false;
    }, duration);
  }

  return { message, visible, toast };
}
