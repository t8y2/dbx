import { expect, test, vi } from "vitest";
import { publicBasePathRedirectMiddleware } from "../../apps/desktop/vitePublicBasePathRedirect";

type RedirectMiddleware = ReturnType<typeof publicBasePathRedirectMiddleware>;

function runMiddleware(requestUrl: string, publicBasePath = "/dbx") {
  const middleware = publicBasePathRedirectMiddleware(publicBasePath);
  const request = { url: requestUrl } as Parameters<RedirectMiddleware>[0];
  const response = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  const next = vi.fn();

  middleware(request, response as unknown as Parameters<RedirectMiddleware>[1], next);
  return { next, response };
}

test("redirects the exact bare public base path and preserves its query", () => {
  for (const [requestUrl, expectedLocation] of [
    ["/dbx", "/dbx/"],
    ["/dbx?next=%2Fworkspace&theme=dark", "/dbx/?next=%2Fworkspace&theme=dark"],
  ]) {
    const { next, response } = runMiddleware(requestUrl);

    expect(response.statusCode).toBe(308);
    expect(response.setHeader).toHaveBeenCalledWith("Location", expectedLocation);
    expect(response.end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  }
});

test("passes root, trailing slash, static assets, API routes, and root deployments through", () => {
  for (const requestUrl of ["/", "/dbx/", "/dbx/favicon.png", "/dbx/api/probe?value=1"]) {
    const { next, response } = runMiddleware(requestUrl);

    expect(next).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(200);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  }

  const { next, response } = runMiddleware("/", "/");
  expect(next).toHaveBeenCalledOnce();
  expect(response.statusCode).toBe(200);
  expect(response.end).not.toHaveBeenCalled();
});
