import type { Connect, Plugin } from "vite";

export function publicBasePathRedirectLocation(requestUrl: string | undefined, publicBasePath: string): string | null {
  if (!requestUrl || !publicBasePath || publicBasePath === "/") return null;

  const queryStart = requestUrl.indexOf("?");
  const requestPath = queryStart >= 0 ? requestUrl.slice(0, queryStart) : requestUrl;
  if (requestPath !== publicBasePath) return null;

  const query = queryStart >= 0 ? requestUrl.slice(queryStart) : "";
  return `${publicBasePath}/${query}`;
}

export function publicBasePathRedirectMiddleware(publicBasePath: string): Connect.NextHandleFunction {
  return (request, response, next) => {
    const location = publicBasePathRedirectLocation(request.url, publicBasePath);
    if (!location) {
      next();
      return;
    }

    response.statusCode = 308;
    response.setHeader("Location", location);
    response.end();
  };
}

export function publicBasePathRedirectPlugin(publicBasePath: string): Plugin {
  return {
    name: "dbx-public-base-path-redirect",
    configureServer(server) {
      server.middlewares.use(publicBasePathRedirectMiddleware(publicBasePath));
    },
  };
}
