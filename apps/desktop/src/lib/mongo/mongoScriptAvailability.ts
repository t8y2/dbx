import { readonly, ref, type Ref } from "vue";
import * as api from "@/lib/backend/api";

const available = ref(false);
let requested = false;

/**
 * Whether the backend build can run MongoDB scripts (the runtime is compiled only on
 * supported targets). Asked once; stays false when the backend cannot be reached.
 */
export function useMongoScriptAvailable(): Readonly<Ref<boolean>> {
  if (!requested) {
    requested = true;
    const retryLater = () => {
      requested = false;
    };
    try {
      Promise.resolve(api.mongoScriptAvailable())
        .then((value) => {
          available.value = value === true;
        })
        .catch(retryLater);
    } catch {
      retryLater();
    }
  }
  return readonly(available);
}
