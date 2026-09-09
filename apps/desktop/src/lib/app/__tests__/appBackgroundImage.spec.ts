import { describe, expect, it } from "vitest";
import {
  BACKGROUND_IMAGE_FILE_EXTENSIONS,
  BACKGROUND_IMAGE_STORAGE_LIMIT_BYTES,
  BACKGROUND_IMAGE_SURFACE_VARS,
  backgroundImageFileExtension,
  backgroundImageStyle,
  backgroundImageSurfaceAlpha,
  defaultBackgroundImageSettings,
  normalizeBackgroundImageSettings,
  parseCssColorTriplet,
  surfaceColorWithAlpha,
} from "@/lib/app/appBackgroundImage";

describe("backgroundImageFileExtension", () => {
  it("extracts supported extensions case-insensitively", () => {
    expect(backgroundImageFileExtension("wallpaper.PNG")).toBe("png");
    expect(backgroundImageFileExtension("photo.Jpeg")).toBe("jpeg");
    expect(backgroundImageFileExtension("/path/to/image.webp")).toBe("webp");
  });

  it("returns null for unsupported or missing extensions", () => {
    expect(backgroundImageFileExtension("vector.svg")).toBeNull();
    expect(backgroundImageFileExtension("no-extension")).toBeNull();
    expect(backgroundImageFileExtension("")).toBeNull();
  });

  it("exposes the dialog filter extension list", () => {
    expect(BACKGROUND_IMAGE_FILE_EXTENSIONS).toContain("png");
    expect(BACKGROUND_IMAGE_FILE_EXTENSIONS).toContain("gif");
  });
});

describe("normalizeBackgroundImageSettings", () => {
  it("falls back to defaults for missing or invalid fields", () => {
    expect(normalizeBackgroundImageSettings(undefined)).toEqual(defaultBackgroundImageSettings());
    expect(normalizeBackgroundImageSettings(null)).toEqual(defaultBackgroundImageSettings());
    expect(normalizeBackgroundImageSettings({})).toEqual(defaultBackgroundImageSettings());
  });

  it("keeps valid values and clamps out-of-range numbers", () => {
    const settings = normalizeBackgroundImageSettings({
      filePath: "/data/background-image.png",
      fileName: "wall.png",
      opacity: 0.75,
      blur: 8,
      displayMode: "tile",
    });
    expect(settings).toEqual({ filePath: "/data/background-image.png", fileName: "wall.png", opacity: 0.75, blur: 8, displayMode: "tile" });

    const clamped = normalizeBackgroundImageSettings({ opacity: 5, blur: -3 });
    expect(clamped.opacity).toBe(1);
    expect(clamped.blur).toBe(0);

    const belowMin = normalizeBackgroundImageSettings({ opacity: 0.001, blur: 99 });
    expect(belowMin.opacity).toBe(0.05);
    expect(belowMin.blur).toBe(20);
  });

  it("falls back to the default display mode for unknown values", () => {
    expect(normalizeBackgroundImageSettings({ displayMode: "diagonal" }).displayMode).toBe("fill");
    expect(normalizeBackgroundImageSettings({ displayMode: 42 }).displayMode).toBe("fill");
    expect(normalizeBackgroundImageSettings({ displayMode: "tile" }).displayMode).toBe("tile");
  });

  it("treats blank or non-string paths as unset", () => {
    expect(normalizeBackgroundImageSettings({ filePath: "  " }).filePath).toBeNull();
    expect(normalizeBackgroundImageSettings({ filePath: 42 }).filePath).toBeNull();
    expect(normalizeBackgroundImageSettings({ fileName: "" }).fileName).toBeNull();
  });
});

