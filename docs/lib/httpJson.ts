function requestJsonWithXhr<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "json";
    xhr.setRequestHeader("Accept", "application/json");
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Request failed with status ${xhr.status}`));
        return;
      }

      resolve((xhr.response ?? JSON.parse(xhr.responseText)) as T);
    };
    xhr.onerror = () => reject(new Error("Request failed"));
    xhr.send();
  });
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  if (typeof fetch === "function") {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`Request failed with status ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  if (typeof XMLHttpRequest === "function") {
    return requestJsonWithXhr<T>(url);
  }

  throw new Error("No browser request API is available");
}
