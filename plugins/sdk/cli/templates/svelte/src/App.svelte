<script>
  let context = $state({});
  let message = $state("Waiting for DBX plugin host…");

  const copy = {
    en: { eyebrow: "DBX Svelte plugin", description: "A Svelte-powered sandboxed workbench.", action: "Show host context", ready: "Ready" },
    zh: { eyebrow: "DBX Svelte 插件", description: "由 Svelte 驱动的沙箱工作台。", action: "查看宿主上下文", ready: "已就绪" },
  };
  let text = $state(copy.en);

  $effect(() => {
    window.dbxPlugin.ready.then((value) => {
      context = value || {};
      text = window.dbxPlugin.locale.toLowerCase().startsWith("zh") ? copy.zh : copy.en;
      message = text.ready;
    });
  });

  async function showContext() {
    context = await window.dbxPlugin.request("host.getContext");
    message = JSON.stringify(context, null, 2);
  }
</script>

<svelte:head><title>{{PLUGIN_NAME_HTML}}</title></svelte:head>

<main>
  <div class="eyebrow">{text.eyebrow}</div>
  <h1>{{PLUGIN_NAME_HTML}}</h1>
  <p>{text.description}</p>
  <button type="button" onclick={showContext}>{text.action}</button>
  <pre>{message}</pre>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: CanvasText; background: Canvas; }
  main { min-height: 100vh; padding: clamp(24px, 6vw, 72px); background: radial-gradient(circle at top left, rgba(109, 93, 252, .2), transparent 42%), Canvas; }
  .eyebrow { color: #6d5dfc; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 12px 0 8px; font-size: clamp(30px, 5vw, 54px); }
  p { max-width: 620px; opacity: .72; line-height: 1.6; }
  button { margin-top: 16px; border: 0; border-radius: 10px; padding: 11px 16px; color: white; background: #6d5dfc; font: inherit; cursor: pointer; }
  pre { max-width: 760px; min-height: 70px; margin-top: 20px; padding: 14px; overflow: auto; border-radius: 10px; background: color-mix(in srgb, CanvasText 8%, transparent); }
</style>