describe("backgroundImageStyle", () => {
  const url = "blob:http://localhost/abc";

  it("emits nothing without an object URL", () => {
    expect(backgroundImageStyle({ displayMode: "fill", blur: 0 }, null)).toEqual({});
  });

  it("paints fill mode as cover by default", () => {
    expect(backgroundImageStyle({ displayMode: "fill", blur: 0 }, url)).toEqual({
      backgroundImage: `url("${url}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    });
    expect(backgroundImageStyle({ displayMode: "nonsense" as never, blur: 0 }, url).backgroundSize).toBe("cover");
  });

  it("maps the other display modes to their background properties", () => {
    expect(backgroundImageStyle({ displayMode: "fit", blur: 0 }, url)).toMatchObject({ backgroundSize: "contain", backgroundRepeat: "no-repeat" });
    expect(backgroundImageStyle({ displayMode: "stretch", blur: 0 }, url)).toMatchObject({ backgroundSize: "100% 100%" });
    expect(backgroundImageStyle({ displayMode: "center", blur: 0 }, url)).not.toHaveProperty("backgroundSize");
    expect(backgroundImageStyle({ displayMode: "tile", blur: 0 }, url)).toMatchObject({ backgroundRepeat: "repeat" });
  });

  it("adds blur and a slight scale to hide transparent blur edges", () => {
    expect(backgroundImageStyle({ displayMode: "fill", blur: 12 }, url)).toMatchObject({
      filter: "blur(12px)",
      transform: "scale(1.06)",
    });
  });
});

describe("backgroundImageSurfaceAlpha", () => {
  it("maps the surface-opacity setting 1:1 and clamps", () => {
    expect(backgroundImageSurfaceAlpha({ opacity: 0.8 })).toBe(0.8);
    expect(backgroundImageSurfaceAlpha({ opacity: 3 })).toBe(1);
    expect(backgroundImageSurfaceAlpha({ opacity: -1 })).toBe(0.05);
  });

  it("exposes the root surface variables that go translucent", () => {
    expect(BACKGROUND_IMAGE_SURFACE_VARS).toContain("--background");
    expect(BACKGROUND_IMAGE_SURFACE_VARS).toContain("--sidebar");
    expect(BACKGROUND_IMAGE_SURFACE_VARS).not.toContain("--card");
    expect(BACKGROUND_IMAGE_SURFACE_VARS).not.toContain("--popover");
  });
});

describe("parseCssColorTriplet", () => {
  it("parses rgb and hex forms, dropping any alpha", () => {
    expect(parseCssColorTriplet("rgb(17 18 20)")).toEqual([17, 18, 20]);
    expect(parseCssColorTriplet("rgb(17, 18, 20)")).toEqual([17, 18, 20]);
    expect(parseCssColorTriplet("rgb(17 18 20 / 0.8)")).toEqual([17, 18, 20]);
    expect(parseCssColorTriplet("#131416")).toEqual([19, 20, 22]);
    expect(parseCssColorTriplet("#fff")).toEqual([255, 255, 255]);
  });

  it("returns null for unparsable input", () => {
    expect(parseCssColorTriplet("")).toBeNull();
    expect(parseCssColorTriplet("red")).toBeNull();
    expect(parseCssColorTriplet("#12345")).toBeNull();
  });
});

describe("surfaceColorWithAlpha", () => {
  it("re-emits a color with the requested alpha", () => {
    expect(surfaceColorWithAlpha("rgb(19 20 22)", 0.8)).toBe("rgb(19 20 22 / 0.8)");
    expect(surfaceColorWithAlpha("#131416", 0.5)).toBe("rgb(19 20 22 / 0.5)");
    expect(surfaceColorWithAlpha("nope", 0.5)).toBeNull();
  });

  it("keeps wide-gamut and hsl notations instead of converting to rgb", () => {
    expect(surfaceColorWithAlpha("oklch(0.19 0.004 285)", 0.43)).toBe("oklch(0.19 0.004 285 / 0.43)");
    expect(surfaceColorWithAlpha("oklch(0.19 0.004 285 / 0.9)", 0.2)).toBe("oklch(0.19 0.004 285 / 0.2)");
    expect(surfaceColorWithAlpha("hsl(240 10% 3.9%)", 0.6)).toBe("hsl(240 10% 3.9% / 0.6)");
    expect(surfaceColorWithAlpha("hsl(240, 10%, 3.9%)", 0.6)).toBe("hsl(240, 10%, 3.9%, 0.6)");
    expect(surfaceColorWithAlpha("240 10% 3.9%", 0.6)).toBe("hsl(240 10% 3.9% / 0.6)");
  });
});

describe("BACKGROUND_IMAGE_STORAGE_LIMIT_BYTES", () => {
  it("is 20 MB", () => {
    expect(BACKGROUND_IMAGE_STORAGE_LIMIT_BYTES).toBe(20 * 1024 * 1024);
  });
});
